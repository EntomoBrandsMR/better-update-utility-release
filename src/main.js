const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const CURRENT_VERSION = '2.2.2';
const SERVICE_NAME = 'BUU2';
// v2.0.0: BUU 2.0 is a SEPARATE installed app from BUU Legacy. It must not share data with
// Legacy — different credentials store, checkpoints, logs, config. We force a distinct
// userData directory so the two installs are fully isolated and can run side by side.
// Set BEFORE app is ready (see app.setPath call near startup).
// v2.0.0: BUU 2.0 has its OWN update channel so it never cross-wires with Legacy. Legacy
// reads version.json (1.3.x line); BUU 2.0 reads version-buu2.json (2.x line). The two apps
// never see each other's updates.
const VERSION_URL = 'https://raw.githubusercontent.com/EntomoBrandsMR/better-update-utility-release/main/version-buu2.json';

let mainWindow;
// Map of runId -> { process, runId, profileId, logPath, startedAt, runnerLogStream, runnerPath, credPath }
// v1.3.4 Phase 3: cap is no longer a hard const of 1. It's a runtime ceiling that defaults to
// a hardware-derived suggestion (see computeHardwareCap) and can be overridden via config.
// The worker pool spawns up to this many concurrent workers. start-automation enforces it.
// Absolute safety ceiling regardless of config/hardware — prevents a typo'd config from
// trying to launch 10000 Chromiums. The hardware cap will almost always be lower.
// v2.1.0: raised 100->150. Stress test (#6) held 150 headless workers @ ~103MB each with
// 24GB free; the real binding limit is PestPac licenses (~131), not this machine.
const MAX_WORKERS_HARD_CEILING = 150;
// v1.3.4 Phase 3: estimate how many headless Chromium workers this machine can run.
// v2.1.0: re-derived from the stress test. Each headless worker measured ~103MB resident
// (not the old 600MB guess — that was 6x too conservative and capped us near 30). We budget
// ~150MB/worker for safety margin and use ~70% of free RAM so the machine stays responsive.
// Workers are IO-bound (waiting on PestPac network), so the CPU factor is generous. Returns >=1.
function computeHardwareCap() {
  try {
    const freeBytes = os.freemem();
    const cpus = (os.cpus() || []).length || 2;
    const perWorkerBytes = 150 * 1024 * 1024; // ~150MB per headless worker (measured ~103MB + margin)
    const byRam = Math.floor((freeBytes * 0.70) / perWorkerBytes);
    const byCpu = Math.max(1, Math.round(cpus * 6)); // ~6 workers/core; browser work is IO-bound, not CPU-bound
    const cap = Math.max(1, Math.min(byRam, byCpu, MAX_WORKERS_HARD_CEILING));
    return cap;
  } catch (e) {
    return 1; // safe fallback
  }
}
// The effective cap: config override if set and sane, else hardware suggestion.
function getMaxConcurrentRuns() {
  try {
    const cfg = readConfig();
    const override = cfg && parseInt(cfg.maxWorkers);
    if (override && override > 0) return Math.min(override, MAX_WORKERS_HARD_CEILING);
  } catch (e) {}
  return computeHardwareCap();
}

// ════════════════════════════════════════════════════════════════════════════
// v2.0.0 — ELASTIC POOL COORDINATOR (main-process owned)
// The coordinator owns a shared row queue per job and hands out batches to persistent
// worker processes on request. Workers don't own a row range; they pull batches until the
// queue is drained or they're told to retire. This enables elastic scaling (spawn/retire
// at batch boundaries based on license availability) and natural load-balancing.
//
// One coordinator instance per "pool run". A pool run can contain multiple JOBS (different
// flow+spreadsheet+profile); each job has its own row queue. Workers are assigned to a job.
// ════════════════════════════════════════════════════════════════════════════
const COORD = {
  active: false,
  batchSize: 10,
  jobs: new Map(),      // jobId -> { jobId, label, flowSteps, spreadsheetPath, profileId, setupFlowId, teardownFlowId, errHandle, totalRows, nextRow, rows, done, ok, err, skip, finished }
  workers: new Map(),   // workerId -> { workerId, jobId, process, status, batch, done, ok, err, skip, startedAt, runnerLogStream, runnerPath, credPath }
  desiredWorkers: 0,    // target worker count (license/hardware bounded)
  licenseTimer: null,
  poolId: null,         // v2.0.0 resume: id for this pool run's journal file
  journalStream: null,  // append-only results journal (one line per completed row)
  usedProfileIds: new Set(), // v2.1.1: profiles used this run — the logout sweep logs in with one
  sweepRunning: false,  // v2.1.1: guards against double-spawning the logout sweeper
  setupScope: 'per-worker', // v2.1.1 (#8): 'per-worker' | 'per-job' | 'global'
  startMode: 'run-all',     // v2.2.2 Session 2C: 'run-all' | 'step' | 'step-row'. Forces
                            // workers=1 batch=1 when 'step'/'step-row'. Transitions via
                            // pool-run-control(cmd:'run-all') unlock the configured worker count.
  startModeTarget: { workers: 1, batchSize: 10 }, // configured target; restored on Run-All transition.
};

// v2.0.0 resume: append-only journal. Path is per-pool-run so a fresh run never appends to
// an old one. Lives in userData (local, atomic small appends).
function coordJournalPath(poolId){ return path.join(app.getPath('userData'), `pool-journal-${poolId}.jsonl`); }
function coordJournalMetaPath(poolId){ return path.join(app.getPath('userData'), `pool-journal-${poolId}.meta.json`); }

// Open a fresh journal for a new pool run. Writes a meta sidecar describing the jobs so a
// resume can reconstruct queues without the renderer re-staging them.
function coordOpenJournal(){
  COORD.poolId = 'pool' + Date.now();
  try{
    // Meta: enough to rebuild each job (label, sheet, profile, flow, total). flowSteps included
    // so resume is fully self-contained even if the user changed the in-app flow since.
    // v2.2.2 Session 2F: also captures pool-level configuration (setupScope, startMode) and
    // per-job retry knobs (retryCount, breakerThreshold, retryRowIndexes, reauthIntervalMin)
    // so a resume restores the SAME runtime parameters the original run used. Also adds
    // phaseProgress so resume knows whether coordinator-driven setup already completed.
    const meta = {
      poolId: COORD.poolId,
      batchSize: COORD.batchSize,
      startedAt: new Date().toISOString(),
      setupScope: COORD.setupScope,
      startMode: COORD.startMode,
      startModeTarget: COORD.startModeTarget,
      // phaseProgress mirrors the single-runner v3 checkpoint shape. Only the coordinator
      // can write here; per-worker setup/teardown is repeated on each spawn so it doesn't
      // need persistence. Updated by coordMarkPhaseProgress() below.
      phaseProgress: { setupCompleted: false, teardownCompleted: false },
      jobs: Array.from(COORD.jobs.values()).map(j => ({
        jobId: j.jobId, label: j.label, spreadsheetPath: j.spreadsheetPath,
        profileId: j.profileId, setupFlowId: j.setupFlowId, teardownFlowId: j.teardownFlowId,
        errHandle: j.errHandle, totalRows: j.totalRows, flowSteps: j.flowSteps,
        // v2.2.2 Session 2E knobs (persisted for resume)
        retryCount: j.retryCount, breakerThreshold: j.breakerThreshold,
        retryRowIndexes: j.retryRowIndexes, reauthIntervalMin: j.reauthIntervalMin,
        startRow: j.startRow,
      })),
    };
    fs.writeFileSync(coordJournalMetaPath(COORD.poolId), JSON.stringify(meta));
    COORD.journalStream = fs.createWriteStream(coordJournalPath(COORD.poolId), { flags: 'a' });
  }catch(e){ console.error('[coord] could not open journal:', e.message); COORD.journalStream = null; }
}

// v2.2.2 Session 2F: update the meta sidecar's phaseProgress when a coordinator-driven
// setup/teardown completes. Read-modify-write is safe here because the coordinator is the
// only writer (workers don't touch the meta file).
function coordMarkPhaseProgress(field){
  if(!COORD.poolId) return;
  try{
    const p = coordJournalMetaPath(COORD.poolId);
    if(!fs.existsSync(p)) return;
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m.phaseProgress = m.phaseProgress || {};
    m.phaseProgress[field] = true;
    fs.writeFileSync(p, JSON.stringify(m));
  }catch(e){ /* best-effort */ }
}

// Append one completed-row record. Called on every row-result BEFORE updating counters, so
// the durable record always precedes the in-memory state. One short line; OS-atomic for small writes.
function coordJournalAppend(jobId, row, status){
  if(!COORD.journalStream) return;
  try{ COORD.journalStream.write(JSON.stringify({ j: jobId, r: row, s: status }) + '\n'); }catch(e){}
}

// v2.2.3 Session 3A (A3): append a dialog record to the journal. Separate from row records
// because dialogs can fire mid-step (multiple per row possible) and we want to keep the row
// record minimal. Discriminated by the `t` field; coordReadJournal needs to filter both.
function coordJournalAppendDialog(jobId, rowNum, message, dialogType, ts){
  if(!COORD.journalStream) return;
  try{ COORD.journalStream.write(JSON.stringify({ t:'dlg', j:jobId, r:rowNum, m:message, k:dialogType, ts:ts }) + '\n'); }catch(e){}
}

// Close + clean up the journal on clean pool completion (nothing to resume).
function coordCloseJournal(deleteFiles){
  try{ if(COORD.journalStream){ COORD.journalStream.end(); COORD.journalStream = null; } }catch(e){}
  if(deleteFiles && COORD.poolId){
    try{ fs.unlinkSync(coordJournalPath(COORD.poolId)); }catch(e){}
    try{ fs.unlinkSync(coordJournalMetaPath(COORD.poolId)); }catch(e){}
  }
}

// v2.0.2: path of the 'done' marker that flags a journal as completed (kept for the merged
// log / audit trail, but skipped by the resume scan so finished runs are not offered for resume).
function coordJournalDonePath(poolId){ return path.join(app.getPath('userData'), `pool-journal-${poolId}.done`); }
function coordMarkJournalDone(){
  if(!COORD.poolId) return;
  try{ fs.writeFileSync(coordJournalDonePath(COORD.poolId), new Date().toISOString()); }catch(e){}
}

// Scan userData for orphan pool journals (a pool run that didn't complete cleanly). Returns
// [{poolId, startedAt, jobs:[{label,total,completed,remaining}], totalRemaining}].
function coordFindOrphanPools(){
  const dir = app.getPath('userData');
  const out = [];
  let files; try{ files = fs.readdirSync(dir); }catch{ return out; }
  for(const f of files){
    const m = f.match(/^pool-journal-(pool\d+)\.meta\.json$/);
    if(!m) continue;
    const poolId = m[1];
    // v2.0.2: a journal flagged .done is a COMPLETED run kept for the merged log - never offer it for resume.
    try{ if(fs.existsSync(coordJournalDonePath(poolId))) continue; }catch(e){}
    try{
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // Count completed rows per job from the journal.
      const completedByJob = {};
      const jp = coordJournalPath(poolId);
      if(fs.existsSync(jp)){
        const lines = fs.readFileSync(jp, 'utf8').split('\n');
        // v2.2.3 Session 3A (A3): journal now mixes completion records {j,r,s} with dialog
        // records {t:'dlg',j,r,m,k,ts}. Only completion records (no `t` field) count toward
        // completedRows. Skip dialogs here so they don't mark uncompleted rows as done.
        for(const line of lines){ if(!line) continue; try{ const rec = JSON.parse(line); if(rec.t === 'dlg') continue; (completedByJob[rec.j] = completedByJob[rec.j] || new Set()).add(rec.r); }catch{} }
      }
      let totalRemaining = 0;
      const jobs = meta.jobs.map(j => {
        const completed = (completedByJob[j.jobId] || new Set()).size;
        const remaining = Math.max(0, j.totalRows - completed);
        totalRemaining += remaining;
        return { jobId: j.jobId, label: j.label, total: j.totalRows, completed, remaining };
      });
      // Only surface pools that actually have remaining work.
      if(totalRemaining > 0) out.push({ poolId, startedAt: meta.startedAt, jobs, totalRemaining });
      else { // fully done but never cleaned — remove the stale files
        try{ fs.unlinkSync(jp); }catch{} try{ fs.unlinkSync(path.join(dir, f)); }catch{}
      }
    }catch(e){}
  }
  out.sort((a,b)=>(b.startedAt||'').localeCompare(a.startedAt||''));
  return out;
}

// Count rows in a spreadsheet (sync, used at job submission to build the queue size).
function countRowsSync(spreadsheetPath){
  try{
    const probe = require('xlsx');
    const ext = path.extname(spreadsheetPath).toLowerCase();
    if (ext === '.csv') {
      return Math.max(0, fs.readFileSync(spreadsheetPath,'utf8').split('\n').filter(Boolean).length - 1);
    }
    const wb = probe.readFile(spreadsheetPath);
    return probe.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).length;
  }catch(e){ return 0; }
}

// Hand out the next batch of row indexes (1-based) for a job. Returns [] when drained.
// v2.0.0 resume: skips rows already in job.completedRows so a resumed pool doesn't redo them.
// v2.1.1: a per-job requeue (rows reclaimed from a gracefully-stopped worker) is drained FIRST,
// so rows a stopped worker never finished are picked up by another worker instead of being lost.
function coordNextBatch(jobId){
  const job = COORD.jobs.get(jobId);
  if(!job) return [];
  const batch = [];
  // Drain reclaimed rows first (skip any that have since completed).
  if(job.requeue && job.requeue.length){
    while(batch.length < COORD.batchSize && job.requeue.length){
      const r = job.requeue.shift();
      if(job.completedRows && job.completedRows.has(r)) continue;
      batch.push(r);
    }
  }
  while(batch.length < COORD.batchSize && job.nextRow <= job.totalRows){
    const r = job.nextRow;
    job.nextRow++;
    if(job.completedRows && job.completedRows.has(r)) continue; // already done in a prior run
    batch.push(r);
  }
  return batch;
}

// True when every job's queue is drained AND every worker has reported finished.
function coordAllDrained(){
  for(const job of COORD.jobs.values()){ if(job.nextRow <= job.totalRows) return false; if(job.requeue && job.requeue.length) return false; }
  return true;
}

// Broadcast aggregate pool status to the renderer.
function coordEmitStatus(){
  if(!mainWindow) return;
  const jobs = Array.from(COORD.jobs.values()).map(j => ({
    jobId: j.jobId, label: j.label, totalRows: j.totalRows,
    done: j.done, ok: j.ok, err: j.err, skip: j.skip,
    // v2.2.3 Session 3B (A5): distinctDone is the number of UNIQUE rows that have completed
    // (counted via the journal-backed completedRows set). j.done counts every row-result
    // emit including reclaim re-processes, so distinctDone is the trustworthy headline.
    // reclaimsTotal + reclaimsByReason expose the "+N re-processed" breakdown line.
    distinctDone: (j.completedRows ? j.completedRows.size : j.done),
    reclaimsTotal: j.reclaimsTotal || 0,
    reclaimsByReason: j.reclaimsByReason || { 'drain':0, 'user-stop':0, 'breaker':0, 'crash':0 },
    remaining: Math.max(0, j.totalRows - (j.nextRow - 1)), finished: j.finished,
  }));
  const workers = Array.from(COORD.workers.values()).map(w => ({
    workerId: w.workerId, jobId: w.jobId, status: w.status,
    done: w.done, ok: w.ok, err: w.err, skip: w.skip, batchSize: (w.batch||[]).length,
    // v2.1.0 live detail: current row, position in batch, step in flow, logout result
    currentRow: w.currentRow, batchPos: w.batchPos, batchTotal: w.batchSize,
    step: w.step, totalSteps: w.totalSteps, loggedOut: w.loggedOut,
  }));
  mainWindow.webContents.send('pool-status', {
    active: COORD.active, batchSize: COORD.batchSize,
    desiredWorkers: COORD.desiredWorkers, liveWorkers: COORD.workers.size,
    jobs, workers,
  });
}

// Pick a job that still has rows to hand out (round-robin-ish: first non-drained job).
// v2.2.1: a job with reclaimed rows in its requeue still has work even when nextRow has passed
// totalRows, so treat a non-empty requeue as "has rows" — otherwise reclaimed rows could strand
// when the last forward-progress worker has already drained and no worker gets spawned for them.
function coordPickJobForWorker(){
  for(const job of COORD.jobs.values()){
    const hasRequeue = job.requeue && job.requeue.length > 0;
    if(hasRequeue) return job.jobId;
    if(!job.finished && job.nextRow <= job.totalRows) return job.jobId;
  }
  return null;
}

// Spawn one persistent batch-pulling worker, assigned to a job. The worker logs in once,
// then pulls batches via stdin/stdout until told to drain/retire. Returns the workerId.
async function coordSpawnWorker(){
  const jobId = coordPickJobForWorker();
  if(!jobId){ return null; } // nothing left to work on
  const job = COORD.jobs.get(jobId);
  if(job && job.profileId) COORD.usedProfileIds.add(job.profileId); // v2.1.1: remember for the logout sweep
  const workerId = 'w' + Date.now() + '-' + Math.floor(Math.random()*1000);

  const chromiumExe = getBundledChromiumPath();
  if(!chromiumExe){ console.error('[coord] cannot spawn worker: chromium not found'); return null; }

  // Resolve setup/teardown step arrays for this job (same logic as single-run).
  // v2.1.1 (#8): only the per-worker scope has each worker run the once-flows. For 'per-job' and
  // 'global', the coordinator runs them ONCE (coordRunOnceFlows), so workers get empty arrays.
  const _runOwnOnce = (COORD.setupScope === 'per-worker');
  const setupSteps = (_runOwnOnce && job.setupFlowId) ? ((resolveOnceFlowByName(job.setupFlowId)||{}).steps || []) : [];
  const teardownSteps = (_runOwnOnce && job.teardownFlowId) ? ((resolveOnceFlowByName(job.teardownFlowId)||{}).steps || []) : [];

  // Credentials for this job's profile.
  const all = readAllProfiles();
  const prof = all.find(p => p.id === job.profileId) || {};
  if (keytar) {
    prof.companyKey = await keytar.getPassword(SERVICE_NAME, `${job.profileId}:companyKey`) || prof.companyKey || '';
    prof.username   = await keytar.getPassword(SERVICE_NAME, `${job.profileId}:username`)   || prof.username   || '';
    prof.password   = await keytar.getPassword(SERVICE_NAME, `${job.profileId}:password`)   || prof.password   || '';
  }
  const credPath = path.join(os.tmpdir(), `buu2-cred-${workerId}.enc`);
  fs.writeFileSync(credPath, encStore([prof]));

  const runnerPath = path.join(os.tmpdir(), `buu2-worker-${workerId}.js`);
  const logPath = path.join(getLogsDir(), `BUU2-log-${new Date().toISOString().slice(0,10)}-${workerId}.xlsx`);
  const runnerLogPath = path.join(getLogsDir(), `buu2-worker-${workerId}.log`);
  const runnerLogStream = fs.createWriteStream(runnerLogPath, { flags: 'a' });

  const script = buildPoolWorker({
    flowSteps: job.flowSteps,
    setupSteps, teardownSteps,
    spreadsheetPath: job.spreadsheetPath,
    logPath,
    chromiumExePath: chromiumExe,
    errHandle: job.errHandle || 'retry',
    selectorTimeout: 30, pageLoadMode: 'domcontentloaded',
    // v2.2.2 Session 2E: per-job runtime knobs forwarded to the worker template.
    // retryCount defaults to 2 (prior hardcode); breakerThreshold 0 means disabled;
    // retryRowIndexes null = process all rows; reauthIntervalMin 0 = no proactive re-auth.
    retryCount: Number.isFinite(job.retryCount) ? job.retryCount : 2,
    breakerThreshold: Number.isFinite(job.breakerThreshold) ? job.breakerThreshold : 0,
    retryRowIndexes: Array.isArray(job.retryRowIndexes) ? job.retryRowIndexes : null,
    reauthIntervalMin: Number.isFinite(job.reauthIntervalMin) ? job.reauthIntervalMin : 0,
    // v2.2.2 Session 2C: passing the pool-level startMode so the worker knows whether to
    // pause before each step (step), pause after each row (step-row), or just run (run-all).
    startMode: COORD.startMode || 'run-all',
    runContext: { runId: workerId, today: new Date().toISOString().slice(0,10), profileUsername: prof.username || '' },
  });
  fs.writeFileSync(runnerPath, script);

  const env = { ...process.env };
  const nodeModulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : path.join(__dirname, '..', 'node_modules');
  env.NODE_PATH = nodeModulesPath; env.BUU_NODE_MODULES = nodeModulesPath; env.ELECTRON_RUN_AS_NODE = '1';

  const entry = { workerId, jobId, process: null, status: 'starting', batch: [], done:0, ok:0, err:0, skip:0, startedAt: Date.now(), runnerLogStream, runnerPath, credPath, logPath };
  COORD.workers.set(workerId, entry);

  const proc = spawn(process.execPath, [runnerPath, job.spreadsheetPath, credPath], { stdio:['pipe','pipe','pipe'], env });
  entry.process = proc;

  proc.stderr.on('data', d => runnerLogStream.write(`[STDERR] ${String(d)}\n`));
  proc.stdout.on('data', d => {
    runnerLogStream.write(`[STDOUT] ${String(d)}\n`);
    String(d).split('\n').filter(Boolean).forEach(line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      coordHandleWorkerMessage(workerId, msg);
    });
  });
  proc.on('close', code => {
    runnerLogStream.write(`[${new Date().toISOString()}] worker exited code=${code}\n`);
    runnerLogStream.end();
    const w = COORD.workers.get(workerId);
    if(w){ w.status = (code===0?'done':'error'); }
    // v2.2.1 LOSSLESS RECLAIM (coordinator side, catch-all): reclaim BEFORE removing the worker.
    // This backstops the worker-side 'reclaim' message for cases where it never arrived — a crash,
    // a force-kill, or stdout closing before the message flushed. w.batch holds the full last batch
    // handed to this worker; any row in it not yet completed is pushed to the job's requeue so
    // another worker drains it. Idempotent with the 'reclaim' message (coordNextBatch and this both
    // skip completedRows; a row pushed twice is harmless — the second copy is skipped on drain).
    // Must run before COORD.workers.delete and before coordCheckComplete so completion sees the
    // requeue and stays blocked (coordAllDrained returns false while requeue is non-empty).
    if(w && w.jobId){
      const cjob = COORD.jobs.get(w.jobId);
      if(cjob && Array.isArray(w.batch) && w.batch.length){
        if(!cjob.requeue) cjob.requeue = [];
        // v2.2.3 Session 3B (A5): tally crash reclaims separately. Idempotent guard:
        // only count rows that weren't already requeued (e.g. by a worker-side 'reclaim'
        // message that did arrive). The set-of-already-requeued check avoids double-counting
        // when the worker emitted reclaim AND then the process closed.
        const alreadyRequeued = new Set(cjob.requeue);
        let crashCount = 0;
        for(const r of w.batch){
          if(cjob.completedRows && cjob.completedRows.has(r)) continue;
          if(alreadyRequeued.has(r)) continue;
          cjob.requeue.push(r);
          crashCount++;
        }
        if(crashCount > 0){
          if(!cjob.reclaimsByReason) cjob.reclaimsByReason = { 'drain':0, 'user-stop':0, 'breaker':0, 'crash':0 };
          cjob.reclaimsByReason.crash += crashCount;
          cjob.reclaimsTotal = (cjob.reclaimsTotal || 0) + crashCount;
        }
        if(cjob.requeue.length) cjob.finished = false;
      }
    }
    COORD.workers.delete(workerId);
    try { fs.unlinkSync(runnerPath); } catch {}
    try { fs.unlinkSync(credPath); } catch {}
    coordEmitStatus();
    // v2.2.1 LOSSLESS RECLAIM (stall guard): lazy reclaim relies on a live worker eventually
    // pulling the requeued rows. If THIS was the last worker and the pool is still active with
    // work outstanding (forward queue OR reclaimed requeue), nothing would pull it — the elastic
    // timer is minutes away and a non-elastic pool has no timer at all — so the pool would hang
    // with rows unprocessed. Spawn exactly one worker to drain the remainder. coordPickJobForWorker
    // is requeue-aware, so this also covers requeue-only-remaining. Not aggressive: only fires at
    // zero live workers, and only while there is genuinely work left.
    if(COORD.active && COORD.workers.size === 0 && coordPickJobForWorker()){
      coordSpawnWorker().catch(e => { try{ console.error('[coord] stall-guard respawn failed:', e.message); }catch(_){} });
    }
    coordCheckComplete();
  });

  coordEmitStatus();
  return workerId;
}

// Handle a message from a worker: request-batch, row-result, ready, phase events.
function coordHandleWorkerMessage(workerId, msg){
  const w = COORD.workers.get(workerId);
  if(!w) return;
  const job = COORD.jobs.get(w.jobId);
  switch(msg.type){
    case 'logging-in':
      w.status = 'logging-in';
      break;
    case 'ready':
      w.status = 'running';
      break;
    case 'row-start':
      // v2.1.0: live detail - which row, and position within the current batch (e.g. 3/10).
      w.status = 'running';
      w.currentRow = msg.row;
      w.batchPos = msg.batchPos; w.batchSize = msg.batchSize;
      w.step = 0; w.totalSteps = undefined;
      break;
    case 'step':
      // live detail - which step of the flow this row is on (e.g. 7/8).
      w.currentRow = msg.row; w.step = msg.step; w.totalSteps = msg.totalSteps;
      break;
    case 'pause-step':
      // v2.2.2 Session 2C: forward to renderer. Includes workerId so the renderer knows
      // which worker is paused (in step modes there's only one, but the field is there for
      // consistency with future multi-worker debug modes). step/preview/row come from worker.
      w.status = 'paused';
      if (mainWindow) mainWindow.webContents.send('pool-pause', {
        kind: 'step',
        workerId: workerId,
        jobId: w.jobId,
        row: msg.row,
        stepIndex: msg.stepIndex,
        totalSteps: msg.totalSteps,
        step: msg.step,
        mode: msg.mode || COORD.startMode,
      });
      break;
    case 'pause-row':
      // v2.2.2 Session 2C: emitted after a completed row in step-row mode. Renderer shows
      // the row's outcome and waits for the user to click Next-row or Run-All.
      w.status = 'paused';
      if (mainWindow) mainWindow.webContents.send('pool-pause', {
        kind: 'row',
        workerId: workerId,
        jobId: w.jobId,
        row: msg.row,
        mode: msg.mode || COORD.startMode,
      });
      break;
    case 'shutting-down':
      w.status = 'shutting-down';
      break;
    case 'dialog':
      // v2.2.3 Session 3A (A3): a dialog fired in this worker. Append a discriminated record
      // to the journal so post-run forensics can see "row N triggered this exact prompt".
      // Also forward to renderer for live display in the worker card.
      coordJournalAppendDialog(w.jobId, msg.row, msg.message, msg.dialogType, msg.ts);
      if (mainWindow) mainWindow.webContents.send('pool-dialog', {
        workerId: workerId,
        jobId: w.jobId,
        row: msg.row,
        message: msg.message,
        dialogType: msg.dialogType,
        ts: msg.ts,
      });
      break;
    case 'circuit-breaker':
      // v2.2.2 Session 2E: a worker tripped its breaker. Log it to coord console; the worker
      // is already draining itself + reclaiming the tail of its batch (so other workers in
      // the pool keep going on this job's remaining rows). Surface as a coord-side log so it
      // shows up in the pool status panel for the user.
      console.warn('[coord] worker '+workerId+' tripped circuit breaker after '+msg.consecutiveErrors+' consecutive errors (last ok row: '+msg.lastSuccessfulRow+')');
      w.breakerTripped = true;
      break;
    case 'logging-out':
      w.status = 'logging-out';
      break;
    case 'logged-out':
      w.loggedOut = !!msg.ok;
      break;
    case 'request-batch': {
      // Hand out the next batch for this worker's job. If the worker's job is drained,
      // try to reassign to another job that still has rows. If none, retire the worker.
      let batch = job ? coordNextBatch(w.jobId) : [];
      if(batch.length === 0){
        const otherJob = coordPickJobForWorker();
        if(otherJob){ w.jobId = otherJob; batch = coordNextBatch(otherJob); }
      }
      if(batch.length === 0){
        // Nothing left anywhere — tell the worker to finish (run teardown + logout + exit).
        try { w.process.stdin.write(JSON.stringify({ cmd:'drain' }) + '\n'); } catch {}
        w.status = 'draining';
      } else {
        w.batch = batch;
        try { w.process.stdin.write(JSON.stringify({ cmd:'batch', rows: batch }) + '\n'); } catch {}
        w.status = 'running';
      }
      break;
    }
    case 'row-result': {
      // v2.0.0 resume: journal FIRST (durable record precedes in-memory counters).
      coordJournalAppend(w.jobId, msg.row, msg.status);
      if(job && job.completedRows) job.completedRows.add(msg.row);
      w.done++; if(msg.status==='ok'||msg.status==='ok (retry)') w.ok++; else if(msg.status==='skip') w.skip++; else if(msg.status==='error') w.err++;
      if(job){ job.done++; if(msg.status==='ok'||msg.status==='ok (retry)') job.ok++; else if(msg.status==='skip') job.skip++; else if(msg.status==='error') job.err++; }
      // v2.2.0: collect read-field values into a per-job buffer for the dedicated results workbook.
      if(job && msg.reads && typeof msg.reads === 'object'){
        if(!job.readResults) job.readResults = [];
        if(!job.readColumns) job.readColumns = [];
        for(const cn of Object.keys(msg.reads)){ if(!job.readColumns.includes(cn)) job.readColumns.push(cn); }
        job.readResults.push({ row: msg.row, reads: msg.reads });
      }
      break;
    }
    case 'retired':
      // v2.1.0: worker finished its shutdown sequence (teardown+logout). Mark shut-down;
      // the process 'close' handler removes it from the map (-> 'gone' in the UI).
      w.status = 'shut-down';
      if(msg.loggedOut!=null) w.loggedOut = !!msg.loggedOut;
      break;
    case 'reclaim': {
      // v2.2.1 LOSSLESS RECLAIM (coordinator side, primary path): a draining worker handed back
      // the unstarted tail of its batch. Push those rows into the job's requeue so another worker
      // drains them (coordNextBatch drains requeue FIRST). Idempotent: skip any row already
      // completed. Clearing job.finished and the rows still being in requeue blocks completion
      // (coordAllDrained returns false while any requeue is non-empty), so the pool cannot report
      // "done" with rows outstanding — the exact silent-loss bug this fixes.
      // v2.2.3 Session 3B (A5): tally reclaims by reason for the counter display.
      // msg.reason is one of: 'drain' | 'user-stop' | 'breaker'. Old workers (pre-3B) won't
      // send a reason — default to 'drain' for back-compat.
      if(job && Array.isArray(msg.rows) && msg.rows.length){
        if(!job.requeue) job.requeue = [];
        const alreadyRequeued = new Set(job.requeue);
        let counted = 0;
        for(const r of msg.rows){
          if(job.completedRows && job.completedRows.has(r)) continue;
          if(alreadyRequeued.has(r)) continue;
          job.requeue.push(r);
          counted++;
        }
        if(counted > 0){
          const reason = (msg.reason === 'user-stop' || msg.reason === 'breaker' || msg.reason === 'drain') ? msg.reason : 'drain';
          if(!job.reclaimsByReason) job.reclaimsByReason = { 'drain':0, 'user-stop':0, 'breaker':0, 'crash':0 };
          job.reclaimsByReason[reason] += counted;
          job.reclaimsTotal = (job.reclaimsTotal || 0) + counted;
        }
        job.finished = false;
      }
      break;
    }
  }
  coordEmitStatus();
}

// Mark jobs finished when drained and emit completion when the whole pool is done.
function coordCheckComplete(){
  for(const job of COORD.jobs.values()){
    if(job.nextRow > job.totalRows) job.finished = true;
  }
  if(COORD.active && COORD.workers.size === 0 && coordAllDrained()){
    COORD.active = false;
    if(COORD.licenseTimer){ clearInterval(COORD.licenseTimer); COORD.licenseTimer = null; }
    // v2.0.2: clean completion KEEPS the journal (also the merged-log / audit trail).
    // Mark done with a sidecar so resume-scan skips it; merged log can still read it.
    coordMarkJournalDone();
    coordCloseJournal(false);
    if(mainWindow) mainWindow.webContents.send('pool-complete', {
      jobs: Array.from(COORD.jobs.values()).map(j => ({ jobId:j.jobId, label:j.label, totalRows:j.totalRows, ok:j.ok, err:j.err, skip:j.skip })),
    });
    // v2.1.1 (#8): for per-job/global scope, run teardown ONCE now (coordinator-driven), THEN
    // sweep. v2.1.1 logout sweep is the authoritative backstop and runs regardless of scope.
    (async () => {
      // v2.2.0: write any read-field results to dedicated per-job workbooks first.
      try { coordWriteReadResults(); } catch(e){ console.error('[coord] read-results write failed:', e.message); }
      if(COORD.setupScope !== 'per-worker'){
        if(mainWindow) mainWindow.webContents.send('pool-once-flow', { phase:'teardown', state:'phase-start', scope:COORD.setupScope });
        try { await coordRunOnceFlows('teardown'); coordMarkPhaseProgress('teardownCompleted'); } catch(e) { console.error('[coord] teardown once-flows error:', e.message); }
      }
      coordRunLogoutSweep('auto-complete');
    })();
  }
}

// v2.2.0: write read-field results to a dedicated workbook per job that captured any. Output goes
// to <userDocs>/upcoming/results/mmddyyyy_HHmm_<flowname>.xlsx — SEPARATE from the run log. Each
// row: the source row's key (OP ID / URL) plus one column per read-field name (label + raw code).
function coordWriteReadResults(){
  let XLSX; try { XLSX = require('xlsx'); } catch(e){ console.error('[coord] xlsx unavailable for read-results'); return; }
  for(const job of COORD.jobs.values()){
    if(!job.readResults || !job.readResults.length || !job.readColumns || !job.readColumns.length) continue;
    // Results folder lives next to the job's source spreadsheet (e.g. upcoming/results/).
    const RESULTS_DIR = path.join(path.dirname(job.spreadsheetPath || process.cwd()), 'results');
    // Build a row-index -> source row map so we can emit the OP ID / URL alongside read values.
    let srcRows = [];
    try { srcRows = loadRowsForJob(job.spreadsheetPath); } catch(e){ srcRows = []; }
    const cols = job.readColumns;
    const header = ['Row', 'OP ID', 'URL'];
    for(const c of cols){ header.push(c); header.push(c + ' (raw)'); }
    const aoa = [header];
    // Sort by row for a stable, readable sheet.
    const sorted = job.readResults.slice().sort((a,b)=>a.row-b.row);
    for(const rr of sorted){
      const src = srcRows[rr.row - 1] || {};
      const url = src.URL || src.url || '';
      let opp = src['OP ID'] || src['OP Id'] || src['Op id'] || '';
      if(!opp && url){ const m = String(url).match(/SalesOppID=(\d+)/i); if(m) opp = m[1]; }
      const line = [rr.row, opp, url];
      for(const c of cols){ const v = rr.reads[c] || {}; line.push(v.label!=null?v.label:(v.out||'')); line.push(v.value!=null?v.value:''); }
      aoa.push(line);
    }
    try {
      if(!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive:true });
      const now = new Date();
      const mm = String(now.getMonth()+1).padStart(2,'0');
      const dd = String(now.getDate()).padStart(2,'0');
      const yyyy = now.getFullYear();
      const hh = String(now.getHours()).padStart(2,'0');
      const mi = String(now.getMinutes()).padStart(2,'0');
      const safeFlow = String(job.label || 'flow').replace(/[\\/:*?"<>|]/g,'_').replace(/\.xlsx?$/i,'').slice(0,60);
      const fname = `${mm}${dd}${yyyy}_${hh}${mi}_${safeFlow}.xlsx`;
      const outPath = path.join(RESULTS_DIR, fname);
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, 'Read fields');
      XLSX.writeFile(wb, outPath);
      console.log('[coord] wrote read-field results:', outPath, '('+sorted.length+' rows)');
      if(mainWindow) mainWindow.webContents.send('pool-read-results', { path: outPath, rows: sorted.length, columns: cols });
    } catch(e){ console.error('[coord] failed writing read-results for job', job.label, e.message); }
  }
}

// Helper: load a job's source spreadsheet rows as objects (coordinator-side, for read-results).
function loadRowsForJob(spreadsheetPath){
  const XLSX = require('xlsx');
  const ext = path.extname(spreadsheetPath).toLowerCase();
  if(ext === '.csv'){
    const wb = XLSX.readFile(spreadsheetPath, { raw:false });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
  }
  const wb = XLSX.readFile(spreadsheetPath);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
}

// v1.3.4 Phase 3: license-aware cap. Launches a headless browser with the given profile,
async function coordRunLogoutSweep(reason){
  if(COORD.sweepRunning) return;
  COORD.sweepRunning = true;
  try{
    const chromiumExe = getBundledChromiumPath();
    if(!chromiumExe){ if(mainWindow) mainWindow.webContents.send('pool-sweep-result',{ok:false,error:'chromium not found'}); COORD.sweepRunning=false; return; }
    // Pick a profile used this run (fall back to any job's profile).
    let profileId = Array.from(COORD.usedProfileIds)[0];
    if(!profileId){ const firstJob = Array.from(COORD.jobs.values())[0]; profileId = firstJob && firstJob.profileId; }
    if(!profileId){ if(mainWindow) mainWindow.webContents.send('pool-sweep-result',{ok:false,error:'no profile available for sweep'}); COORD.sweepRunning=false; return; }

    // Login steps: reuse the locked login portion of any job's flow (same as workers use).
    const anyJob = Array.from(COORD.jobs.values()).find(j => Array.isArray(j.flowSteps) && j.flowSteps.length) || {};
    const loginSteps = (anyJob.flowSteps || []).filter(s => s.locked || s.type === 'pestpac-login');

    // Resolve creds for that profile (keytar with profile fallback), mirror of coordSpawnWorker.
    const all = readAllProfiles();
    const prof = all.find(p => p.id === profileId) || {};
    if (keytar) {
      prof.companyKey = await keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
      prof.username   = await keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
      prof.password   = await keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
    }
    const sweepId = 'sweep' + Date.now();
    const credPath = path.join(os.tmpdir(), `buu2-sweep-${sweepId}.enc`);
    fs.writeFileSync(credPath, encStore([prof]));
    const runnerPath = path.join(os.tmpdir(), `buu2-sweep-${sweepId}.js`);
    fs.writeFileSync(runnerPath, buildLogoutSweeper({ chromiumExePath: chromiumExe, loginSteps, runContext: { runId: sweepId } }));

    const env = { ...process.env };
    const nodeModulesPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
      : path.join(__dirname, '..', 'node_modules');
    env.NODE_PATH = nodeModulesPath; env.BUU_NODE_MODULES = nodeModulesPath; env.ELECTRON_RUN_AS_NODE = '1';

    const sweepLogPath = path.join(getLogsDir(), `buu2-sweep-${sweepId}.log`);
    const sweepLog = fs.createWriteStream(sweepLogPath, { flags: 'a' });
    sweepLog.write(`[${new Date().toISOString()}] logout sweep start (reason=${reason}, profile=${profileId})\n`);
    if(mainWindow) mainWindow.webContents.send('pool-sweep-start', { reason });

    const proc = spawn(process.execPath, [runnerPath, credPath], { stdio:['ignore','pipe','pipe'], env });
    let lastResult = null;
    proc.stdout.on('data', d => {
      String(d).split('\n').filter(Boolean).forEach(line => {
        sweepLog.write(`[OUT] ${line}\n`);
        let msg; try{ msg = JSON.parse(line); }catch{ return; }
        if(msg.type === 'sweep-pass' || msg.type === 'sweep-done') lastResult = msg;
        if(mainWindow) mainWindow.webContents.send('pool-sweep-progress', msg);
      });
    });
    proc.stderr.on('data', d => sweepLog.write(`[ERR] ${String(d)}\n`));
    proc.on('close', code => {
      sweepLog.write(`[${new Date().toISOString()}] sweep exited code=${code}\n`); sweepLog.end();
      try { fs.unlinkSync(runnerPath); } catch {}
      try { fs.unlinkSync(credPath); } catch {}
      COORD.sweepRunning = false;
      const remaining = lastResult && lastResult.remaining != null ? lastResult.remaining : (code===0?0:null);
      if(mainWindow) mainWindow.webContents.send('pool-sweep-result', { ok: code===0, remaining, loggedOut: lastResult && lastResult.loggedOut });
    });
  }catch(e){
    COORD.sweepRunning = false;
    if(mainWindow) mainWindow.webContents.send('pool-sweep-result',{ ok:false, error:e.message });
  }
}

let keytar = null;
try { keytar = require('keytar'); } catch(e) {}

// ── PATHS ─────────────────────────────────────────────────────────────────────
function getLogsDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getFlowsDir() {
  const dir = path.join(app.getPath('userData'), 'flows');
  const fresh = !fs.existsSync(dir);
  if (fresh) fs.mkdirSync(dir, { recursive: true });
  // v2.0.0: one-time migration of Legacy's saved flows into BUU 2.0 (copy, not share).
  // Runs once — guarded by a .migrated marker — so after the copy the two apps stay fully
  // independent (editing a flow in 2.0 never touches Legacy's, and vice versa).
  migrateLegacyFlowsOnce(dir);
  return dir;
}

// Copy Legacy's flow .json files into BUU 2.0's flows dir, exactly once. No-op for the Legacy
// build itself (its source dir == its dest dir). Marker file prevents re-copying so the user's
// own deletions/edits in 2.0 are never undone by a later launch.
function migrateLegacyFlowsOnce(destDir) {
  try {
    const marker = path.join(destDir, '.legacy-flows-migrated');
    if (fs.existsSync(marker)) return; // already migrated
    // Legacy's userData lives next to ours under %APPDATA% (roaming). Resolve its flows dir.
    const appData = app.getPath('appData'); // %APPDATA% (Roaming) — parent of all app userData dirs
    const legacyFlows = path.join(appData, 'better-update-utility', 'flows');
    // Guard: if this IS the Legacy app (same path), don't copy onto itself.
    if (path.normalize(legacyFlows) === path.normalize(destDir)) { return; }
    if (!fs.existsSync(legacyFlows)) {
      // No Legacy flows to copy (fresh machine, or Legacy never installed). Still drop the
      // marker so we don't re-scan every launch.
      fs.writeFileSync(marker, new Date().toISOString());
      return;
    }
    let copied = 0;
    for (const f of fs.readdirSync(legacyFlows)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const src = path.join(legacyFlows, f);
      const dst = path.join(destDir, f);
      try {
        if (!fs.existsSync(dst)) { fs.copyFileSync(src, dst); copied++; }
      } catch (e) { /* skip a single bad file, keep going */ }
    }
    fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), copied, from: legacyFlows }));
    console.log(`[migrate] copied ${copied} Legacy flow(s) into BUU 2.0`);
  } catch (e) {
    console.error('[migrate] flow migration failed (non-fatal):', e.message);
  }
}
function getBrowsersDir() {
  const dir = path.join(app.getPath('userData'), 'browsers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── CREDENTIALS ───────────────────────────────────────────────────────────────
const CRED_KEY = crypto.scryptSync('better-update-utility-v1', 'buu-salt-2024', 32);
function credFilePath() { return path.join(app.getPath('userData'), 'credentials.enc'); }
function encStore(obj) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', CRED_KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), d: enc.toString('hex') });
}
function decStore(raw) {
  try {
    const { iv, d } = JSON.parse(raw);
    const dc = crypto.createDecipheriv('aes-256-cbc', CRED_KEY, Buffer.from(iv, 'hex'));
    return JSON.parse(Buffer.concat([dc.update(Buffer.from(d, 'hex')), dc.final()]).toString('utf8'));
  } catch { return []; }
}
function readAllProfiles() {
  const f = credFilePath();
  return fs.existsSync(f) ? decStore(fs.readFileSync(f, 'utf8')) : [];
}
function writeAllProfiles(arr) { fs.writeFileSync(credFilePath(), encStore(arr)); }

// ── PROFILE IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('list-profiles', async () => readAllProfiles().map(({ id, name, loginUrl, username }) => ({ id, name, loginUrl, username })));

ipcMain.handle('save-profile', async (_, profile) => {
  if (keytar) {
    await keytar.setPassword(SERVICE_NAME, `${profile.id}:companyKey`, profile.companyKey || '');
    await keytar.setPassword(SERVICE_NAME, `${profile.id}:username`,   profile.username   || '');
    await keytar.setPassword(SERVICE_NAME, `${profile.id}:password`,   profile.password   || '');
  }
  const all = readAllProfiles();
  const i = all.findIndex(p => p.id === profile.id);
  if (i >= 0) all[i] = profile; else all.push(profile);
  writeAllProfiles(all);
  return { ok: true };
});

ipcMain.handle('get-profile', async (_, id) => {
  const all = readAllProfiles();
  const p = all.find(x => x.id === id);
  if (!p) return null;
  if (keytar) {
    return {
      ...p,
      companyKey: await keytar.getPassword(SERVICE_NAME, `${id}:companyKey`) || p.companyKey || '',
      username:   await keytar.getPassword(SERVICE_NAME, `${id}:username`)   || p.username   || '',
      password:   await keytar.getPassword(SERVICE_NAME, `${id}:password`)   || p.password   || '',
    };
  }
  return p;
});

ipcMain.handle('delete-profile', async (_, id) => {
  if (keytar) {
    for (const k of ['companyKey', 'username', 'password'])
      await keytar.deletePassword(SERVICE_NAME, `${id}:${k}`).catch(() => {});
  }
  writeAllProfiles(readAllProfiles().filter(p => p.id !== id));
  return { ok: true };
});

// ── CONFIG ────────────────────────────────────────────────────────────────────
function getConfigPath() { return path.join(app.getPath('userData'), 'buu-config.json'); }
function readConfig() { try { return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')); } catch { return {}; } }
function writeConfig(obj) { fs.writeFileSync(getConfigPath(), JSON.stringify({ ...readConfig(), ...obj })); }
ipcMain.handle('get-config', () => readConfig());
ipcMain.handle('set-config', (_, obj) => { writeConfig(obj); return { ok: true }; });

// ── CHROMIUM ──────────────────────────────────────────────────────────────────
function getBundledChromiumPath() {
  // When packaged, Chromium is bundled in resources/chromium/
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'chromium', 'chrome.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  // Dev: check local chromium folder in project directory
  const localChromium = path.join(__dirname, '..', 'chromium', 'chrome.exe');
  if (fs.existsSync(localChromium)) return localChromium;

  // Dev fallback — find in ms-playwright default location
  const localAppData = process.env.LOCALAPPDATA || '';
  const playwrightDir = path.join(localAppData, 'ms-playwright');
  if (fs.existsSync(playwrightDir)) {
    const chromiumDirs = fs.readdirSync(playwrightDir).filter(d => d.startsWith('chromium-'));
    for (const dir of chromiumDirs) {
      const exePath = path.join(playwrightDir, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exePath)) return exePath;
    }
  }
  return null;
}

ipcMain.handle('check-chromium', async () => {
  const execPath = getBundledChromiumPath();
  const resourcesPath = process.resourcesPath || 'N/A';
  const isPackaged = app.isPackaged;
  return { installed: !!execPath, path: execPath, resourcesPath, isPackaged };
});

ipcMain.handle('install-chromium', async () => {
  // Not needed when bundled — kept for compatibility
  return { ok: true };
});

// v1.3.4 Phase 3: worker-pool sizing. Returns the hardware-derived cap, the current config
// override (if any), the effective cap, and the raw inputs so the UI can explain the number.
ipcMain.handle('get-worker-caps', async () => {
  let cfgOverride = null;
  try { const c = readConfig(); if (c && parseInt(c.maxWorkers) > 0) cfgOverride = parseInt(c.maxWorkers); } catch(e){}
  return {
    hardwareCap: computeHardwareCap(),
    configOverride: cfgOverride,
    effectiveCap: getMaxConcurrentRuns(),
    hardCeiling: MAX_WORKERS_HARD_CEILING,
    freeMemGB: Math.round(os.freemem() / (1024*1024*1024) * 10) / 10,
    totalMemGB: Math.round(os.totalmem() / (1024*1024*1024) * 10) / 10,
    cpuCount: (os.cpus() || []).length,
    runningWorkers: COORD.workers.size,
  };
});

// ════════════════════════════════════════════════════════════════════════════
// v2.2.2 — SHARED LOGIN HELPER (canonical, hardened, drift-proof)
// ────────────────────────────────────────────────────────────────────────────
// Single source of truth for "log into PestPac". Used in TWO contexts:
//   1. Main process directly (check-license-cap IPC handler) — calls
//      loginToPestPacInPage(page, creds) as a normal JS function.
//   2. Spawned child template runners (buildRunner, buildPoolWorker,
//      buildLogoutSweeper, buildOnceFlowRunner) — interpolate LOGIN_TO_PESTPAC_SRC
//      into the emitted JS so the same function is available in the child.
// LOGIN_TO_PESTPAC_SRC is the EXACT textual source of loginToPestPacInPage with
// the name `loginToPestPacInPage` rewritten to `loginToPestPac` for compatibility
// with the existing template call sites. Keep them in sync; they MUST never drift.
// (If you edit one and not the other, you'll reintroduce the exact class of bug
// that v2.2.1 had to fix: the sweeper's login was missed when the worker's was
// updated. That's why this is a single string derived from a single function.)
// The hardened body includes the `LoginForm-loginBtn` triple-fallback that the
// sweeper/once-flow templates carried; the previous buildRunner/buildPoolWorker
// copies were missing this fallback. Now ALL five call sites get it.
// ════════════════════════════════════════════════════════════════════════════
async function loginToPestPacInPage(page, creds){
  await page.goto(creds.loginUrl||'https://login.pestpac.com/',{waitUntil:'load',timeout:30000});
  await page.waitForSelector('input[name="uid"]',{timeout:15000});
  await page.fill('input[name="uid"]',creds.companyKey||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{force:true}); }
  await page.waitForSelector('input[name="username"]',{timeout:15000});
  await page.fill('input[name="username"]',creds.username||'');
  await page.fill('input[name="password"]',creds.password||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="loginBtn"]',{timeout:15000}); }
  catch(e){ try{ await page.click('button[data-testid="loginBtn"]',{force:true,timeout:8000}); }
            catch(_){ try{ await page.click('button[data-testid="LoginForm-loginBtn"]',{force:true,timeout:8000}); }catch(__){} } }
  await page.waitForSelector('a[href*="AutoLogin"]',{timeout:30000});
}
// String form used by spawned-child templates. Stays identical to loginToPestPacInPage
// except the function is named `loginToPestPac` (matching every existing call site in the
// four runner templates). If you edit loginToPestPacInPage above, update this too.
const LOGIN_TO_PESTPAC_SRC = `async function loginToPestPac(page, creds){
  await page.goto(creds.loginUrl||'https://login.pestpac.com/',{waitUntil:'load',timeout:30000});
  await page.waitForSelector('input[name="uid"]',{timeout:15000});
  await page.fill('input[name="uid"]',creds.companyKey||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{force:true}); }
  await page.waitForSelector('input[name="username"]',{timeout:15000});
  await page.fill('input[name="username"]',creds.username||'');
  await page.fill('input[name="password"]',creds.password||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="loginBtn"]',{timeout:15000}); }
  catch(e){ try{ await page.click('button[data-testid="loginBtn"]',{force:true,timeout:8000}); }
            catch(_){ try{ await page.click('button[data-testid="LoginForm-loginBtn"]',{force:true,timeout:8000}); }catch(__){} } }
  await page.waitForSelector('a[href*="AutoLogin"]',{timeout:30000});
}`;

// ════════════════════════════════════════════════════════════════════════════
// v2.2.2 (Session 2A) — SHARED RUNTIME HELPERS (drift-proof, template-interpolated)
// ────────────────────────────────────────────────────────────────────────────
// Each constant below is the canonical source of a helper that previously lived
// duplicated across multiple spawned-child templates (buildRunner / buildPoolWorker /
// buildLogoutSweeper / buildOnceFlowRunner). Each template now interpolates the
// constant via ${NAME} instead of carrying its own copy. Same pattern as
// LOGIN_TO_PESTPAC_SRC above. Helpers chosen for extraction are the substantive
// shared ones (selector resolution, find-by-text); trivial one-liners like dec,
// emit, ms intentionally remain inline — extracting them adds churn for no
// behavioral payoff and they don't drift in practice.
//
// REQUIRE_FN_SRC: module resolution from spawned-child context. Both buildRunner
// and buildPoolWorker declare _nm separately (it captures NODE_PATH at child
// startup); _require itself depends on _nm being in scope. Templates that use
// _require must also declare _nm before interpolating REQUIRE_FN_SRC.
//
// FIND_LOCATOR_FN_SRC: iframe-walking selector resolver. Used by every
// step-engine template that needs to interact with PestPac form pages, which
// render content inside iframes. Canonical version is buildRunner's
// pretty-printed form with the detailed "Frames searched: [...]" error message.
//
// FIND_LOCATOR_MINIMAL_SRC: sweeper-only variant. Deliberately stripped (no
// iframe walk) because the sweeper's only step types are login/logout, both of
// which live in the top frame. Kept separate so the iframe-walking version
// never gets used by mistake in a context that doesn't need it.
//
// MATCHES_TEXT_FN_SRC / FIND_IN_CONTAINER_FN_SRC / RESOLVE_STEP_LOCATOR_FN_SRC:
// the find-by-text scoping stack (v1.3.0 Item 1). Only used by templates with a
// full step engine (buildRunner, buildPoolWorker) — sweeper and once-flow runner
// don't reference them, so they don't get interpolated there.
// ════════════════════════════════════════════════════════════════════════════
const REQUIRE_FN_SRC = `function _require(mod){
  try{return require(mod);}catch(e){
    try{return require(path.join(_nm,mod));}catch(e2){
      throw new Error('Cannot find: '+mod+' (tried NODE_PATH: '+_nm+')');
    }
  }
}`;

const FIND_LOCATOR_FN_SRC = `async function findLocator(page, selector, opts){
  opts = opts || {};
  const timeoutMs = opts.timeout || 30000;
  const pollMs = 250;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // Top frame first (most common; cheapest path).
    try {
      const top = page.locator(selector);
      if (await top.count() > 0) return top;
    } catch (_) {}
    // Walk every iframe. page.frames() includes the main frame, so skip it.
    const main = page.mainFrame();
    for (const f of page.frames()) {
      if (f === main) continue;
      try {
        const inFrame = f.locator(selector);
        if (await inFrame.count() > 0) return inFrame;
      } catch (_) {
        // Cross-origin frames throw on access; skip silently.
      }
    }
    // Not found yet — wait briefly and re-scan.
    await new Promise(function(r){ setTimeout(r, pollMs); });
  }
  // Final attempt with detailed error so the user knows where to look.
  const frameInfo = page.frames().map(function(f){ return f.url() || '(blank)'; }).join(', ');
  throw new Error('Selector "' + selector + '" not found in any frame after ' + timeoutMs + 'ms. Frames searched: [' + frameInfo + ']');
}`;

// Sweeper variant: NO iframe walk. Sweeper only handles login (top-frame form)
// and logout (top-frame masthead link), so iframe walking is dead work and the
// stripped version avoids any timing risk of polling iframes that don't exist.
const FIND_LOCATOR_MINIMAL_SRC = `async function findLocator(page, selector, opts){
  if(selector && selector.startsWith('xpath=')) return page.locator(selector);
  return page.locator(selector);
}`;

const MATCHES_TEXT_FN_SRC = `function matchesText(haystack, needle, mode){
  var h = (haystack == null ? '' : String(haystack));
  var n = (needle == null ? '' : String(needle));
  switch(mode || 'contains'){
    case 'exact':       return h.trim() === n.trim();
    case 'starts':      return h.trim().indexOf(n.trim()) === 0;
    case 'ends':        { var ht = h.trim(), nt = n.trim(); return nt.length <= ht.length && ht.lastIndexOf(nt) === (ht.length - nt.length); }
    case 'contains-ci': return h.trim().toLowerCase().indexOf(n.trim().toLowerCase()) !== -1;
    case 'exact-ci':    return h.trim().toLowerCase() === n.trim().toLowerCase();
    case 'regex':
      try { return new RegExp(n).test(h); }
      catch(e){ throw new Error('Find-by-text regex invalid: ' + n + ' — ' + e.message); }
    case 'contains':
    default:            return h.trim().indexOf(n.trim()) !== -1;
  }
}`;

const FIND_IN_CONTAINER_FN_SRC = `async function findInContainer(page, containerSel, matchText, targetSel, mode, opts){
  opts = opts || {};
  var timeoutMs = opts.timeout || 30000;
  var pollMs = 250;
  var startedAt = Date.now();
  var lastSeenCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    var frames = [page.mainFrame()];
    for (var fi = 0; fi < page.frames().length; fi++) {
      if (page.frames()[fi] !== page.mainFrame()) frames.push(page.frames()[fi]);
    }
    var matched = [];
    for (var k = 0; k < frames.length; k++) {
      var f = frames[k];
      var containers;
      try { containers = f.locator(containerSel); } catch(e){ continue; }
      var count;
      try { count = await containers.count(); } catch(e){ continue; }
      for (var ci = 0; ci < count; ci++) {
        var txt = '';
        try { txt = await containers.nth(ci).innerText({timeout: 2000}); }
        catch(e){
          try { txt = await containers.nth(ci).textContent({timeout: 2000}) || ''; } catch(e2){ txt = ''; }
        }
        if (matchesText(txt, matchText, mode)) {
          matched.push({ frame: f, index: ci });
        }
      }
      lastSeenCount += count;
    }
    if (matched.length === 1) {
      var m = matched[0];
      var containerLoc = m.frame.locator(containerSel).nth(m.index);
      if (!targetSel) return containerLoc;
      return containerLoc.locator(targetSel);
    }
    if (matched.length > 1) {
      throw new Error('Find-by-text matched ' + matched.length + ' containers for "' + matchText + '" (mode: ' + (mode||'contains') + '). Expected exactly 1. Make the match text more specific or narrow the container selector — BUU will not guess which one.');
    }
    await new Promise(function(r){ setTimeout(r, pollMs); });
  }
  throw new Error('Find-by-text found no container matching "' + matchText + '" (mode: ' + (mode||'contains') + ') in selector "' + containerSel + '" after ' + timeoutMs + 'ms. Containers seen during scan: ' + lastSeenCount + '. Check the match text/column value and the container selector.');
}`;

const RESOLVE_STEP_LOCATOR_FN_SRC = `async function resolveStepLocator(page, step, resolveFn){
  if (step.findByText) {
    var matchResolved = resolveFn(step.matchText || '');
    return await findInContainer(page, step.containerSel || '', matchResolved, step.selector || '', step.matchMode || 'contains', {timeout: SELECTOR_TIMEOUT});
  }
  return await findLocator(page, step.selector, {timeout: SELECTOR_TIMEOUT});
}`;

// v2.2.2 Session 2D: network-aware retry + error classification, factored out of
// buildRunner so the pool worker template can interpolate them too. probeNetwork +
// waitForNetwork were v1.2.5 item 2.8 (TCP probe + bounded wait with backoff so a
// disconnected PestPac doesn't burn the retry budget on dead-network failures).
// classifyError + classifyPhase were v1.2.5 item 2.10 (error categorization for
// the per-row Excel log's forensic columns).
//
// Requirements at the call site (template must satisfy before interpolating):
//   - PROBE_NETWORK_FN_SRC and WAIT_FOR_NETWORK_FN_SRC: the spawned-child must
//     declare `const net = require('net');` at top. waitForNetwork references
//     `currentMode` for the user-stop sentinel — must be declared (pool worker
//     has it from Session 2C; legacy single-runner already has it).
//   - CLASSIFY_ERROR_FN_SRC / CLASSIFY_PHASE_FN_SRC: no external dependencies.
const PROBE_NETWORK_FN_SRC = `function probeNetwork(){
  return new Promise(function(resolve){
    const sock = net.connect({ host: 'app.pestpac.com', port: 443, timeout: 5000 });
    let done = false;
    const finish = function(ok){
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      resolve(ok);
    };
    sock.once('connect', function(){ finish(true); });
    sock.once('error', function(){ finish(false); });
    sock.once('timeout', function(){ finish(false); });
  });
}`;

const WAIT_FOR_NETWORK_FN_SRC = `async function waitForNetwork(){
  const startWait = Date.now();
  let attempt = 0;
  const backoffs = [5000, 10000, 30000, 60000];
  while (true) {
    if (await probeNetwork()) return Date.now() - startWait;
    const wait = backoffs[Math.min(attempt, backoffs.length - 1)];
    attempt++;
    emit({
      type: 'heartbeat',
      phase: 'waiting-for-internet',
      attempt: attempt,
      waitMs: wait,
      totalWaitedMs: Date.now() - startWait
    });
    await new Promise(function(r){ setTimeout(r, wait); });
    if (currentMode === 'stop') throw new Error('__STOP__');
  }
}`;

const CLASSIFY_ERROR_FN_SRC = `function classifyError(errMsg){
  const m = String(errMsg || '');
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(m)) return 'internet-down';
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNREFUSED|ECONNRESET/i.test(m)) return 'pestpac-down';
  if (/ERR_|net::/i.test(m)) return 'unknown-network';
  if (/waitForSelector.*Timeout|waiting for selector/i.test(m)) return 'selector';
  if (/Timeout|timed out|TimeoutError/i.test(m)) return 'timeout';
  if (/Assert failed|HTTP 4\\\\d\\\\d|status code 4\\\\d\\\\d/i.test(m)) return 'validation';
  return 'unknown';
}`;

const CLASSIFY_PHASE_FN_SRC = `function classifyPhase(errMsg){
  const m = String(errMsg || '');
  if (/waitForSelector|waiting for selector|timeout.*selector/i.test(m)) return 'pre-action';
  if (/Assert failed/i.test(m)) return 'post-action';
  if (/Navigation failed|page\\\\.goto/i.test(m)) return 'action';
  return 'action';
}`;

// v2.2.1: log a coordinator-side license-reader session OUT before closing its browser.
// RULE: any session that logs in counts as a consumed license for as long as it stays logged
// in — there are NO exempt sessions. The elastic recheck (coordLicenseScale) and the Auto
// button (check-license-cap) previously did browser.close() WITHOUT logging out, leaving a
// live PestPac session each time (browser.close() ends local Chromium, NOT the server session).
// The License Manager exposes logout as a plain link href="/default.asp?Mode=Logout", so the
// most reliable logout is to navigate there directly (no fragile click), then verify we land
// back on the login page. Best-effort + verified; never throws (callers still close the browser).
async function licenseReaderLogout(page){
  try{
    await page.goto('https://app.pestpac.com/default.asp?Mode=Logout',{waitUntil:'load',timeout:15000});
    // Confirm: a logged-out session lands on login (input[name="uid"]) or the login host.
    let out=false;
    try{ out = /login\.pestpac\.com/i.test(page.url()) || !!(await page.$('input[name="uid"]')); }catch(_){}
    if(!out){
      // Fallback: use the user-widget logout link in the masthead.
      try{ await page.click('a.logout',{timeout:5000}); await page.waitForTimeout(1200); }catch(_){}
      try{ await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'domcontentloaded',timeout:12000}); }catch(_){}
      try{ out = /login\.pestpac\.com/i.test(page.url()) || !!(await page.$('input[name="uid"]')); }catch(_){}
    }
    return out;
  }catch(e){ return false; }
}

// v1.3.4 Phase 3: license-aware cap. Launches a headless browser with the given profile,
// (free - buffer) as a suggested cap. buffer defaults to 10 so some licenses stay open.
// Returns { ok, freeLicenses, suggested, error }. Read-only — navigates and scrapes only.
ipcMain.handle('check-license-cap', async (_, { profileId, buffer }) => {
  const BUF = (buffer != null) ? Math.max(0, parseInt(buffer)) : 10;
  const chromiumExe = getBundledChromiumPath();
  if (!chromiumExe) return { ok: false, error: 'Chromium not found.' };
  const all = readAllProfiles();
  const prof = all.find(p => p.id === profileId) || {};
  if (keytar) {
    prof.companyKey = await keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
    prof.username   = await keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
    prof.password   = await keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
  }
  let browser;
  try {
    const { chromium } = require('playwright-core');
    browser = await chromium.launch({ headless: true, executablePath: chromiumExe, args: ['--disable-gpu','--disable-dev-shm-usage'] });
    const page = await (await browser.newContext()).newPage();
    // v2.2.2: login via the shared canonical helper. Behavior identical to the inline
    // sequence this replaces, including the v2.1.1a MUI-backdrop wait and force-click
    // fallback for both the company-key and credential buttons, plus the v2.2.2 third
    // fallback to button[data-testid="LoginForm-loginBtn"] that the inline copy here
    // was missing (the sweeper/once-flow templates had it; this didn't).
    await loginToPestPacInPage(page, { loginUrl: prof.loginUrl, companyKey: prof.companyKey, username: prof.username, password: prof.password });
    // Navigate to the license page and read the free-licenses cell.
    await page.goto('https://app.pestpac.com/license.asp?Mode=View', { waitUntil: 'load', timeout: 30000 });
    // v2.2.1: read the PestPac FREE-licenses value robustly. The page has MULTIPLE license
    // tables (PestPac, Mobile App, RouteOp), each with its own "Number of free ... licenses:"
    // row, AND a "Number of licenses:" (total) and "Number of used licenses:" row. The old
    // startsWith('number of free licenses') match was returning the wrong cell (used/total).
    // Fix: scan ONLY the PestPac panel (#div_PestPac), require the label to match EXACTLY
    // "number of free licenses:" (so it can't hit "used", the bare total, or Mobile/RouteOp),
    // and read that row's value cell.
    const freeText = await page.evaluate(() => {
      const scope = document.querySelector('#div_PestPac') || document;
      const tds = Array.from(scope.querySelectorAll('td'));
      for (const td of tds) {
        const label = (td.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (label === 'number of free licenses:' || label === 'number of free licenses') {
          const sib = td.nextElementSibling;
          if (sib) return (sib.textContent || '').trim();
        }
      }
      return null;
    });
    await licenseReaderLogout(page); // v2.2.1: a read session is still a consumed license — log out before closing.
    await browser.close();
    if (freeText == null) return { ok: false, error: 'Could not find "Number of free licenses" on the license page.' };
    const free = parseInt(String(freeText).replace(/[^0-9]/g, ''));
    if (isNaN(free)) return { ok: false, error: 'Free-licenses value was not a number: "' + freeText + '"' };
    const suggested = Math.max(1, free - BUF);
    return { ok: true, freeLicenses: free, buffer: BUF, suggested };
  } catch (e) {
    try { if (browser) await browser.close(); } catch(_){}
    return { ok: false, error: e.message };
  }
});

// ════════════════════════════════════════════════════════════════════════════
// v2.0.0 — POOL IPC HANDLERS (renderer drives the coordinator)
// ════════════════════════════════════════════════════════════════════════════

// Submit a job into the (not-yet-started) pool. Returns the jobId. Jobs are staged, then
// 'pool-start' spawns workers to drain them. flowSteps is the full allSteps array.
ipcMain.handle('pool-submit-job', async (_, { label, flowSteps, spreadsheetPath, profileId, setupFlowId, teardownFlowId, errHandle, resumeFromRow, retryCount, breakerThreshold, retryRowIndexes, reauthIntervalMin }) => {
  if (COORD.active) return { ok: false, error: 'Pool is already running. Stop it before staging new jobs.' };
  const total = countRowsSync(spreadsheetPath);
  if (total <= 0) return { ok: false, error: 'Could not read rows from ' + spreadsheetPath };
  const jobId = 'job' + Date.now() + '-' + Math.floor(Math.random()*1000);
  // v2.1.0 (#5) step-by-step -> pool handoff: if the user was stepping through this sheet in
  // the single-runner (manual) mode and switches to the pool, resumeFromRow carries the row
  // cursor over so the pool starts where the manual stepping left off instead of restarting
  // at row 1. Clamp to [1, total+1]; total+1 means "already past the end" (nothing to do).
  let startRow = parseInt(resumeFromRow);
  if (!Number.isFinite(startRow) || startRow < 1) startRow = 1;
  if (startRow > total + 1) startRow = total + 1;
  // v2.2.2 Session 2E: per-job runtime knobs, previously single-runner-only.
  // retryCount: bounded retries per row when errHandle='retry'. Default 2 matches the
  //   previous coordSpawnWorker hardcode.
  // breakerThreshold: stop the worker if this many consecutive rows fail. 0 = disabled.
  //   (Coordinator marks the job finished + drains the worker when it trips.)
  // retryRowIndexes: optional array of 1-based source row numbers — if set, the worker
  //   processes ONLY those rows (skips all others). Used for retry-failed mode.
  // reauthIntervalMin: optional re-auth interval in minutes; 0 = disabled.
  const _rc = parseInt(retryCount);
  const _bt = parseInt(breakerThreshold);
  const _ri = parseInt(reauthIntervalMin);
  const _retrySet = Array.isArray(retryRowIndexes)
    ? retryRowIndexes.map(n => parseInt(n)).filter(n => Number.isFinite(n) && n >= 1)
    : null;
  COORD.jobs.set(jobId, {
    jobId, label: label || path.basename(spreadsheetPath),
    flowSteps, spreadsheetPath, profileId,
    setupFlowId: setupFlowId || null, teardownFlowId: teardownFlowId || null,
    errHandle: errHandle || 'retry',
    totalRows: total, nextRow: startRow, startRow,
    // v2.2.2 Session 2E knobs (passed through to worker via coordSpawnWorker)
    retryCount: Number.isFinite(_rc) ? Math.max(0, _rc) : 2,
    breakerThreshold: Number.isFinite(_bt) ? Math.max(0, _bt) : 0,
    retryRowIndexes: _retrySet,
    reauthIntervalMin: Number.isFinite(_ri) ? Math.max(0, _ri) : 0,
    done: 0, ok: 0, err: 0, skip: 0, finished: false,
    // v2.2.3 Session 3B (A5): track distinct rows that have completed via a Set so the
    // headline counter is reclaim-aware (j.done includes reclaim re-completions and would
    // exceed totalRows; distinctDone == completedRows.size is the trustworthy number).
    // Resume re-seeds this from the journal in coordResumeFromJournal.
    completedRows: new Set(),
    // Reclaim tally for the breakdown line — incremented in the 'reclaim' case + the crash
    // catch-all in proc.on('close'). reclaimsByReason buckets by cause; reclaimsTotal is the
    // sum for the headline. Both reset on a fresh submit (resume doesn't persist these in
    // the journal meta today; tally restarts at zero on resume — documented in v2.2.3 doc).
    reclaimsTotal: 0,
    reclaimsByReason: { 'drain':0, 'user-stop':0, 'breaker':0, 'crash':0 },
  });
  coordEmitStatus();
  return { ok: true, jobId, totalRows: total, startRow };
});

// Remove a staged job (only when pool not running).
ipcMain.handle('pool-remove-job', async (_, { jobId }) => {
  if (COORD.active) return { ok: false, error: 'Cannot remove jobs while the pool is running.' };
  COORD.jobs.delete(jobId);
  coordEmitStatus();
  return { ok: true };
});

// Clear all staged jobs (only when pool not running).
ipcMain.handle('pool-clear-jobs', async () => {
  if (COORD.active) return { ok: false, error: 'Cannot clear jobs while the pool is running.' };
  COORD.jobs.clear();
  coordEmitStatus();
  return { ok: true };
});

// Start the pool: spawn up to `workerCount` workers to drain the staged jobs. Optionally
// enable the elastic license loop (recheck every intervalMin minutes, scale to free-buffer).
ipcMain.handle('pool-start', async (_, { workerCount, batchSize, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin, setupScope, startMode }) => {
  if (COORD.active) return { ok: false, error: 'Pool already running.' };
  if (COORD.jobs.size === 0) return { ok: false, error: 'No jobs staged.' };
  // v2.1.1 (#8): setup/teardown scope. 'per-worker' (default) keeps the proven behavior where
  // each worker runs the once-flows for its own session. 'per-job' / 'global' run them ONCE,
  // executed by the coordinator via a dedicated headless session, with workers skipping them.
  COORD.setupScope = (setupScope === 'per-job' || setupScope === 'global') ? setupScope : 'per-worker';
  // v2.2.2 Session 2C: startMode replaces the single-runner's start-mode dropdown. Step modes
  // FORCE workers=1 and batchSize=1 regardless of configured target — the configured target
  // is remembered in startModeTarget and restored when the user clicks Run-All mid-step
  // (handled by pool-run-control). This honors Matthew's Q1: step-by-step uses one worker;
  // after testing, automation respects the worker pool settings.
  COORD.startMode = (startMode === 'step' || startMode === 'step-row') ? startMode : 'run-all';
  const _cfgWorkers = parseInt(workerCount) || 1;
  const _cfgBatch = Math.max(1, Math.min(500, parseInt(batchSize) || 10));
  COORD.startModeTarget = { workers: _cfgWorkers, batchSize: _cfgBatch };
  if (COORD.startMode === 'step' || COORD.startMode === 'step-row') {
    COORD.batchSize = 1;
  } else {
    COORD.batchSize = _cfgBatch;
  }
  // Reset per-run job counters in case jobs were staged then this is a restart.
  // v2.1.0 (#5): reset nextRow to the job's startRow (the step-by-step handoff cursor), not a
  // hard 1 — otherwise switching from manual stepping to the pool would re-run completed rows.
  // startRow defaults to 1 for normal jobs, so existing behavior is unchanged.
  // v2.1.1 FIX: a fresh pool-start must CLEAR completedRows. Previously it preserved any existing
  // set (if(!completedRows)...), so a second run in the same app session — especially after a run
  // where every row skipped — saw all rows as "already done", handed out empty batches, and every
  // worker retired instantly ("workers appear then vanish, run stops"). Resume has its own path
  // (coordResumeFromJournal) that seeds completedRows deliberately; pool-start is always a fresh run.
  for (const job of COORD.jobs.values()) { job.nextRow = job.startRow || 1; job.done = 0; job.ok = 0; job.err = 0; job.skip = 0; job.finished = false; job.completedRows = new Set(); }
  COORD.active = true;
  coordOpenJournal();  // v2.0.0 resume: start the append-only journal for this run

  // v2.1.1 (#8): for 'per-job' / 'global' scope, run setup ONCE (coordinator-driven) before any
  // workers spawn. Awaited so workers never start processing rows before setup has completed.
  if(COORD.setupScope !== 'per-worker'){
    if(mainWindow) mainWindow.webContents.send('pool-once-flow', { phase:'setup', state:'phase-start', scope:COORD.setupScope });
    try { await coordRunOnceFlows('setup'); coordMarkPhaseProgress('setupCompleted'); } catch(e) { console.error('[coord] setup once-flows error:', e.message); }
  }

  const hwCap = computeHardwareCap();
  // v2.2.2 Session 2C: in step/step-row mode, force a single worker regardless of configured
  // count. The configured count is stored in COORD.startModeTarget and applied when the user
  // clicks Run-All mid-step (via pool-run-control).
  const _modeWorkerCount = (COORD.startMode === 'step' || COORD.startMode === 'step-row') ? 1 : (parseInt(workerCount) || 1);
  let target = Math.max(1, Math.min(_modeWorkerCount, MAX_WORKERS_HARD_CEILING, hwCap));
  COORD.desiredWorkers = target;

  // Spawn initial workers (bounded by total rows available — no point spawning idle workers).
  // v2.1.0 (#5): "available" accounts for the startRow handoff cursor and any pre-completed rows.
  let totalRemaining = 0; for (const j of COORD.jobs.values()) totalRemaining += Math.max(0, (j.totalRows - (j.nextRow - 1)) - (j.completedRows ? j.completedRows.size : 0));
  target = Math.min(target, Math.max(1, totalRemaining));
  for (let i = 0; i < target; i++) { await coordSpawnWorker(); }

  // Elastic license loop.
  if (elastic && licenseProfileId) {
    COORD.licenseTimer = setInterval(() => coordLicenseScale(licenseProfileId, licenseBuffer, hwCap), Math.max(1, parseInt(licenseIntervalMin) || 5) * 60 * 1000);
  }
  coordEmitStatus();
  return { ok: true, started: COORD.workers.size, desiredWorkers: COORD.desiredWorkers };
});

// Stop the pool: tell every worker to drain (clean — finishes current batch, runs teardown,
// logs out, exits). Force-kills any that don't exit within 2 minutes.
ipcMain.handle('pool-stop', async () => {
  if (!COORD.active) return { ok: true, stopped: 0 };
  if (COORD.licenseTimer) { clearInterval(COORD.licenseTimer); COORD.licenseTimer = null; }
  // Drain all jobs so any subsequent request-batch gets 'drain'.
  for (const job of COORD.jobs.values()) { job.nextRow = job.totalRows + 1; job.finished = true; }
  // Proactively send drain to idle/running workers.
  for (const w of COORD.workers.values()) {
    try { w.process.stdin.write(JSON.stringify({ cmd: 'drain' }) + '\n'); } catch {}
    w.status = 'draining';
  }
  // v2.1.0: force-kill backstop raised to 180s. With 90s page timeouts, a worker can need up
  // to ~90s to finish its current row + ~30s to log out. 180s guarantees clean logout first;
  // only workers still alive after that (genuinely hung) get killed.
  const _ids = Array.from(COORD.workers.keys());
  setTimeout(() => {
    for (const id of _ids) {
      const w = COORD.workers.get(id);
      if (w && w.process) { try { w.process.kill(); } catch {} }
    }
    // v2.1.1: after the force-kill window, sweep the License Manager for any BUU sessions left
    // behind by workers that were killed mid-logout (or had already crashed). This is the
    // guarantee layer — a killed process can't log itself out, so the coordinator does it.
    setTimeout(() => coordRunLogoutSweep('pool-stop'), 4000);
  }, 180000);
  coordEmitStatus();
  return { ok: true, stopped: COORD.workers.size };
});

// v2.2.2 Session 2C: pool step-by-step control channel. Routes renderer commands
// (next-step / next-row / run-all / stop) to the active pool worker's stdin. In step
// or step-row mode the pool is forced to 1 worker so there's exactly one target. On
// 'run-all', this transitions the pool out of step mode and scales up to the
// configured worker target stored in COORD.startModeTarget at pool-start.
ipcMain.handle('pool-run-control', async (_, { cmd }) => {
  if (!COORD.active) return { ok: false, error: 'Pool not running.' };
  if (!['next-step','next-row','run-all','stop','mode'].includes(cmd) && !(cmd && cmd.startsWith('mode:'))) {
    return { ok: false, error: 'Unknown command: ' + cmd };
  }
  // 'stop' here means user clicked Stop during a step pause. Treat it like pool-stop —
  // tell each worker to drain (workers honor it at the next decision point) AND release
  // any pending pause so the worker can reach the drain check.
  if (cmd === 'stop') {
    if (COORD.licenseTimer) { clearInterval(COORD.licenseTimer); COORD.licenseTimer = null; }
    for (const job of COORD.jobs.values()) { job.nextRow = job.totalRows + 1; job.finished = true; }
    for (const w of COORD.workers.values()) {
      try { w.process.stdin.write(JSON.stringify({ cmd:'stop' }) + '\n'); } catch {}
      try { w.process.stdin.write(JSON.stringify({ cmd:'drain' }) + '\n'); } catch {}
      w.status = 'draining';
    }
    coordEmitStatus();
    return { ok: true };
  }
  // 'run-all' transitions out of step mode. Switch coord state, restore configured batch
  // size, tell the live worker(s) to switch to run-all, then scale to configured target.
  if (cmd === 'run-all') {
    COORD.startMode = 'run-all';
    if (COORD.startModeTarget && COORD.startModeTarget.batchSize) {
      COORD.batchSize = COORD.startModeTarget.batchSize;
    }
    for (const w of COORD.workers.values()) {
      try { w.process.stdin.write(JSON.stringify({ cmd:'run-all' }) + '\n'); } catch {}
    }
    const tgt = (COORD.startModeTarget && COORD.startModeTarget.workers) || 1;
    const hwCap = computeHardwareCap();
    COORD.desiredWorkers = Math.max(1, Math.min(tgt, MAX_WORKERS_HARD_CEILING, hwCap));
    await coordScaleTo(COORD.desiredWorkers);
    coordEmitStatus();
    return { ok: true, desiredWorkers: COORD.desiredWorkers, batchSize: COORD.batchSize };
  }
  // 'next-step' / 'next-row' release the current pause without changing mode. Forward to
  // the live worker. In step modes there's exactly one worker, but if multiple are alive
  // (e.g. mid Run-All transition) we forward to all — only the one actually paused will
  // act on it.
  for (const w of COORD.workers.values()) {
    try { w.process.stdin.write(JSON.stringify({ cmd }) + '\n'); } catch {}
  }
  return { ok: true };
});

// v2.1.1: manual logout sweep — lets the user force a License-Manager cleanup at any time
// (e.g. they see stuck BUU sessions). Safe to call even when no pool is running.
ipcMain.handle('pool-logout-sweep', async () => {
  coordRunLogoutSweep('manual');
  return { ok: true, started: true };
});

// Set the worker target while running: spawn more, or mark surplus for retirement.
ipcMain.handle('pool-set-workers', async (_, { workerCount }) => {
  if (!COORD.active) return { ok: false, error: 'Pool not running.' };
  const hwCap = computeHardwareCap();
  const target = Math.max(0, Math.min(parseInt(workerCount) || 0, MAX_WORKERS_HARD_CEILING, hwCap));
  COORD.desiredWorkers = target;
  await coordScaleTo(target);
  return { ok: true, desiredWorkers: target, liveWorkers: COORD.workers.size };
});

// v2.1.1 (#6): gracefully stop ONE worker. The worker finishes its current row, runs teardown,
// VERIFIES logout, then exits — it is never force-killed here (that risks a stuck session, the
// exact thing the logout work prevents). Rows in its batch that it never reported are reclaimed
// into the job's requeue so another worker picks them up — nothing is lost. We also lower the
// desired-worker target by one so the elastic loop doesn't immediately respawn a replacement.
ipcMain.handle('pool-stop-worker', async (_, { workerId }) => {
  const w = COORD.workers.get(workerId);
  if (!w) return { ok: false, error: 'Worker not found (it may have already finished).' };
  if (w.stopping) return { ok: true, alreadyStopping: true };
  w.stopping = true;
  // Reclaim un-reported rows from this worker's current batch into the job's requeue.
  const job = COORD.jobs.get(w.jobId);
  if (job && Array.isArray(w.batch) && w.batch.length) {
    if (!job.requeue) job.requeue = [];
    for (const r of w.batch) {
      if (!(job.completedRows && job.completedRows.has(r))) job.requeue.push(r);
    }
    job.finished = false; // there is work to redo, so the job isn't finished
  }
  // Lower the target so a replacement isn't auto-spawned for this intentional stop.
  COORD.desiredWorkers = Math.max(0, COORD.desiredWorkers - 1);
  // Tell the worker to drain (finish current row -> teardown -> verified logout -> exit).
  try { w.process.stdin.write(JSON.stringify({ cmd: 'drain' }) + '\n'); } catch {}
  w.status = 'draining';
  coordEmitStatus();
  return { ok: true, workerId, requeued: (job && job.requeue ? job.requeue.length : 0) };
});

ipcMain.handle('pool-get-status', async () => {
  coordEmitStatus();
  return { active: COORD.active, liveWorkers: COORD.workers.size, desiredWorkers: COORD.desiredWorkers, jobs: COORD.jobs.size };
});

// v2.0.0 resume: list orphan pool runs (journal exists with remaining work).
ipcMain.handle('pool-find-orphans', async () => {
  return coordFindOrphanPools();
});

// v2.0.0 resume: rebuild the pool from an orphan journal and restart it. Reconstructs each
// job from the meta sidecar, loads the completed-row sets from the journal, then APPENDS to
// the SAME journal (so the resumed run keeps one continuous record).
ipcMain.handle('pool-resume', async (_, { poolId, workerCount, batchSize, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin }) => {
  if (COORD.active) return { ok: false, error: 'Pool already running.' };
  const metaPath = coordJournalMetaPath(poolId);
  const jp = coordJournalPath(poolId);
  if (!fs.existsSync(metaPath)) return { ok: false, error: 'Resume metadata not found for ' + poolId };
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch(e){ return { ok:false, error:'Could not read resume metadata: '+e.message }; }

  // Load completed rows per job from the journal.
  // v2.2.3 Session 3A (A3): journal now mixes completion records {j,r,s} with dialog records
  // {t:'dlg',j,r,m,k,ts}. Only completion records count toward completedRows on resume.
  const completedByJob = {};
  if (fs.existsSync(jp)) {
    const lines = fs.readFileSync(jp, 'utf8').split('\n');
    for (const line of lines){ if(!line) continue; try{ const rec=JSON.parse(line); if(rec.t === 'dlg') continue; (completedByJob[rec.j]=completedByJob[rec.j]||new Set()).add(rec.r); }catch{} }
  }

  // Rebuild COORD.jobs from meta, pre-seeding completedRows.
  // v2.2.2 Session 2F: also restores per-job retry knobs (Session 2E) so resume preserves the
  // SAME runtime config the original run used. Missing fields default to safe values (older
  // journals predating 2E/2F resume with retry=2/breaker=0/etc).
  COORD.jobs.clear();
  for (const j of meta.jobs){
    COORD.jobs.set(j.jobId, {
      jobId: j.jobId, label: j.label, flowSteps: j.flowSteps,
      spreadsheetPath: j.spreadsheetPath, profileId: j.profileId,
      setupFlowId: j.setupFlowId, teardownFlowId: j.teardownFlowId,
      errHandle: j.errHandle, totalRows: j.totalRows,
      // v2.2.2 Session 2F: restore Session 2E knobs from meta (defaults if missing).
      retryCount: Number.isFinite(j.retryCount) ? j.retryCount : 2,
      breakerThreshold: Number.isFinite(j.breakerThreshold) ? j.breakerThreshold : 0,
      retryRowIndexes: Array.isArray(j.retryRowIndexes) ? j.retryRowIndexes : null,
      reauthIntervalMin: Number.isFinite(j.reauthIntervalMin) ? j.reauthIntervalMin : 0,
      startRow: Number.isFinite(j.startRow) ? j.startRow : 1,
      nextRow: Number.isFinite(j.startRow) ? j.startRow : 1, done: 0, ok: 0, err: 0, skip: 0, finished: false,
      completedRows: completedByJob[j.jobId] || new Set(),
    });
  }
  // Seed counters from the completed sets so the UI shows real progress immediately.
  for (const job of COORD.jobs.values()){ job.done = job.completedRows.size; }

  // v2.2.2 Session 2F: restore pool-level configuration from meta (defaults preserve old behavior).
  COORD.setupScope = meta.setupScope || 'per-worker';
  COORD.startMode = meta.startMode || 'run-all';
  COORD.startModeTarget = meta.startModeTarget || { workers: 1, batchSize: meta.batchSize || 10 };
  COORD.batchSize = Math.max(1, Math.min(500, parseInt(batchSize) || meta.batchSize || 10));
  COORD.active = true;
  // Re-open the SAME journal in append mode (continue the continuous record).
  COORD.poolId = poolId;
  try { COORD.journalStream = fs.createWriteStream(jp, { flags: 'a' }); } catch(e){ COORD.journalStream = null; }

  // v2.2.2 Session 2F: respect phaseProgress from the meta. If coordinator-driven setup already
  // ran in the original session, skip it on resume. Teardown still runs at the end. Per-worker
  // scope is unaffected (each new worker runs its own setup/teardown by design).
  const _resumePhase = (meta.phaseProgress || {});
  if(COORD.setupScope !== 'per-worker' && !_resumePhase.setupCompleted){
    if(mainWindow) mainWindow.webContents.send('pool-once-flow', { phase:'setup', state:'phase-start', scope:COORD.setupScope });
    try { await coordRunOnceFlows('setup'); coordMarkPhaseProgress('setupCompleted'); } catch(e) { console.error('[coord] resume setup once-flows error:', e.message); }
  } else if(COORD.setupScope !== 'per-worker' && _resumePhase.setupCompleted){
    console.log('[coord] resume: skipping setup (already completed in original session)');
  }

  const hwCap = computeHardwareCap();
  let totalRemaining = 0; for (const j of COORD.jobs.values()) totalRemaining += Math.max(0, j.totalRows - j.completedRows.size);
  let target = Math.max(1, Math.min(parseInt(workerCount) || 1, MAX_WORKERS_HARD_CEILING, hwCap, Math.max(1, totalRemaining)));
  COORD.desiredWorkers = target;
  for (let i = 0; i < target; i++) { await coordSpawnWorker(); }

  if (elastic && licenseProfileId) {
    COORD.licenseTimer = setInterval(() => coordLicenseScale(licenseProfileId, licenseBuffer, hwCap), Math.max(1, parseInt(licenseIntervalMin) || 5) * 60 * 1000);
  }
  coordEmitStatus();
  return { ok: true, resumed: true, totalRemaining, started: COORD.workers.size };
});

// v2.0.0 resume: discard an orphan pool (delete its journal + meta).
ipcMain.handle('pool-discard-orphan', async (_, { poolId }) => {
  try { fs.unlinkSync(coordJournalPath(poolId)); } catch {}
  try { fs.unlinkSync(coordJournalMetaPath(poolId)); } catch {}
  return { ok: true };
});

// v2.0.0 merged log: read a pool journal (current run if poolId omitted) and return a merged,
// per-row record across ALL workers/jobs. This is the combined log the per-worker Excel files
// don't give you on their own. Returns { ok, poolId, jobs:[{jobId,label}], rows:[{job,row,status}], counts }.
// v2.0.2: find the most recent journal on disk (done OR active), for the merged-log fallback
// when no specific poolId is given and no pool is currently active.
function coordMostRecentJournalPoolId(){
  try{
    const dir = app.getPath('userData');
    const metas = fs.readdirSync(dir).filter(f => /^pool-journal-pool\d+\.meta\.json$/.test(f));
    let best=null, bestMtime=-1;
    for(const f of metas){
      const pid = f.replace(/^pool-journal-/, '').replace(/\.meta\.json$/, '');
      const jp = coordJournalPath(pid);
      if(!fs.existsSync(jp)) continue;
      const mt = fs.statSync(jp).mtimeMs;
      if(mt > bestMtime){ bestMtime = mt; best = pid; }
    }
    return best;
  }catch(e){ return null; }
}
ipcMain.handle('pool-read-journal', async (_, args) => {
  const poolId = (args && args.poolId) || COORD.poolId || coordMostRecentJournalPoolId();
  if (!poolId) return { ok: false, error: 'No pool run found.' };
  const jp = coordJournalPath(poolId);
  const metaPath = coordJournalMetaPath(poolId);
  if (!fs.existsSync(jp)) return { ok: false, error: 'Journal not found for ' + poolId };
  let meta = { jobs: [] };
  try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  const labelByJob = {}; for (const j of (meta.jobs||[])) labelByJob[j.jobId] = j.label;
  const rows = [];
  // v2.2.3 Session 3A (A3): also collect dialog records into a separate stream so the
  // merged-log viewer can show "this row had a dialog with message X". Same dialogs appear
  // in the per-worker xlsx Log sheet (under the 'dialogs' column), but the merged log
  // aggregates across workers/jobs which is more useful for forensics.
  const dialogs = [];
  const counts = { ok: 0, skip: 0, error: 0, total: 0 };
  try {
    const lines = fs.readFileSync(jp, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        // Dialog record: {t:'dlg', j, r, m, k, ts}. Not a row completion; skip counter logic.
        if (rec.t === 'dlg') {
          dialogs.push({ job: labelByJob[rec.j] || rec.j, row: rec.r, message: rec.m, dialogType: rec.k, ts: rec.ts });
          continue;
        }
        const status = rec.s;
        rows.push({ job: labelByJob[rec.j] || rec.j, row: rec.r, status });
        counts.total++;
        if (status === 'ok' || status === 'ok (retry)') counts.ok++;
        else if (status === 'skip') counts.skip++;
        else if (status === 'error') counts.error++;
      } catch {}
    }
  } catch (e) { return { ok: false, error: e.message }; }
  rows.sort((a,b) => a.row - b.row);
  return { ok: true, poolId, jobs: (meta.jobs||[]).map(j=>({jobId:j.jobId,label:j.label})), rows, dialogs, counts };
});

// Scale the live worker count toward `target`: spawn if below, retire surplus if above.
// Retirement is graceful — surplus workers get 'drain' and finish their current batch.
async function coordScaleTo(target){
  const live = COORD.workers.size;
  if (target > live) {
    // v2.2.1: count reclaimed rows (job.requeue) as remaining work so a worker can be spawned to
    // drain them even after nextRow has passed totalRows — otherwise lazily-reclaimed rows strand.
    let totalRemaining = 0; for (const j of COORD.jobs.values()) totalRemaining += Math.max(0, j.totalRows - (j.nextRow - 1)) + (j.requeue ? j.requeue.length : 0);
    const canSpawn = Math.min(target - live, Math.max(0, totalRemaining));
    for (let i = 0; i < canSpawn; i++) await coordSpawnWorker();
  } else if (target < live) {
    let toRetire = live - target;
    for (const w of COORD.workers.values()) {
      if (toRetire <= 0) break;
      if (w.status === 'running' || w.status === 'starting') {
        try { w.process.stdin.write(JSON.stringify({ cmd: 'drain' }) + '\n'); } catch {}
        w.status = 'draining';
        toRetire--;
      }
    }
  }
  coordEmitStatus();
}

// Elastic license scaling: re-scrape free licenses and scale workers to (free - buffer),
// also bounded by hardware. Runs on a timer when elastic mode is enabled.
async function coordLicenseScale(profileId, buffer, hwCap){
  if (!COORD.active) return;
  const BUF = (buffer != null) ? Math.max(0, parseInt(buffer)) : 10;
  const chromiumExe = getBundledChromiumPath();
  if (!chromiumExe) return;
  const all = readAllProfiles();
  const prof = all.find(p => p.id === profileId) || {};
  if (keytar) {
    prof.companyKey = await keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
    prof.username   = await keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
    prof.password   = await keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
  }
  let browser;
  try {
    const { chromium } = require('playwright-core');
    browser = await chromium.launch({ headless: true, executablePath: chromiumExe, args: ['--disable-gpu','--disable-dev-shm-usage'] });
    const page = await (await browser.newContext()).newPage();
    await page.goto(prof.loginUrl || 'https://login.pestpac.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('input[name="uid"]', { timeout: 15000 });
    await page.fill('input[name="uid"]', prof.companyKey || '');
    try { await page.waitForSelector('.MuiBackdrop-root', { state: 'hidden', timeout: 12000 }); } catch {}
    try { await page.click('button[data-testid="CompanyKeyForm-loginBtn"]', { timeout: 15000 }); }
    catch { await page.click('button[data-testid="CompanyKeyForm-loginBtn"]', { force: true }); }
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.fill('input[name="username"]', prof.username || '');
    await page.fill('input[name="password"]', prof.password || '');
    // v2.1.1a: wait out the MUI loading backdrop before clicking login (see check-license-cap).
    try { await page.waitForSelector('.MuiBackdrop-root', { state: 'hidden', timeout: 12000 }); } catch {}
    try { await page.click('button[data-testid="loginBtn"]', { timeout: 15000 }); }
    catch { await page.click('button[data-testid="loginBtn"]', { force: true }); }
    await page.waitForSelector('a[href*="AutoLogin"]', { timeout: 30000 });
    await page.goto('https://app.pestpac.com/license.asp?Mode=View', { waitUntil: 'load', timeout: 30000 });
    // v2.2.1: read the PestPac FREE value from the #div_PestPac panel with an EXACT label match
    // (avoids the old startsWith bug that could read used/total or a Mobile/RouteOp table).
    const freeText = await page.evaluate(() => {
      const scope = document.querySelector('#div_PestPac') || document;
      const tds = Array.from(scope.querySelectorAll('td'));
      for (const td of tds) { const label=(td.textContent||'').trim().toLowerCase().replace(/\s+/g,' '); if (label==='number of free licenses:'||label==='number of free licenses') { const s = td.nextElementSibling; if (s) return (s.textContent||'').trim(); } }
      return null;
    });
    await licenseReaderLogout(page); // v2.2.1: the elastic recheck session is a consumed license — log out before closing.
    await browser.close();
    if (freeText == null) return;
    const free = parseInt(String(freeText).replace(/[^0-9]/g, ''));
    if (isNaN(free)) return;
    // free here is measured WHILE our workers are logged in, so it already reflects our usage.
    // The number of additional workers we can safely add is (free - buffer); never go below 1.
    const headroom = free - BUF;
    const newTarget = Math.max(1, Math.min(COORD.workers.size + headroom, hwCap, MAX_WORKERS_HARD_CEILING));
    if (mainWindow) mainWindow.webContents.send('pool-license-update', { freeLicenses: free, buffer: BUF, newTarget, liveWorkers: COORD.workers.size });
    COORD.desiredWorkers = newTarget;
    await coordScaleTo(newTarget);
  } catch (e) {
    try { if (browser) await browser.close(); } catch(_){}
    if (mainWindow) mainWindow.webContents.send('pool-license-update', { error: e.message });
  }
}



// ── AUTOMATION RUNNER ─────────────────────────────────────────────────────────
// v1.2.8: resolve a flow by its `name` field. Scans the flows directory, matches by
// `name` first then by filename stem. Returns the parsed flow or null if not found
// (caller decides whether that's an error).
function resolveOnceFlowByName(name) {
  if (!name) return null;
  const dir = getFlowsDir();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const f of entries) {
    if (!/\.json$/i.test(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // v1.2.8.1 hotfix: match by filename stem only. Older flows have data.name === 'buu-flow'
      // for every file; matching on that would collide. The dropdown now uses filename for
      // its option value, so we look up the same way.
      const candName = f.replace(/\.json$/i, '');
      if (candName === name) return data;
    } catch { /* skip malformed */ }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// v2.0.0 — POOL WORKER TEMPLATE (batch-pulling, persistent)
// Differs from buildRunner: the worker does NOT own the row loop. It logs in once, then
// repeatedly: emit {type:'request-batch'} → wait for stdin {cmd:'batch',rows:[...]} or
// {cmd:'drain'} → process those specific row indexes → repeat. On 'drain' it runs teardown
// + logout and exits. The coordinator (main) owns the queue and hands out batches.
// Reuses the same per-step engine semantics as buildRunner (token resolve, iframe-aware
// locators, find-by-text, retry). Each processed row is reported via {type:'row-result'}.
// ════════════════════════════════════════════════════════════════════════════
function buildPoolWorker(cfg){
  const {
    flowSteps, setupSteps = [], teardownSteps = [], spreadsheetPath, logPath,
    chromiumExePath, errHandle = 'retry', selectorTimeout = 30,
    pageLoadMode = 'domcontentloaded', retryCount = 2, runContext = {},
    // v2.2.2 Session 2E: per-job runtime knobs.
    breakerThreshold = 0, retryRowIndexes = null, reauthIntervalMin = 0,
  } = cfg;
  return `
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// v2.2.2 Session 2D: net is required for the TCP probe used by network-aware retry.
const net = require('net');
const _nm = process.env.NODE_PATH || path.join(__dirname);
${REQUIRE_FN_SRC}
if(process.env.NODE_PATH){ try{require('module').Module._initPaths();}catch(e){} }
const { chromium } = _require('playwright-core');
const XLSX = _require('xlsx');

const SPREADSHEET = process.argv[2];
const CRED_PATH = process.argv[3];
const LOG_PATH = ${JSON.stringify(logPath)};
const ERR_HANDLE = ${JSON.stringify(errHandle)};
const SELECTOR_TIMEOUT = ${parseInt(selectorTimeout) * 1000};
const PAGE_LOAD_MODE = ${JSON.stringify(pageLoadMode)};
// v2.0.2: navigation timeout for the navigate step. PestPac lead pages can be very slow on a
// large account, so this is 90s (vs the old hardcoded 30s) to cut false skips on slow loads.
const NAV_TIMEOUT = 90000;
const RETRY_COUNT = ${parseInt(retryCount)};
// v2.2.2 Session 2E: per-job knobs. BREAKER_THRESHOLD=0 disables the circuit breaker.
// RETRY_ROW_INDEXES=null processes all rows; an array (-> Set below) restricts to those row
// numbers (retry-failed mode). REAUTH_INTERVAL_MS=0 disables proactive re-auth; otherwise
// the worker re-logs-in at the next row boundary after the timer elapses.
const BREAKER_THRESHOLD = ${parseInt(breakerThreshold) || 0};
const RETRY_ROW_INDEXES = ${retryRowIndexes && retryRowIndexes.length ? JSON.stringify(retryRowIndexes) : 'null'};
const REAUTH_INTERVAL_MS = ${(parseInt(reauthIntervalMin) || 0) * 60 * 1000};
const RETRY_ROW_SET = RETRY_ROW_INDEXES ? new Set(RETRY_ROW_INDEXES) : null;
const CHROMIUM_EXE = ${JSON.stringify(chromiumExePath)};
const FLOW_STEPS = ${JSON.stringify(flowSteps)};
const SETUP_STEPS = ${JSON.stringify(setupSteps)};
const TEARDOWN_STEPS = ${JSON.stringify(teardownSteps)};
const RUN_CONTEXT = ${JSON.stringify(runContext)};
// v2.2.2 Session 2C: step-by-step mode. Coordinator passes 'run-all' / 'step' / 'step-row'
// when spawning. Pool forces workers=1 batch=1 when startMode is 'step' or 'step-row',
// then scales up when the user clicks Run-All (coordinator handles that scaling).
const START_MODE = ${JSON.stringify(cfg.startMode || 'run-all')};
const LOGIN_STEPS = FLOW_STEPS.filter(s => s.locked && s.type !== 'pestpac-logout');
const DATA_STEPS  = FLOW_STEPS.filter(s => !s.locked && s.type !== 'pestpac-logout');
const LOGOUT_STEP = FLOW_STEPS.find(s => s.type === 'pestpac-logout') || {type:'pestpac-logout'};

const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\\n');}

// ── stdin command channel ──
// Pre-2.2.2: only batch/drain messages flowed here.
// v2.2.2 Session 2C: also demuxes step-by-step commands sent by the coordinator on behalf
// of the renderer (mode / next-step / next-row / run-all / stop). A separate readline
// would have collided with this one (both consume each \\n-delimited message), so one
// readline demuxes by msg.cmd.
let _pendingBatchResolve = null;
let _pendingPauseResolve = null;
let _draining = false;
// currentMode: 'run-all' | 'step' | 'step-row' | 'stop'.
// 'stop' triggers an in-progress pause to release and a clean drain shortly after.
let currentMode = START_MODE;
// v2.2.3 Session 3A (A3): track the row currently being processed so the blanket dialog
// listener can attribute dialogs to the right row. Set by the batch loop before processRow,
// cleared after row-result. The current row object is also exposed so the listener can
// push captured dialogs into row.__dialogs for the per-worker xlsx log.
let _currentRowNum = null;
let _currentRow = null;
const _readline = require('readline');
const _rl = _readline.createInterface({ input: process.stdin, terminal: false });
_rl.on('line', function(line){
  let msg; try{ msg = JSON.parse(line); }catch(e){ return; }
  if(!msg || !msg.cmd) return;
  switch(msg.cmd){
    case 'batch':
    case 'drain':
      if(msg.cmd === 'drain') _draining = true;
      if(_pendingBatchResolve){ const r=_pendingBatchResolve; _pendingBatchResolve=null; r(msg); }
      break;
    case 'mode':
      // Whole-mode change. 'mode' alone changes how the engine behaves at the next decision
      // point; it does NOT itself resolve a pending pause (use a separate next-* for that).
      if(msg.mode === 'run-all' || msg.mode === 'step' || msg.mode === 'step-row' || msg.mode === 'stop'){
        currentMode = msg.mode;
      }
      // If we just switched out of step modes, release any pending pause so the row loop continues.
      if((currentMode === 'run-all' || currentMode === 'stop') && _pendingPauseResolve){
        const r = _pendingPauseResolve; _pendingPauseResolve = null; r('auto');
      }
      break;
    case 'next-step':
    case 'next-row':
    case 'run-all':
    case 'stop':
      // Implicit mode change for run-all/stop. next-step/next-row keep current mode.
      if(msg.cmd === 'run-all') currentMode = 'run-all';
      if(msg.cmd === 'stop') currentMode = 'stop';
      if(_pendingPauseResolve){ const r = _pendingPauseResolve; _pendingPauseResolve = null; r(msg.cmd); }
      break;
  }
});
function requestBatch(){
  emit({type:'request-batch'});
  return new Promise(function(r){ _pendingBatchResolve = r; });
}
// v2.2.2 Session 2C: pause for the next renderer command in step modes. In run-all/stop
// resolves immediately (returning 'auto') so the engine flows through without waiting.
function waitForCommand(){
  if(currentMode === 'run-all' || currentMode === 'stop') return Promise.resolve('auto');
  return new Promise(function(r){ _pendingPauseResolve = r; });
}
// v2.2.2 Session 2C: substitution preview for the step-mode pause panel. Mirrors the r()
// resolver in runStep but doesn't touch the page; the renderer displays what's about to
// happen so the user can verify before clicking Next-step.
function resolvePreview(step, row, creds){
  const r = function(v){
    if(!v) return '';
    return v.replace(/{{CRED:companyKey}}/g, creds.companyKey||'')
            .replace(/{{CRED:username}}/g, creds.username||'')
            .replace(/{{CRED:password}}/g, creds.password||'')
            .replace(/{{([^}]+)}}/g, function(_, ref){
              if(ref === 'TODAY') return RUN_CONTEXT.today || '';
              if(ref === 'RUNID') return RUN_CONTEXT.runId || '';
              if(ref === 'PROFILE_USERNAME') return RUN_CONTEXT.profileUsername || '';
              return row[ref] !== undefined ? String(row[ref]) : '';
            });
  };
  let value = '';
  if(step.type === 'type' || step.type === 'select') value = r(step.value || '');
  else if(step.type === 'navigate') value = r(step.url || '');
  else if(step.type === 'textedit') value = '(textedit: ' + (step.editMode || 'find-replace') + ')';
  else if(step.type === 'checkbox') value = '(' + (step.checkAction || 'check') + ')';
  else if(step.type === 'wait') value = '(' + (step.waitType || 'fixed') + ')';
  let selectorOut = step.selector || '';
  if(step.findByText){
    const matchResolved = r(step.matchText || '');
    selectorOut = 'in [' + (step.containerSel || '?') + '] where text ' + (step.matchMode || 'contains') + ' "' + matchResolved + '"'
                + (step.selector ? ' → ' + step.selector : ' (the matched item)');
  }
  return { type: step.type, label: step._label || step.type, selector: selectorOut, value: value };
}

// ── log buffer (per-worker Excel log) ──
let logEntries=[], flushTimer=null;
function addLog(e){logEntries.push(e);if(logEntries.length%50===0)flush();else{clearTimeout(flushTimer);flushTimer=setTimeout(flush,3000);}}
function flush(){
  try{
    const wb=XLSX.utils.book_new();
    const summary=[{Metric:'Worker',Value:${JSON.stringify(runContext.runId||'')}},{Metric:'Processed',Value:logEntries.filter(e=>e.row).length},{Metric:'Last updated',Value:new Date().toLocaleString()}];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');
    if(logEntries.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logEntries), 'Rows');
    XLSX.writeFile(wb, LOG_PATH);
  }catch(e){ emit({type:'log-error', message:e.message}); }
}

// ── load all rows into memory once (workers index into this by 1-based row number) ──
function loadAllRows(fp){
  const ext=path.extname(fp).toLowerCase();
  if(ext==='.csv'){
    const lines=fs.readFileSync(fp,'utf8').split('\\n').filter(Boolean);
    const headers=lines[0].split(',').map(h=>h.trim().replace(/^"|"$/g,''));
    const out=[];
    for(let i=1;i<lines.length;i++){ const vals=lines[i].split(',').map(v=>v.trim().replace(/^"|"$/g,'')); const row={}; headers.forEach((h,j)=>row[h]=vals[j]||''); out.push(row); }
    return out;
  }
  const wb=XLSX.readFile(fp);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
}

// v2.2.2: shared canonical login (was a 4th copy here; see LOGIN_TO_PESTPAC_SRC at top of main.js).
${LOGIN_TO_PESTPAC_SRC}

// v2.2.2 (Session 2A): selector helpers via canonical constants (see main.js top).
${FIND_LOCATOR_FN_SRC}

${MATCHES_TEXT_FN_SRC}

${FIND_IN_CONTAINER_FN_SRC}

${RESOLVE_STEP_LOCATOR_FN_SRC}

// v2.2.2 Session 2D: network-aware retry + error classification (was buildRunner-only).
${PROBE_NETWORK_FN_SRC}

${WAIT_FOR_NETWORK_FN_SRC}

${CLASSIFY_ERROR_FN_SRC}

${CLASSIFY_PHASE_FN_SRC}

async function runStep(page, step, row, creds){
  const r=v=>{ if(!v)return''; return v.replace(/{{CRED:companyKey}}/g,creds.companyKey||'').replace(/{{CRED:username}}/g,creds.username||'').replace(/{{CRED:password}}/g,creds.password||'').replace(/{{([^}]+)}}/g,function(_,ref){ if(ref==='TODAY')return RUN_CONTEXT.today||''; if(ref==='RUNID')return RUN_CONTEXT.runId||''; if(ref==='PROFILE_USERNAME')return RUN_CONTEXT.profileUsername||''; return row[ref]!==undefined?String(row[ref]):''; }); };
  const ms=s=>Math.round(parseFloat(s||1)*1000);
  switch(step.type){
    case 'navigate':{const u=r(step.url); if(!u) throw new Error('Navigate URL empty'); await page.goto(u,{waitUntil:PAGE_LOAD_MODE,timeout:NAV_TIMEOUT}); break;}
    case 'click':{ const loc=await resolveStepLocator(page,step,r); await loc.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); await loc.first().click(); if(step.waitFor){ const wl=await findLocator(page,step.waitFor,{timeout:SELECTOR_TIMEOUT}); await wl.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); } break; }
    case 'type':{ const loc=await resolveStepLocator(page,step,r); await loc.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); if(step.clearFirst!=='no') await loc.first().fill(''); const val=r(step.value); const delay=parseInt(step.typeDelay||0); if(delay>0) await loc.first().pressSequentially(val,{delay:delay}); else await loc.first().fill(val); break; }
    case 'select':{ const loc=await resolveStepLocator(page,step,r); await loc.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); await loc.first().selectOption({label:r(step.value)}); break; }
    case 'checkbox':{ const loc=await resolveStepLocator(page,step,r); await loc.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); if(step.checkAction==='check')await loc.first().check(); else if(step.checkAction==='uncheck')await loc.first().uncheck(); else if(step.checkAction==='toggle')await loc.first().click(); else if(step.checkAction==='conditional'){ const tv=(step.truthyVals||'yes,true,1,x').split(',').map(v=>v.trim().toLowerCase()); if(tv.includes(String(r(step.condCol)).trim().toLowerCase()))await loc.first().check(); else await loc.first().uncheck(); } break; }
    case 'clear':{ const loc=await resolveStepLocator(page,step,r); await loc.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); await loc.first().fill(''); break; }
    case 'wait':if(step.waitType==='random'){const mn=ms(step.waitMin||1),mx=ms(step.waitMax||3);await page.waitForTimeout(Math.floor(Math.random()*(mx-mn+1))+mn);}else if(step.waitType==='element'){const loc=await findLocator(page,step.waitSel||'',{timeout:30000});await loc.first().waitFor({state:'visible',timeout:30000});}else if(step.waitType==='navigation')await page.waitForNavigation({timeout:30000});else await page.waitForTimeout(ms(step.waitSec||1));break;
    case 'assert':{ const loc=await resolveStepLocator(page,step,r); await loc.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); if(step.expected){ const t=await loc.first().textContent(); if(!t||!t.includes(step.expected)) throw new Error('Assert failed: expected "'+step.expected+'"'); } break; }
    case 'pestpac-login':{ await loginToPestPac(page,creds); break; }
    case 'pestpac-logout':{ await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'load',timeout:15000}); await page.waitForSelector('div.select',{timeout:10000}); await page.click('div.select'); await page.waitForSelector('a.logout',{timeout:5000}); await page.click('a.logout'); await page.waitForTimeout(1500); break; }
    case 'fileupload':{
      // Resolve the file path for this row (column path, or fixed folder + filename column).
      let filePath='';
      if(step.pathSource==='fixed'){ const base=(step.baseFolder||'').replace(/[\\\\/]+$/,''); const fn=r(step.fileNameColumn||''); filePath = fn ? (base + '\\\\' + fn) : ''; }
      else { filePath = r(step.pathColumn||''); }
      if(!filePath){ throw new Error('File upload: no file path resolved for this row'); }
      if(!fs.existsSync(filePath)){ throw new Error('File upload: file not found: '+filePath); }
      const loc=await resolveStepLocator(page,step,r); await loc.first().setInputFiles(filePath); break;
    }
    case 'readfield':{
      // v2.2.0: read a field's current value/label and store it under step.colName so (a) later
      // steps can use {{colName}} via the row resolver and (b) the coordinator can write it to the
      // dedicated results workbook. value+label for <select>; text for inputs/spans.
      const colName=(step.colName||'').trim(); if(!colName) break;
      const mode=step.readMode||'both';
      let value=null, label=null, found=false;
      const sel=step.selector||'';
      for(const f of page.frames()){
        try{
          const handle=await f.$(sel); if(!handle) continue;
          const info=await f.evaluate(el=>{
            const tag=(el.tagName||'').toLowerCase();
            if(tag==='select'){ const o=el.options&&el.selectedIndex>=0?el.options[el.selectedIndex]:null; return {value:el.value, label:o?(o.textContent||'').trim():''}; }
            if(tag==='input'||tag==='textarea'){ return {value:el.value, label:el.value}; }
            const t=(el.textContent||'').trim(); return {value:t, label:t};
          }, handle);
          value=info.value; label=info.label; found=true; break;
        }catch(e){ /* not in this frame */ }
      }
      if(!found){ if(step.readOnMissing==='error') throw new Error('Read field: selector not found: '+sel); value=''; label=''; }
      const out = mode==='value' ? (value||'') : (mode==='text' ? (label||'') : (label||value||''));
      // Store for later-step token use and for reporting.
      row[colName]=out;
      row[colName+'__raw']=(value||'');
      row[colName+'__label']=(label||'');
      if(!row.__reads) row.__reads={};
      row.__reads[colName]={ value:(value||''), label:(label||''), out:out };
      break;
    }
    // v2.2.2 Session 2B: textedit ported from buildRunner. Multi-mode in-place text manipulation
    // on the field at step.selector. Reads current value, transforms per editMode, writes back.
    // editModes: find-replace / exact-remove / partial-remove-word / partial-remove-piece /
    //            partial-replace-piece / remove-after / remove-before / trim /
    //            remove-extra-spaces / regex. Bug fix on port: the regex editMode previously
    //            referenced undefined "replace" — corrected to "replaceStr".
    case 'textedit':{
      await page.waitForSelector(step.selector,{timeout:SELECTOR_TIMEOUT});
      const currentVal = await page.$eval(step.selector, el => el.value || el.textContent || el.innerText || '');
      const search = r(step.searchVal||'');
      const replaceStr = r(step.replaceVal||'');
      const tch = step.charVal||'@';
      const flags = (step.regexFlags||'gi');
      let newVal = currentVal;
      switch(step.editMode||'find-replace'){
        case 'find-replace':
          if(step.caseSensitive==='yes'){
            newVal = currentVal.split(search).join(replaceStr);
          } else {
            const searchLower = search.toLowerCase();
            let result=''; let i=0;
            while(i<currentVal.length){
              if(currentVal.substring(i,i+search.length).toLowerCase()===searchLower){ result+=replaceStr; i+=search.length; }
              else { result+=currentVal[i]; i++; }
            }
            newVal = result;
          }
          break;
        case 'exact-remove':
          newVal = currentVal.split(search).join('');
          break;
        case 'partial-remove-word':
          newVal = currentVal.split(/\\s+/).filter(w => !(step.caseSensitive==='yes' ? w.includes(search) : w.toLowerCase().includes(search.toLowerCase()))).join(' ').trim();
          break;
        case 'partial-remove-piece':
          newVal = currentVal.split(/\\s+/).map(w => { const idx = step.caseSensitive==='yes' ? w.indexOf(search) : w.toLowerCase().indexOf(search.toLowerCase()); if(idx<0) return w; return w.slice(0,idx) + w.slice(idx+search.length); }).join(' ').trim();
          break;
        case 'partial-replace-piece':
          newVal = currentVal.split(/\\s+/).map(w => { const idx = step.caseSensitive==='yes' ? w.indexOf(search) : w.toLowerCase().indexOf(search.toLowerCase()); if(idx<0) return w; return w.slice(0,idx) + replaceStr + w.slice(idx+search.length); }).join(' ').trim();
          break;
        case 'remove-after':
          { const idx=currentVal.indexOf(tch); if(idx>=0) newVal=currentVal.slice(0,idx); }
          break;
        case 'remove-before':
          { const idx=currentVal.indexOf(tch); if(idx>=0) newVal=currentVal.slice(idx+tch.length); }
          break;
        case 'trim':
          newVal = currentVal.trim();
          break;
        case 'remove-extra-spaces':
          newVal = currentVal.trim().replace(/  +/g,' ');
          break;
        case 'regex':
          try{ newVal = currentVal.replace(new RegExp(search, flags), replaceStr); }
          catch(e){ throw new Error('Invalid regex pattern: '+search+' — '+e.message); }
          break;
      }
      const tag = await page.$eval(step.selector, el => el.tagName.toLowerCase());
      if(tag==='input'||tag==='textarea'){
        await page.fill(step.selector, newVal);
      } else {
        await page.$eval(step.selector, (el,v) => { el.textContent=v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }, newVal);
      }
      break;
    }
    case 'dialog':{ const matchText=step.dialogMatch||''; const dialogAction=step.dialogAction||'accept'; if(page._buuDialogListener){ try{page.off('dialog',page._buuDialogListener);}catch(_){} page._buuDialogListener=null; } const handler=async dialog=>{ try{page.off('dialog',handler);}catch(_){} if(page._buuDialogListener===handler)page._buuDialogListener=null; const msg=dialog.message(); const matches=!matchText||msg.toLowerCase().includes(matchText.toLowerCase()); try{ if(matches){ if(dialogAction==='dismiss')await dialog.dismiss(); else await dialog.accept(); } else { await dialog.dismiss(); } }catch(e){} }; page._buuDialogListener=handler; page.on('dialog',handler); break; }
  }
}

// Run a once-flow (setup/teardown) — no row context.
async function runOnceFlow(page, steps, creds){
  for(let i=0;i<steps.length;i++){ try{ await runStep(page, steps[i], {}, creds); }catch(e){ return {ok:false, error:e.message, stepIndex:i}; } }
  return {ok:true};
}

async function processRow(page, row, creds, rowNum){
  const done=[];
  // v2.2.2 Session 2C: __STOP__ / __NEXT_ROW__ sentinels for step-mode control flow.
  // - 'next-step' / 'auto' / 'run-all': falls through to execute the step normally.
  // - 'next-row': throws __NEXT_ROW__ so the row is recorded as skip and the loop moves on.
  // - 'stop': throws __STOP__ so the outer loop bails out and we proceed to shutdown.
  const attempt=async()=>{
    done.length=0;
    for(let si=0;si<DATA_STEPS.length;si++){
      const s=DATA_STEPS[si];
      emit({type:'step', row:rowNum, step:si+1, totalSteps:DATA_STEPS.length});
      // Pause BEFORE each step in step mode. Dialog steps skip the pause — they register an
      // invisible page.on('dialog') listener; pausing here makes the user click Next on a no-op,
      // then immediately again on the real action. Same rationale as buildRunner (v1.3.0 Item 5).
      if(currentMode === 'step' && s.type !== 'dialog'){
        const _preview = resolvePreview(s, row, creds);
        emit({type:'pause-step', row:rowNum, stepIndex:si, totalSteps:DATA_STEPS.length, step:_preview, mode:currentMode});
        const cmd = await waitForCommand();
        if(currentMode === 'stop') throw new Error('__STOP__');
        if(cmd === 'next-row') throw new Error('__NEXT_ROW__');
        // 'next-step' / 'run-all' / 'auto' fall through.
      }
      await runStep(page, s, row, creds);
      done.push(s._label||s.type);
    }
  };
  try{ await attempt(); return {status:'ok', fieldsWritten:done.join(' | ')}; }
  catch(e){
    // v2.2.2 Session 2C: step-mode sentinels short-circuit retry — they're user actions,
    // not errors. STOP propagates to the caller; NEXT_ROW becomes a clean skip.
    if(e && e.message === '__STOP__') throw e;
    if(e && e.message === '__NEXT_ROW__') return {status:'skip', error:'Skipped via Next-row during step-through', failedStep:'(user skipped)'};
    // v2.2.2 Session 2D: network-aware retry gate (was buildRunner-only). Probe AFTER the
    // failure; if PestPac is unreachable, wait for connectivity to come back BEFORE entering
    // the retry loop, so retries operate on a fresh connection instead of burning the budget
    // during a multi-minute outage (the v1.2.5 disaster pattern — see item 2.8 commentary).
    try {
      if (await probeNetwork() === false) {
        emit({type:'log', message:'Network down detected at row '+rowNum+' — waiting for reconnection before retry.'});
        const waitedMs = await waitForNetwork();
        emit({type:'log', message:'Network restored after '+Math.round(waitedMs/1000)+'s. Resuming row '+rowNum+'.'});
        // Note: 10-min outage re-auth trigger from buildRunner not ported here — the pool
        // worker's session-management story is different (workers re-spawn on logout sweep).
        // Session 2E will add the per-row re-auth trigger if profile-by-profile timing shows
        // it's needed. For now: bounded outage wait + clean retry on reconnect.
      }
    } catch (waitErr) {
      if (waitErr && waitErr.message === '__STOP__') throw waitErr;
      emit({type:'log', message:'Network gate unexpected error: '+(waitErr && waitErr.message)+' — continuing with retry logic'});
    }
    if(ERR_HANDLE==='retry'){
      let attemptN=0, lastErr=e;
      while(attemptN<RETRY_COUNT){
        attemptN++;
        try{ await attempt(); return {status:'ok (retry)', fieldsWritten:done.join(' | ')}; }
        catch(e2){
          if(e2 && e2.message === '__STOP__') throw e2;
          if(e2 && e2.message === '__NEXT_ROW__') return {status:'skip', error:'Skipped via Next-row during step-through', failedStep:'(user skipped)'};
          lastErr=e2;
        }
      }
      // v2.2.2 Session 2D: enrich failure with error category/phase columns (was buildRunner-only).
      // v2.2.3 Session 3A (A4): retry-exhaustion is an ERROR, not a skip. Pre-2.2.3 we used
      // 'skip' for any non-ok outcome (legacy from v1.x); A4 reserves 'skip' for user-chosen
      // filtering only — Next-row sentinels and retry-row-filter exclusions. Genuine
      // automation failures are 'error'. Counters, journal, and coordinator bookkeeping all
      // treat these distinctly after Session 3B.
      const errMsg = 'After '+attemptN+' retries: '+lastErr.message;
      return {
        status:'error',
        error: errMsg,
        failedStep: done[done.length-1]||'?',
        errorCategory: classifyError(errMsg),
        phase: classifyPhase(errMsg)
      };
    }
    // v2.2.3 Session 3A (A4): same reclassification for the errHandle='skip' path. When the
    // user picked "skip on error" as their handling strategy, a failed row is still an error
    // (BUU couldn't make it work), just not retried. Reserving 'skip' for user-chosen
    // filtering keeps the distinction clean.
    return {
      status:'error',
      error: e.message,
      failedStep: done[done.length-1]||'?',
      errorCategory: classifyError(e.message),
      phase: classifyPhase(e.message)
    };
  }
}

async function main(){
  const creds=dec(fs.readFileSync(CRED_PATH,'utf8'))[0]||{};
  const ALL_ROWS = loadAllRows(SPREADSHEET);
  const browser = await chromium.launch({ headless:true, executablePath:CHROMIUM_EXE, args:['--disable-gpu','--disable-dev-shm-usage','--disable-background-timer-throttling'] });
  const page = await (await browser.newContext()).newPage();

  // v2.2.3 Session 3A (A3): blanket dialog listener. Logs every dialog (PestPac validation
  // popups, confirmation dialogs, alerts) regardless of whether a Handle Dialog step is
  // registered. Multiple page.on('dialog') listeners are all called by Playwright — the
  // Handle Dialog step's specific listener still does the accept/dismiss; this one only
  // observes. If NO listener calls accept/dismiss, Playwright auto-dismisses, which is the
  // pre-2.2.3 default behavior for unhandled dialogs. Captured dialogs flow two places:
  //   1) row.__dialogs[] on the current row, written to the per-worker xlsx Log sheet
  //   2) emit({type:'dialog', ...}) so the coordinator journals it into the merged log
  page.on('dialog', dialog => {
    try {
      const message = dialog.message();
      const dialogType = dialog.type();  // 'alert' | 'confirm' | 'prompt' | 'beforeunload'
      const captured = { ts: new Date().toISOString(), message: message, dialogType: dialogType, row: _currentRowNum };
      // Stash on the current row (if any). Setup/teardown have _currentRow=null; the emit
      // below still captures the dialog text into the journal, which is what matters.
      if (_currentRow) {
        if (!_currentRow.__dialogs) _currentRow.__dialogs = [];
        _currentRow.__dialogs.push(captured);
      }
      emit({ type:'dialog', row: _currentRowNum, message: message, dialogType: dialogType, ts: captured.ts });
    } catch (e) { /* logging never throws */ }
    // Intentionally NOT calling accept/dismiss here — that's the Handle Dialog step's job,
    // or Playwright's default auto-dismiss otherwise.
  });

  // v2.1.0: report the login phase so the UI shows 'logging in' before 'running'.
  emit({type:'logging-in'});
  // Login once.
  for(const step of LOGIN_STEPS){ try{ await runStep(page,step,{},creds); }catch(e){ emit({type:'fatal',error:'Login failed: '+e.message}); flush(); try{await browser.close();}catch(_){} process.exit(1); } }
  // Setup once-flow (per worker — each worker is its own session).
  if(SETUP_STEPS.length){ const sr=await runOnceFlow(page,SETUP_STEPS,creds); if(!sr.ok){ emit({type:'fatal',error:'Setup failed: '+sr.error}); flush(); await browser.close(); process.exit(1); } }

  emit({type:'ready'});

  // Batch-pull loop: ask for work, process, repeat until 'drain'.
  // v2.1.0: _draining is set the instant a drain command arrives (even mid-batch). We check it
  // BETWEEN EVERY ROW so the worker stops promptly and reaches logout, instead of grinding the
  // whole batch of slow pages first (which let the force-kill fire before logout -> stuck sessions).
  // v2.2.1: holds the unstarted tail of the current batch when a drain interrupts mid-batch, so
  // we can hand those rows back to the coordinator (lossless reclaim) before shutting down.
  let _reclaimRows = [];
  // v2.2.3 Session 3B (A5): tag each reclaim with WHY it happened so the coordinator can
  // tally "+N re-processed (X drain, Y breaker, Z user-stop)". Reasons used:
  //   'drain'     — coordinator sent a drain command (scale-down / pool-stop / sweep)
  //   'user-stop' — user clicked Stop mid-step or at a step-row pause
  //   'breaker'   — circuit breaker tripped on consecutive errors
  // Crash reclaims are tagged by the coordinator's catch-all path (where the worker can't
  // emit anything because it's already gone).
  let _reclaimReason = 'drain';
  // v2.2.2 Session 2E: circuit-breaker counters + re-auth timer scoped to main() so they
  // persist across batches. consecutiveErrors resets on any success; lastSuccessfulRow lets
  // the trip annotation say where progress stopped. nextReauthAt=0 disables proactive re-auth.
  let consecutiveErrors = 0;
  let lastSuccessfulRow = 0;
  let nextReauthAt = REAUTH_INTERVAL_MS > 0 ? Date.now() + REAUTH_INTERVAL_MS : 0;
  while(!_draining){
    const msg = await requestBatch();
    if(!msg || msg.cmd==='drain' || _draining){ break; }
    if(msg.cmd!=='batch' || !Array.isArray(msg.rows) || msg.rows.length===0){ continue; }
    for(let _bi=0; _bi<msg.rows.length; _bi++){
      const rowNum = msg.rows[_bi];
      // v2.2.1 LOSSLESS RECLAIM (worker side): a drain can arrive mid-batch (happens constantly
      // during elastic scale-down). We stop at this ROW boundary (current row already finished),
      // but the UNSTARTED tail of this batch was already handed out by the coordinator (removed
      // from the queue) and is NOT yet in completedRows. Hand it back so another worker picks it
      // up — otherwise these rows vanish silently. Capture the tail and break; the emit happens
      // after the loop, before the shutdown/logout sequence.
      if(_draining){ _reclaimRows = msg.rows.slice(_bi); break; }
      // v2.2.2 Session 2E: retry-failed mode. RETRY_ROW_SET is non-null only when the user
      // selected "retry failed rows" — in that case the worker silently skips any row not in
      // the set (no row-result emit; coordinator counts these as processed via the journal).
      // We emit a synthetic 'row-result' with status='skip' so coordinator bookkeeping stays
      // consistent (otherwise the coordinator never sees this row close and the pool waits
      // forever for it).
      if (RETRY_ROW_SET && !RETRY_ROW_SET.has(rowNum)) {
        emit({type:'row-result', row:rowNum, status:'skip', error:'(retry mode: row not in retry set)', durationMs:0});
        continue;
      }
      const row = ALL_ROWS[rowNum-1];
      if(!row){ emit({type:'row-result', row:rowNum, status:'skip', error:'row index out of range'}); continue; }
      // v2.2.2 Session 2E: proactive re-auth at row boundary. Fires when the configured timer
      // elapses (REAUTH_INTERVAL_MS > 0). Best-effort — failure is logged, row attempts the
      // run anyway; if the session is genuinely dead the per-row failure + network-aware
      // retry gate (Session 2D) handles it.
      if (nextReauthAt > 0 && Date.now() >= nextReauthAt) {
        emit({type:'log', message:'Re-authenticating (timer) before row '+rowNum});
        try {
          await loginToPestPac(page, creds);
          nextReauthAt = Date.now() + REAUTH_INTERVAL_MS;
          emit({type:'log', message:'Re-auth complete. Continuing.'});
        } catch (e) {
          emit({type:'log', message:'Re-auth failed: '+e.message+' — continuing; per-row retry will handle if needed.'});
        }
      }
      // batchPos/batchSize = e.g. 3/10 (which row of this batch); totalSteps for the step counter.
      emit({type:'row-start', row:rowNum, batchPos:_bi+1, batchSize:msg.rows.length});
      const t0=Date.now();
      // v2.2.3 Session 3A (A3): set the row-attribution globals so the blanket dialog
      // listener can tag captured dialogs with this row. Cleared after row-result emit.
      _currentRowNum = rowNum;
      _currentRow = row;
      // v2.2.2 Session 2C: processRow throws __STOP__ when user clicked Stop mid-step.
      // Catch it here so the batch loop can drain cleanly (with the rest of the batch
      // released to the coordinator via _reclaimRows).
      let res;
      try{ res = await processRow(page, row, creds, rowNum); }
      catch(e){
        if(e && e.message === '__STOP__'){
          _draining = true;
          _reclaimRows = msg.rows.slice(_bi+1);  // any rows not yet started
          _reclaimReason = 'user-stop';  // v2.2.3 Session 3B (A5)
          emit({type:'row-result', row:rowNum, status:'stopped', error:'User stop during step-through', durationMs:Date.now()-t0});
          _currentRowNum = null; _currentRow = null;
          break;
        }
        _currentRowNum = null; _currentRow = null;
        throw e;
      }
      const entry={ row:rowNum, timestamp:new Date().toISOString(), url:row.URL||row.url||'', status:res.status, error:res.error||'', failedStep:res.failedStep||'', fieldsWritten:res.fieldsWritten||'', durationMs:Date.now()-t0,
        // v2.2.2 Session 2D: forensic columns from the classifier (populated on failure).
        errorCategory: res.errorCategory || '', phase: res.phase || '',
        // v2.2.3 Session 3A (A3): serialize captured dialogs for the worker xlsx log.
        // Empty string when none; pipe-separated list of messages when present so the
        // xlsx column is readable as a single cell.
        dialogs: (row.__dialogs && row.__dialogs.length) ? row.__dialogs.map(d => d.dialogType + ': ' + d.message).join(' | ') : '' };
      addLog(entry);
      // v2.2.0: include any read-field values captured this row so the coordinator can write the
      // dedicated results workbook. row.__reads is { colName: {value,label,out} }.
      // v2.2.2 Session 2D: also pass errorCategory/phase so the renderer can show categorized failures.
      // v2.2.3 Session 3A (A3): also pass captured dialogs through to the coordinator/renderer.
      emit({type:'row-result', row:rowNum, status:res.status, error:res.error||'', durationMs:Date.now()-t0, reads: row.__reads||null,
        errorCategory: res.errorCategory || '', phase: res.phase || '',
        dialogs: row.__dialogs || null});
      _currentRowNum = null; _currentRow = null;
      // v2.2.2 Session 2E: circuit breaker bookkeeping. ok/ok-retry reset the counter;
      // user-chosen skips (Next-row or retry-row-filter exclusions) don't count. Genuine
      // errors increment.
      // v2.2.3 Session 3A (A4): now that 'skip' is reserved for user-chosen filtering only,
      // ANY status='skip' is a user/filter skip and should NOT increment the breaker counter.
      // The old regex check is redundant (kept as a belt-and-suspenders heuristic for any
      // weird path that still uses 'skip' with a non-user error message — shouldn't exist
      // after A4 but cheap to leave in).
      const _isUserSkip = res.status === 'skip';
      if (res.status === 'ok' || res.status === 'ok (retry)') {
        consecutiveErrors = 0;
        lastSuccessfulRow = rowNum;
      } else if (!_isUserSkip) {
        consecutiveErrors++;
      }
      if (BREAKER_THRESHOLD > 0 && consecutiveErrors >= BREAKER_THRESHOLD) {
        emit({type:'log', message:'Circuit breaker tripped: '+consecutiveErrors+' consecutive errors. Last successful row: '+lastSuccessfulRow+'. Draining worker.'});
        emit({type:'circuit-breaker', rowNum:rowNum, consecutiveErrors:consecutiveErrors, lastSuccessfulRow:lastSuccessfulRow});
        _draining = true;
        _reclaimRows = msg.rows.slice(_bi+1);
        _reclaimReason = 'breaker';  // v2.2.3 Session 3B (A5)
        break;
      }
      // v2.2.2 Session 2C: pause AFTER row in step-row mode. Same gating as buildRunner
      // (step-row pauses on the boundary so the user can verify the row's outcome in PestPac
      // before continuing). Skipped on the last row of the batch only if a drain has arrived;
      // otherwise the row-pause still fires because the next row may come from a future batch.
      if(currentMode === 'step-row' && !_draining){
        emit({type:'pause-row', row:rowNum, mode:currentMode});
        await waitForCommand();
        if(currentMode === 'stop'){
          _draining = true;
          _reclaimRows = msg.rows.slice(_bi+1);
          _reclaimReason = 'user-stop';  // v2.2.3 Session 3B (A5)
          break;
        }
      }
    }
  }

  // v2.2.1 LOSSLESS RECLAIM (worker side): before the shutdown/logout sequence, hand back any
  // rows from the interrupted batch that we never started. The coordinator pushes these into
  // job.requeue (skipping anything already completed) so another worker drains them. This MUST
  // be emitted before logout so the message is flushed while stdout is still open.
  // v2.2.3 Session 3B (A5): tag with the reason so the coordinator can tally
  // "+N re-processed (X drain, Y user-stop, Z breaker)". Default reason 'drain' covers
  // the coordinator-sent drain command (scale-down / pool-stop / sweep).
  if(_reclaimRows && _reclaimRows.length){ emit({type:'reclaim', rows:_reclaimRows, reason:_reclaimReason}); }

  // v2.1.0: shutdown sequence on drain. Report each phase so the UI can show
// 'shutting down' -> 'logging out' -> gone. Logout MUST happen (frees the PestPac license),
// so it gets its own try with a hard time budget and we report whether it succeeded.
  emit({type:'shutting-down'});
  if(TEARDOWN_STEPS.length){ try{ await runOnceFlow(page,TEARDOWN_STEPS,creds); }catch(e){} }
  emit({type:'logging-out'});
  // v2.1.1: VERIFIED logout. A single click is not trusted — after attempting logout we navigate
  // to a PestPac page and check whether we land on the login page (input[name="uid"] present).
  // If still logged in, we retry. The worker does NOT exit until logout is VERIFIED or the budget
  // is exhausted. A stuck session is a consumed PestPac license, so this must be near-bulletproof;
  // anything that still leaks is caught by the coordinator's license-manager sweep.
  let _loggedOut=false;
  async function _isLoggedOut(){
    // Land anywhere in the app; if redirected to the login page, the session is gone.
    try{
      await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'domcontentloaded',timeout:20000});
    }catch(e){ /* navigation hiccup — fall through and probe the DOM */ }
    try{
      // Login page (login.pestpac.com) shows the company-key field input[name="uid"].
      if(/login\\.pestpac\\.com/i.test(page.url())) return true;
      const uid = await page.$('input[name="uid"]');
      if(uid) return true;
      const user = await page.$('input[name="username"]');
      if(user) return true;
    }catch(e){}
    return false;
  }
  const _logoutDeadline = Date.now() + 150000; // 150s total budget across all attempts
  let _attempt=0;
  while(!_loggedOut && Date.now() < _logoutDeadline){
    _attempt++;
    try{
      await Promise.race([
        runStep(page, LOGOUT_STEP, {}, creds),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('logout step timeout')), 30000)),
      ]);
    }catch(e){ /* logout click/nav failed this attempt — verification below decides */ }
    try{ _loggedOut = await _isLoggedOut(); }catch(e){ _loggedOut=false; }
    emit({type:'logout-attempt', attempt:_attempt, ok:_loggedOut});
    if(_loggedOut) break;
    // Brief backoff, then re-attempt (a fresh login may have happened, or the menu wasn't ready).
    await page.waitForTimeout(2000).catch(()=>{});
  }
  emit({type:'logged-out', ok:_loggedOut, attempts:_attempt});
  flush();
  try{ await browser.close(); }catch(e){}
  emit({type:'retired', loggedOut:_loggedOut});
  process.exit(0);
}
main().catch(e=>{ emit({type:'fatal',error:e.message}); try{flush();}catch{} process.exit(1); });
`;
}

// ── LOGOUT SWEEPER (v2.1.1) ───────────────────────────────────────────────────
// The second, authoritative logout layer. After the pool finishes (or is stopped), the
// coordinator spawns this headless sweeper. It logs in, opens PestPac's License Manager
// (license.asp?Mode=View) which lists EVERY logged-in session, finds every row whose user is
// EXACTLY "BUU" (never a substring — real employees must never be logged out), ticks their
// LogOutUser{N} checkbox, clicks #butLogOut, and verifies the BUU count dropped to zero.
// This reclaims licenses even from workers that hard-crashed and never logged themselves out,
// which is what makes "there cannot be failure to log out" actually deliverable.
function buildLogoutSweeper({ chromiumExePath, loginSteps, runContext }) {
  return `
const { chromium } = require('playwright-core');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const CHROMIUM_EXE = ${JSON.stringify(chromiumExePath)};
const LOGIN_STEPS = ${JSON.stringify(loginSteps)};
const RUN_CONTEXT = ${JSON.stringify(runContext || {})};
const CRED_PATH = process.argv[2];
const BUU_USER = 'BUU'; // exact-match key for our sessions
const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\\n');}
function ms(s){return Math.round(parseFloat(s||1)*1000);}

// v2.2.2 (Session 2A): sweeper uses the stripped (no-iframe) minimal variant.
${FIND_LOCATOR_MINIMAL_SRC}
// Minimal step engine — only the step types login uses (navigate/type/click/select/wait).
async function runStep(page, step, creds){
  const r=v=>{ if(!v)return''; return v.replace(/{{CRED:companyKey}}/g,creds.companyKey||'').replace(/{{CRED:username}}/g,creds.username||'').replace(/{{CRED:password}}/g,creds.password||''); };
  switch(step.type){
    case 'navigate':{const u=r(step.url); if(u){ await page.goto(u,{waitUntil:'domcontentloaded',timeout:30000}); } break;}
    case 'type':{ const loc=await findLocator(page,step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().fill(''); await loc.first().fill(r(step.value)); break; }
    case 'click':{ const loc=await findLocator(page,step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().click(); break; }
    case 'select':{ const loc=await findLocator(page,step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().selectOption({label:r(step.value)}); break; }
    case 'wait':{ await page.waitForTimeout(ms(step.waitSec||1)); break; }
    case 'pestpac-login':{ await loginToPestPac(page,creds); break; }
  }
}
// v2.2.2: shared canonical login (was a copy of the hardened sequence; now sourced from LOGIN_TO_PESTPAC_SRC).
${LOGIN_TO_PESTPAC_SRC}

// Count + log out every BUU session on the License Manager page. Returns {before, after, loggedOut}.
async function sweepOnce(page){
  await page.goto('https://app.pestpac.com/license.asp?Mode=View',{waitUntil:'domcontentloaded',timeout:30000});
  // Each session row: first <td sortdata="USER"> contains the username; a checkbox input[name="LogOutUserN"].
  // Tick only rows whose username cell text is EXACTLY "BUU".
  const before = await page.evaluate((BUU)=>{
    let n=0; const rows=document.querySelectorAll('tr.records-table-data');
    rows.forEach(tr=>{ const td=tr.querySelector('td[sortdata]'); if(!td)return; const user=(td.getAttribute('sortdata')||td.textContent||'').trim(); if(user===BUU){ n++; const cb=tr.querySelector('input[type=checkbox][name^="LogOutUser"]'); if(cb && !cb.checked) cb.click(); } });
    return n;
  }, BUU_USER);
  if(before===0) return { before:0, after:0, loggedOut:0 };
  // Click the master Log Out button.
  try{ await page.click('#butLogOut',{timeout:10000}); }catch(e){ try{ await page.evaluate(()=>{ if(typeof butLogOut_OnClick==='function') butLogOut_OnClick(); }); }catch(_){} }
  // butLogOut may raise a confirm() dialog — auto-accept.
  page.on('dialog', async d=>{ try{ await d.accept(); }catch(_){} });
  await page.waitForTimeout(3000);
  // Re-read the page to confirm BUU sessions are gone.
  await page.goto('https://app.pestpac.com/license.asp?Mode=View',{waitUntil:'domcontentloaded',timeout:30000});
  const after = await page.evaluate((BUU)=>{
    let n=0; document.querySelectorAll('tr.records-table-data').forEach(tr=>{ const td=tr.querySelector('td[sortdata]'); if(!td)return; const user=(td.getAttribute('sortdata')||td.textContent||'').trim(); if(user===BUU) n++; });
    return n;
  }, BUU_USER);
  return { before, after, loggedOut: Math.max(0, before-after) };
}

async function main(){
  const creds=dec(fs.readFileSync(CRED_PATH,'utf8'))[0]||{};
  const browser = await chromium.launch({ headless:true, executablePath:CHROMIUM_EXE, args:['--disable-gpu','--disable-dev-shm-usage'] });
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', async d=>{ try{ await d.accept(); }catch(_){} });
  emit({type:'sweep-login'});
  try{
    if(LOGIN_STEPS && LOGIN_STEPS.length){ for(const s of LOGIN_STEPS){ await runStep(page,s,creds); } }
    else { await loginToPestPac(page,creds); }
  }catch(e){ emit({type:'sweep-fatal',error:'sweep login failed: '+e.message}); try{await browser.close();}catch(_){} process.exit(1); }
  // Sweep up to 3 passes (a session can take a moment to release).
  let result={before:0,after:0,loggedOut:0};
  for(let pass=1; pass<=3; pass++){
    try{ result = await sweepOnce(page); }catch(e){ emit({type:'sweep-error',pass,error:e.message}); }
    emit({type:'sweep-pass', pass, before:result.before, after:result.after, loggedOut:result.loggedOut});
    if(result.after===0) break;
    await page.waitForTimeout(2000);
  }
  // Log THIS sweeper's own session out too, so it doesn't leave a license consumed.
  let _selfOut=false;
  try{
    await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'load',timeout:15000});
    await page.waitForSelector('div.select',{timeout:10000}); await page.click('div.select');
    await page.waitForSelector('a.logout',{timeout:5000}); await page.click('a.logout');
    await page.waitForTimeout(1500);
    await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'domcontentloaded',timeout:15000});
    _selfOut = /login\\.pestpac\\.com/i.test(page.url()) || !!(await page.$('input[name="uid"]'));
  }catch(e){}
  emit({type:'sweep-done', remaining:result.after, loggedOut:result.loggedOut, selfLoggedOut:_selfOut});
  try{ await browser.close(); }catch(e){}
  process.exit(result.after===0 ? 0 : 2);
}
main().catch(e=>{ emit({type:'sweep-fatal',error:e.message}); process.exit(1); });
`;
}

// ── ONCE-FLOW RUNNER (v2.1.1 #8) ──────────────────────────────────────────────
// Runs a setup OR teardown once-flow a single time in its own headless session, for the
// 'per-job' / 'global' setup-scope modes (where workers do NOT run the once-flows themselves).
// Logs in, runs the steps with the given RUN_CONTEXT, then VERIFIES logout (same as workers).
function buildOnceFlowRunner({ chromiumExePath, loginSteps, onceSteps, runContext }) {
  return `
const { chromium } = require('playwright-core');
const fs = require('fs');
const crypto = require('crypto');
const CHROMIUM_EXE = ${JSON.stringify(chromiumExePath)};
const LOGIN_STEPS = ${JSON.stringify(loginSteps || [])};
const ONCE_STEPS = ${JSON.stringify(onceSteps || [])};
const RUN_CONTEXT = ${JSON.stringify(runContext || {})};
const CRED_PATH = process.argv[2];
const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\\n');}
function ms(s){return Math.round(parseFloat(s||1)*1000);}
// v2.2.2: shared canonical login (was the 4th and final inline copy; now sourced from LOGIN_TO_PESTPAC_SRC).
${LOGIN_TO_PESTPAC_SRC}
async function runStep(page, step, creds){
  const r=v=>{ if(!v)return''; return v.replace(/{{CRED:companyKey}}/g,creds.companyKey||'').replace(/{{CRED:username}}/g,creds.username||'').replace(/{{CRED:password}}/g,creds.password||'').replace(/{{([^}]+)}}/g,function(_,ref){ if(ref==='TODAY')return RUN_CONTEXT.today||''; if(ref==='RUNID')return RUN_CONTEXT.runId||''; if(ref==='PROFILE_USERNAME')return RUN_CONTEXT.profileUsername||''; return ''; }); };
  switch(step.type){
    case 'navigate':{const u=r(step.url); if(!u) throw new Error('Navigate URL empty'); await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}); break;}
    case 'click':{ const loc=page.locator(step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().click(); break; }
    case 'type':{ const loc=page.locator(step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().fill(''); await loc.first().fill(r(step.value)); break; }
    case 'select':{ const loc=page.locator(step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().selectOption({label:r(step.value)}); break; }
    case 'checkbox':{ const loc=page.locator(step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); if(step.checkAction==='uncheck')await loc.first().uncheck(); else await loc.first().check(); break; }
    case 'wait':{ if(step.waitType==='element'){ await page.locator(step.waitSel||'').first().waitFor({state:'visible',timeout:30000}); } else { await page.waitForTimeout(ms(step.waitSec||1)); } break; }
    case 'pestpac-login':{ await loginToPestPac(page,creds); break; }
    case 'pestpac-logout':{ break; } // logout handled centrally below
  }
}
async function main(){
  const creds=dec(fs.readFileSync(CRED_PATH,'utf8'))[0]||{};
  const browser = await chromium.launch({ headless:true, executablePath:CHROMIUM_EXE, args:['--disable-gpu','--disable-dev-shm-usage'] });
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', async d=>{ try{ await d.accept(); }catch(_){} });
  emit({type:'once-login', phase:RUN_CONTEXT.phase});
  try{
    if(LOGIN_STEPS && LOGIN_STEPS.length){ for(const s of LOGIN_STEPS){ await runStep(page,s,creds); } }
    else { await loginToPestPac(page,creds); }
  }catch(e){ emit({type:'once-fatal',error:'login failed: '+e.message}); try{await browser.close();}catch(_){} process.exit(1); }
  let _ok=true, _err='';
  for(let i=0;i<ONCE_STEPS.length;i++){ try{ await runStep(page,ONCE_STEPS[i],creds); }catch(e){ _ok=false; _err='step '+(i+1)+': '+e.message; break; } }
  emit({type:'once-steps-done', ok:_ok, error:_err, phase:RUN_CONTEXT.phase});
  // Verified logout (mirror of the worker): attempt -> probe login page -> retry within budget.
  let _out=false; const _deadline=Date.now()+90000;
  while(!_out && Date.now()<_deadline){
    try{
      await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'load',timeout:15000});
      await page.waitForSelector('div.select',{timeout:10000}); await page.click('div.select');
      await page.waitForSelector('a.logout',{timeout:5000}); await page.click('a.logout');
      await page.waitForTimeout(1500);
    }catch(e){}
    try{ await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'domcontentloaded',timeout:15000}); _out = /login\\.pestpac\\.com/i.test(page.url()) || !!(await page.$('input[name="uid"]')); }catch(e){ _out=false; }
    if(_out) break; await page.waitForTimeout(2000).catch(()=>{});
  }
  emit({type:'once-done', ok:_ok, loggedOut:_out, phase:RUN_CONTEXT.phase});
  try{ await browser.close(); }catch(e){}
  process.exit(_ok?0:2);
}
main().catch(e=>{ emit({type:'once-fatal',error:e.message}); process.exit(1); });
`;
}

// Run a once-flow (setup or teardown) ONCE for the given job, in the coordinator (per-job/global
// scope). Returns a promise that resolves when the spawned session exits. Best-effort: failures
// are logged and surfaced but do not crash the pool.
function coordRunOnceFlow(job, phase){
  return new Promise((resolve) => {
    try{
      const flowId = phase === 'setup' ? job.setupFlowId : job.teardownFlowId;
      if(!flowId){ return resolve({ ok:true, skipped:true }); }
      const onceSteps = (resolveOnceFlowByName(flowId)||{}).steps || [];
      if(!onceSteps.length){ return resolve({ ok:true, skipped:true }); }
      const chromiumExe = getBundledChromiumPath();
      if(!chromiumExe){ return resolve({ ok:false, error:'chromium not found' }); }
      const anyJob = job;
      const loginSteps = (anyJob.flowSteps || []).filter(s => s.locked || s.type === 'pestpac-login');
      const profileId = job.profileId;
      const all = readAllProfiles();
      const prof = all.find(p => p.id === profileId) || {};
      const finish = async () => {
        if (keytar) {
          prof.companyKey = await keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
          prof.username   = await keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
          prof.password   = await keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
        }
        const onceId = 'once' + Date.now() + '-' + Math.floor(Math.random()*1000);
        const credPath = path.join(os.tmpdir(), `buu2-once-${onceId}.enc`);
        fs.writeFileSync(credPath, encStore([prof]));
        const runnerPath = path.join(os.tmpdir(), `buu2-once-${onceId}.js`);
        fs.writeFileSync(runnerPath, buildOnceFlowRunner({
          chromiumExePath: chromiumExe, loginSteps, onceSteps,
          runContext: { runId: onceId, phase, today: new Date().toISOString().slice(0,10), profileUsername: prof.username || '' },
        }));
        const env = { ...process.env };
        const nodeModulesPath = app.isPackaged
          ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
          : path.join(__dirname, '..', 'node_modules');
        env.NODE_PATH = nodeModulesPath; env.BUU_NODE_MODULES = nodeModulesPath; env.ELECTRON_RUN_AS_NODE = '1';
        const logPath = path.join(getLogsDir(), `buu2-once-${onceId}.log`);
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        logStream.write(`[${new Date().toISOString()}] ${phase} once-flow start (job=${job.label})\n`);
        if(mainWindow) mainWindow.webContents.send('pool-once-flow', { phase, job: job.label, state: 'start' });
        const proc = spawn(process.execPath, [runnerPath, credPath], { stdio:['ignore','pipe','pipe'], env });
        proc.stdout.on('data', d => logStream.write(`[OUT] ${String(d)}`));
        proc.stderr.on('data', d => logStream.write(`[ERR] ${String(d)}`));
        proc.on('close', code => {
          logStream.write(`[${new Date().toISOString()}] ${phase} once-flow exit code=${code}\n`); logStream.end();
          try { fs.unlinkSync(runnerPath); } catch {}
          try { fs.unlinkSync(credPath); } catch {}
          if(mainWindow) mainWindow.webContents.send('pool-once-flow', { phase, job: job.label, state: 'done', ok: code===0 });
          resolve({ ok: code===0 });
        });
      };
      finish();
    }catch(e){ resolve({ ok:false, error:e.message }); }
  });
}

// Run all once-flows for a phase per the active scope. 'global' runs each DISTINCT flow once
// across the pool; 'per-job' runs each job's flow once. Returns when all have completed.
async function coordRunOnceFlows(phase){
  if(COORD.setupScope === 'per-worker') return; // workers handle it
  const jobs = Array.from(COORD.jobs.values());
  if(COORD.setupScope === 'global'){
    // De-dupe by (flowId + profileId) so a shared setup runs only once.
    const seen = new Set(); const targets = [];
    for(const job of jobs){
      const flowId = phase === 'setup' ? job.setupFlowId : job.teardownFlowId;
      if(!flowId) continue;
      const key = flowId + '|' + job.profileId;
      if(seen.has(key)) continue; seen.add(key); targets.push(job);
    }
    for(const job of targets){ await coordRunOnceFlow(job, phase); }
  } else { // per-job
    for(const job of jobs){ await coordRunOnceFlow(job, phase); }
  }
}

// ── AUTO UPDATE ───────────────────────────────────────────────────────────────
function fetchJSON(url, redirects) {
  redirects = redirects || 0;
  return new Promise((res, rej) => {
    if (redirects > 5) return rej(new Error('Too many redirects'));
    (url.startsWith('https') ? https : http).get(url, r => {
      if ([301,302,307,308].includes(r.statusCode) && r.headers.location) {
        r.resume();
        return res(fetchJSON(r.headers.location, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode + ' fetching ' + url)); }
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
      r.on('error', rej);
    }).on('error', rej);
  });
}
function downloadFile(url, dest, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    (url.startsWith('https') ? https : http).get(url, r => {
      // Follow redirects (GitHub release downloads always 302 to a CDN URL)
      if ([301,302,307,308].includes(r.statusCode) && r.headers.location) {
        r.resume();
        return resolve(downloadFile(r.headers.location, dest, redirects + 1));
      }
      if (r.statusCode !== 200) {
        r.resume();
        return reject(new Error('HTTP ' + r.statusCode + ' downloading ' + url));
      }
      const tot = parseInt(r.headers['content-length'] || '0');
      let recv = 0;
      const f = fs.createWriteStream(dest);
      r.on('data', c => { recv += c.length; if (tot > 0 && mainWindow) mainWindow.webContents.send('update-progress', Math.round(recv/tot*100)); });
      r.pipe(f);
      f.on('finish', () => f.close(err => {
        if (err) return reject(err);
        // Sanity check: refuse files smaller than 1 MB — almost certainly an error page, not a real installer
        try {
          const stat = fs.statSync(dest);
          if (stat.size < 1024 * 1024) { try { fs.unlinkSync(dest); } catch{} return reject(new Error('Downloaded file is only ' + stat.size + ' bytes — likely not a valid installer.')); }
        } catch(e) { return reject(e); }
        resolve();
      }));
      f.on('error', err => { try { fs.unlinkSync(dest); } catch{} reject(err); });
      r.on('error', reject);
    }).on('error', reject);
  });
}
function semverGt(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if((pa[i]||0)>(pb[i]||0)) return true; if((pa[i]||0)<(pb[i]||0)) return false; }
  return false;
}
async function checkForUpdates(manual) {
  if (VERSION_URL.includes('YOUR_HOST')) { if (manual) mainWindow.webContents.send('update-status', { type: 'not-configured' }); return; }
  try {
    const info = await fetchJSON(VERSION_URL);
    if (semverGt(info.version, CURRENT_VERSION)) mainWindow.webContents.send('update-available', info);
    else if (manual) mainWindow.webContents.send('update-status', { type: 'up-to-date', version: CURRENT_VERSION });
  } catch(e) { if (manual) mainWindow.webContents.send('update-status', { type: 'error', message: e.message }); }
}
ipcMain.handle('check-for-updates', () => checkForUpdates(true));
ipcMain.handle('install-update', async (_, { downloadUrl }) => {
  const updateDir = path.join(app.getPath('userData'), 'updates');
  if (!fs.existsSync(updateDir)) fs.mkdirSync(updateDir, { recursive: true });
  const tmp = path.join(updateDir, 'buu-update.exe');
  try {
    await downloadFile(downloadUrl, tmp);
    // Strip Zone.Identifier so SmartScreen doesn't block it
    try {
      const { execFileSync } = require('child_process');
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Unblock-File -Path '${tmp}'`
      ]);
    } catch {}
    shell.openPath(tmp);
    setTimeout(() => app.quit(), 2000);
    return { ok: true };
  }
  catch(e) { return { ok: false, error: e.message }; }
});

// ── FILE I/O ──────────────────────────────────────────────────────────────────
ipcMain.handle('open-spreadsheet', async () => {
  const lastDir = (readConfig() || {}).lastSpreadsheetDir;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open spreadsheet',
    filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile'],
    ...(lastDir ? { defaultPath: lastDir } : {})
  });
  if (r.canceled) return null;
  const fp = r.filePaths[0];
  try { writeConfig({ lastSpreadsheetDir: path.dirname(fp) }); } catch {}
  const XLSX = require('xlsx');
  const ext = fp.split('.').pop().toLowerCase();
  let headers = [], previewRows = [], totalRows = 0;
  if (ext === 'csv') {
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    previewRows = lines.slice(1, 9).map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
    totalRows = lines.length - 1;
  } else {
    const wb = XLSX.readFile(fp, { sheetRows: 10 });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    headers = (raw[0] || []).map(String).filter(Boolean);
    previewRows = raw.slice(1).filter(r => r.some(c => c !== ''));
    const wb2 = XLSX.readFile(fp);
    totalRows = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]]).length;
  }
  return { filePath: fp, name: path.basename(fp), headers, previewRows, totalRows };
});

ipcMain.handle('save-flow', async (_, { json, name }) => {
  const defaultName = (name || 'buu-flow') + '.json';
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Save flow',
    defaultPath: path.join(getFlowsDir(), defaultName),
    filters: [{ name: 'BUU Flow', extensions: ['json'] }]
  });
  if (r.canceled) return null;
  // v1.2.8.1 hotfix: the filename is the source of truth for a flow's display name.
  // Earlier behavior set `name` from a fallback chain that defaulted to 'buu-flow' when
  // both the in-memory flowName and the flowNotes UI field were empty — which is every
  // time the user creates a fresh flow, because there's no UI to enter a name. The
  // resulting JSON had `name: "buu-flow"` regardless of what filename the user picked
  // in the Save dialog, so the dropdown showed every once-flow as "buu-flow".
  //
  // Fix: derive `name` from the chosen filename's stem and rewrite the JSON before
  // writing. This is one-way: the renderer-supplied name in JSON is discarded.
  try {
    const parsed = JSON.parse(json);
    parsed.name = path.basename(r.filePath, '.json');
    json = JSON.stringify(parsed, null, 2);
  } catch (e) {
    // If JSON is unparseable we have bigger problems, but don't lose the save —
    // write whatever the renderer sent and let load surface the error later.
    console.warn('[save-flow] could not rewrite name field:', e.message);
  }
  fs.writeFileSync(r.filePath, json);
  return r.filePath;
});
ipcMain.handle('load-flow', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Load flow',
    defaultPath: getFlowsDir(),
    filters: [{ name: 'BUU Flow', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8');
});

// v1.2.8: scan the flows directory for once-flows. Returns [{name, filePath, runMode}].
// Used by the renderer to populate setup/teardown dropdowns.
// Tolerant of malformed JSON: bad files are skipped (logged once per call), not surfaced
// as errors — the renderer dropdown should always work even if a stray file is corrupt.
ipcMain.handle('list-once-flows', async () => {
  const dir = getFlowsDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json'));
  } catch (e) {
    return { ok: false, error: 'Cannot read flows directory: ' + e.message, flows: [] };
  }
  const results = [];
  const errors = [];
  for (const filename of entries) {
    const fp = path.join(dir, filename);
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      // Pre-v1.1 flows have no runMode; they're implicitly 'per-row' and excluded here.
      if (data.runMode === 'once') {
        // v1.2.8.1 hotfix: prefer filename over data.name. Older saves stamped `name` as
        // the literal string 'buu-flow' for every flow (no UI to enter a name; fallback
        // chain bottomed out at the literal). Filename is the user's intentional choice
        // from the Save dialog and is always meaningful.
        results.push({
          name: filename.replace(/\.json$/i, ''),
          filename,
          filePath: fp,
          runMode: 'once'
        });
      }
    } catch (e) {
      errors.push({ filename, error: e.message });
    }
  }
  if (errors.length) {
    console.warn('[list-once-flows] skipped malformed files:', errors);
  }
  return { ok: true, flows: results, skipped: errors.length };
});

// v1.2.8: given a flow JSON (or its parsed form), check that referenced setup/teardown
// flows exist on disk and have runMode === 'once'. Returns [{field, ref, status, msg}].
// status is 'ok' | 'missing' | 'wrong-mode' | 'not-applicable'.
// Used by renderer's pre-run validation to catch dangling references.
ipcMain.handle('validate-flow-references', async (_, { flow }) => {
  const issues = [];
  // Once-flows shouldn't have either field set; renderer already flags that as an error
  // before we get here, but be safe.
  if (flow && flow.runMode === 'once') {
    return { ok: true, issues: [] };
  }
  const checkOne = (field, ref) => {
    if (!ref) {
      issues.push({ field, ref: null, status: 'not-applicable', msg: '' });
      return;
    }
    const dir = getFlowsDir();
    let found = null;
    let foundFile = null;
    try {
      for (const filename of fs.readdirSync(dir)) {
        if (!filename.toLowerCase().endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8'));
          // v1.2.8.1 hotfix: match by filename stem only (same reason as resolveOnceFlowByName).
          const candName = filename.replace(/\.json$/i, '');
          if (candName === ref) {
            found = data;
            foundFile = filename;
            break;
          }
        } catch { /* skip malformed */ }
      }
    } catch (e) {
      issues.push({ field, ref, status: 'missing', msg: 'Cannot read flows directory: ' + e.message });
      return;
    }
    if (!found) {
      issues.push({ field, ref, status: 'missing', msg: 'Flow "' + ref + '" not found in flows directory.' });
      return;
    }
    if (found.runMode !== 'once') {
      issues.push({ field, ref, status: 'wrong-mode', msg: 'Flow "' + ref + '" exists but is not a once-flow (runMode = ' + (found.runMode || 'per-row') + ').' });
      return;
    }
    issues.push({ field, ref, status: 'ok', msg: '', filename: foundFile });
  };
  checkOne('setupFlowId', flow ? flow.setupFlowId : null);
  checkOne('teardownFlowId', flow ? flow.teardownFlowId : null);
  return { ok: true, issues };
});
ipcMain.handle('open-flows-folder', () => shell.openPath(getFlowsDir()));
ipcMain.handle('open-log-folder', () => shell.openPath(getLogsDir()));
ipcMain.handle('open-file', (_, p) => shell.openPath(p));
ipcMain.handle('get-version', () => CURRENT_VERSION);
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

// ── TASKBAR PIN (v2.1.0 #1) ───────────────────────────────────────────────────
// On first packaged launch, offer to pin BUU 2.0 to the taskbar. Windows has no official
// pin API, so we use the classic Shell.Application verb on the Start-Menu shortcut. That verb
// is localized and was removed/blocked on many Windows 11 builds (22H2+), so this is strictly
// best-effort: it must NEVER block startup, throw, or nag. We ask at most once and persist the
// outcome in config (pinPromptDone), so a "No" — or a build where pinning is impossible — is
// remembered and never asked again. Detection: scan the User Pinned\TaskBar folder for a .lnk
// whose target resolves to our exe.

// The actual helper script. It prints a single status token on the last line:
function buildPinHelperScript(exePath, appName) {
  const esc = s => String(s).replace(/'/g, "''");
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$exe = '${esc(exePath)}'`,
    `$appName = '${esc(appName)}'`,
    '$exeLeaf = Split-Path $exe -Leaf',
    '$pinDir = Join-Path $env:APPDATA "Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"',
    '$sh = New-Object -ComObject WScript.Shell',
    '# 1) Detection: is a shortcut targeting our exe already pinned?',
    'if (Test-Path $pinDir) {',
    '  $existing = Get-ChildItem -Path $pinDir -Filter *.lnk -ErrorAction SilentlyContinue',
    '  foreach ($lnk in $existing) {',
    '    $t = $sh.CreateShortcut($lnk.FullName).TargetPath',
    '    if ($t -and ($t -ieq $exe -or (Split-Path $t -Leaf) -ieq $exeLeaf)) { Write-Output "already-pinned"; exit 0 }',
    '  }',
    '}',
    '# 2) Find the Start-Menu shortcut to pin (pinning a .lnk is more reliable than the raw exe).',
    '$startMenu = [Environment]::GetFolderPath("Programs")',
    '$lnkPath = $null',
    'if (Test-Path $startMenu) {',
    '  $cand = Get-ChildItem -Path $startMenu -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |',
    '    Where-Object { $t = $sh.CreateShortcut($_.FullName).TargetPath; $t -and ((Split-Path $t -Leaf) -ieq $exeLeaf) } |',
    '    Select-Object -First 1',
    '  if ($cand) { $lnkPath = $cand.FullName }',
    '}',
    '$target = if ($lnkPath) { $lnkPath } else { $exe }',
    '# 3) Invoke the localized "Pin to taskbar" shell verb via Shell.Application.',
    '$shell = New-Object -ComObject Shell.Application',
    '$folder = $shell.Namespace((Split-Path $target -Parent))',
    '$item = $folder.ParseName((Split-Path $target -Leaf))',
    '$verb = $null',
    'foreach ($v in $item.Verbs()) {',
    '  $n = $v.Name -replace "&",""',
    '  if ($n -match "taskbar" -or $n -match "Taskbar") { $verb = $v; break }',
    '}',
    'if ($verb) { $verb.DoIt(); Start-Sleep -Milliseconds 600; Write-Output "pinned"; exit 0 }',
    'Write-Output "cannot-pin"; exit 0',
  ].join("\r\n");
}

function recordPinOutcome(outcome) {
  try { writeConfig({ pinPromptDone: true, pinOutcome: outcome, pinPromptAt: new Date().toISOString() }); } catch {}
}

async function maybePinToTaskbar() {
  try {
    // Dev runs have no installed exe/Start-Menu shortcut — skip entirely.
    if (!app.isPackaged || process.platform !== 'win32') return;
    const cfg = readConfig();
    if (cfg && cfg.pinPromptDone) return; // already asked once (Yes, No, or impossible) — never nag.

    const exePath = process.execPath; // the installed BUU 2.0 .exe
    // Ask permission (non-blocking to the app — we await the dialog, but the window is already shown).
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Pin to taskbar', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      title: 'Pin BUU 2.0?',
      message: 'Pin BUU 2.0 to your taskbar?',
      detail: 'This adds a one-click shortcut on your Windows taskbar. You can unpin it any time by right-clicking the icon.',
      noLink: true,
    });
    if (response !== 0) { recordPinOutcome('declined'); return; } // remembered — won't ask again.

    // Write the helper to a temp .ps1 and run it detached. -File avoids -Command quoting issues.
    const ps1 = path.join(os.tmpdir(), `buu-pin-${Date.now()}.ps1`);
    try { fs.writeFileSync(ps1, buildPinHelperScript(exePath, 'BUU 2.0'), 'utf8'); }
    catch (e) { recordPinOutcome('error'); return; }

    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        const out = String(stdout || '').trim().split(/\r?\n/).pop() || '';
        const outcome = err ? 'error' : (out || 'unknown');
        recordPinOutcome(outcome);
        try { fs.unlinkSync(ps1); } catch {}
        try { console.log('[main] taskbar pin outcome: ' + outcome); } catch {}
      }
    );
  } catch (e) {
    // Absolutely never let pinning break startup.
    try { recordPinOutcome('error'); } catch {}
  }
}

// ── WINDOW ────────────────────────────────────────────────────────────────────
function getIconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'assets', 'icon.ico');
  return path.join(__dirname, '..', 'assets', 'icon.ico');
}

function createWindow() {
  const iconPath = getIconPath();
  // v1.3.x: size the window relative to the user's actual screen instead of a fixed pixel
  // size. Use 85% of the primary display's work area (screen minus taskbar), so the window
  // is proportionally large on any monitor and never opens bigger than the display. Floors
  // keep it usable on very small screens. workAreaSize is valid here because createWindow
  // runs from app.whenReady().
  const { width: scrW, height: scrH } = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.max(1000, Math.round(scrW * 0.85));
  const winH = Math.max(680, Math.round(scrH * 0.85));
  mainWindow = new BrowserWindow({
    width: winW, height: winH, minWidth: 1000, minHeight: 680,
    icon: iconPath,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    backgroundColor: '#0f0f11', show: false, title: 'BUU 2.0'
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // v1.3.1 Item 6 (real fix): the per-class CSS font bumps didn't visibly change anything
  // because nearly every element in index.html pins its own px font-size, so bumping `body`
  // never cascaded. Native Chromium zoom scales the ENTIRE rendered UI uniformly — fonts,
  // padding, icons — regardless of inheritance. This is the reliable "make everything bigger"
  // lever. Applied on did-finish-load because setZoomFactor before the page loads gets reset.
  // 1.35 = 35% larger. Adjust this single number to taste.
  mainWindow.webContents.on('did-finish-load', () => {
    try { mainWindow.webContents.setZoomFactor(1.35); } catch (e) {}
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    checkForUpdates(false);
    // v2.1.0 (#1): offer to pin to the taskbar on first packaged launch. Delayed so the window
    // is settled and we don't stack a dialog on top of the update banner. Best-effort, never blocks.
    setTimeout(() => { maybePinToTaskbar(); }, 1500);
  });
  mainWindow.setMenuBarVisibility(false);
}
// Single instance lock — prevent opening a second window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // v2.0.0: force a stable distinct app name so userData resolves to a BUU-2-specific folder
  // (%APPDATA%\BUU 2.0) in BOTH dev and packaged runs — fully isolated from Legacy's data.
  try { app.setName('BUU 2.0'); } catch(e){}
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.setAppUserModelId('com.entomobands.buu-2');
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
