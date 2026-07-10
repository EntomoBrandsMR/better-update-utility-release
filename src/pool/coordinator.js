// pool/coordinator.js — pool coordinator: queue, worker lifecycle, scaling, sweeps,
// journal writers (journal fns move to src/journal.js in E6). Moved VERBATIM from
// main.js — Phase 2 refactor, 2026-07-10. Wired by main.js at load via wireCoordinator(ctx):
// stable bindings destructured once; reassigned bindings (e.g. mainWindow) read live as ctx.<n>.
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { app } = require('electron');
const { spawn } = require('child_process');

module.exports = function wireCoordinator(ctx) {
const { SERVICE_NAME, MAX_WORKERS_HARD_CEILING, loadRowsForJob, getLogsDir, encStore, readAllProfiles, readConfig, getBundledChromiumPath, licenseReaderLogout, resolveOnceFlowByName, buildPoolWorker, buildLogoutSweeper, buildOnceFlowRunner } = ctx;

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
const { coordJournalPath, coordJournalMetaPath, coordJournalDonePath, coordOpenJournal, coordMarkPhaseProgress, coordJournalAppend, coordJournalAppendDialog, coordCloseJournal, coordMarkJournalDone, coordMostRecentJournalPoolId } = require('../journal')({ COORD });


// Phase 2: journal writer/reader fns live in src/journal.js (wired below COORD).
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
  if(!ctx.mainWindow) return;
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
    // v2.2.3 Session 3F (B2): expose the source spreadsheet path so the renderer can offer
    // an Archive button (move to upcoming/Finished/) on completed jobs.
    spreadsheetPath: j.spreadsheetPath || null,
  }));
  const workers = Array.from(COORD.workers.values()).map(w => ({
    workerId: w.workerId, jobId: w.jobId, status: w.status,
    done: w.done, ok: w.ok, err: w.err, skip: w.skip, batchSize: (w.batch||[]).length,
    // v2.1.0 live detail: current row, position in batch, step in flow, logout result
    currentRow: w.currentRow, batchPos: w.batchPos, batchTotal: w.batchSize,
    step: w.step, totalSteps: w.totalSteps, loggedOut: w.loggedOut,
  }));
  ctx.mainWindow.webContents.send('pool-status', {
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
  if (ctx.keytar) {
    prof.companyKey = await ctx.keytar.getPassword(SERVICE_NAME, `${job.profileId}:companyKey`) || prof.companyKey || '';
    prof.username   = await ctx.keytar.getPassword(SERVICE_NAME, `${job.profileId}:username`)   || prof.username   || '';
    prof.password   = await ctx.keytar.getPassword(SERVICE_NAME, `${job.profileId}:password`)   || prof.password   || '';
  }
  const credPath = path.join(os.tmpdir(), `buu2-cred-${workerId}.enc`);
  fs.writeFileSync(credPath, encStore([prof]));

  const runnerPath = path.join(os.tmpdir(), `buu2-worker-${workerId}.js`);
  const logPath = path.join(getLogsDir(), `BUU2-log-${new Date().toISOString().slice(0,10)}-${workerId}.xlsx`);
  const runnerLogPath = path.join(getLogsDir(), `buu2-worker-${workerId}.log`);
  const runnerLogStream = fs.createWriteStream(runnerLogPath, { flags: 'a' });

  // v2.2.3 Session 3C (A1): diagnostic capture directory. One per pool run, under logsDir.
  // The directory is created lazily by the worker on first capture (mkdir recursive). All
  // workers in the same pool share the same dir; row folders are per-row so no collision.
  const captureDir = COORD.diagnosticCapture && COORD.poolId
    ? path.join(getLogsDir(), 'failures-' + COORD.poolId)
    : null;

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
    // v2.2.3 Session 3C (A1): diagnostic capture config (forwards to worker template).
    diagnosticCapture: !!COORD.diagnosticCapture,
    captureDir: captureDir,
    captureBucketCap: COORD.captureBucketCap || 10,
    // v2.2.3 Session 3D (A2): verify-after-action toggle.
    verifyAfterAction: !!COORD.verifyAfterAction,
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
      if (ctx.mainWindow) ctx.mainWindow.webContents.send('pool-pause', {
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
      if (ctx.mainWindow) ctx.mainWindow.webContents.send('pool-pause', {
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
      if (ctx.mainWindow) ctx.mainWindow.webContents.send('pool-dialog', {
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
      // v2.2.7: Frankware order scrape -> stream to the run CSV as results arrive (crash-safe).
      // An empty array means the scrape step ran but the account had no orders -> note it.
      // The persistent run-setting "scrapeCsvEnabled" (config) gates the WRITE only — the scrape
      // still runs either way, so unchecking it is a dry run. Read once per job and cached.
      if(job && Array.isArray(msg.scrape)){
        if(job.scrapeCsvEnabled===undefined){ try{ const c=readConfig(); job.scrapeCsvEnabled = !(c && c.scrapeCsvEnabled===false); }catch(e){ job.scrapeCsvEnabled=true; } }
        if(msg.scrape.length){ if(job.scrapeCsvEnabled) coordAppendScrape(job, msg.scrape); }
        else console.warn('[coord] Frankware scrape: row '+msg.row+' returned 0 orders');
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
    if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-complete', {
      jobs: Array.from(COORD.jobs.values()).map(j => ({ jobId:j.jobId, label:j.label, totalRows:j.totalRows, ok:j.ok, err:j.err, skip:j.skip })),
    });
    // v2.1.1 (#8): for per-job/global scope, run teardown ONCE now (coordinator-driven), THEN
    // sweep. v2.1.1 logout sweep is the authoritative backstop and runs regardless of scope.
    (async () => {
      // v2.2.0: write any read-field results to dedicated per-job workbooks first.
      try { coordWriteReadResults(); } catch(e){ console.error('[coord] read-results write failed:', e.message); }
      if(COORD.setupScope !== 'per-worker'){
        if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-once-flow', { phase:'teardown', state:'phase-start', scope:COORD.setupScope });
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
      if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-read-results', { path: outPath, rows: sorted.length, columns: cols });
    } catch(e){ console.error('[coord] failed writing read-results for job', job.label, e.message); }
  }
}

// Helper: load a job's source spreadsheet rows as objects (coordinator-side, for read-results).
// v2.2.7: Frankware order scrape -> streaming CSV. Appended as each row-result arrives so a
// crash keeps everything already written to disk. Dedupe on Property # + Order ID (an order
// can't legitimately repeat for the same property). Header written once. Columns: PP data
// (stamped from the run sheet) first, then the scraped Frankware fields. Path/timestamp/flow
// naming mirrors the read-results workbook; computed once per job and reused for every append.
function coordAppendScrape(job, rows){
  if(!job || !Array.isArray(rows) || !rows.length) return;
  try{
    if(!job.scrapeCsvPath){
      const RESULTS_DIR = path.join(path.dirname(job.spreadsheetPath || process.cwd()), 'results');
      try{ fs.mkdirSync(RESULTS_DIR, { recursive:true }); }catch(e){}
      const now = new Date();
      const mm = String(now.getMonth()+1).padStart(2,'0'), dd = String(now.getDate()).padStart(2,'0'), yyyy = now.getFullYear();
      const hh = String(now.getHours()).padStart(2,'0'), mi = String(now.getMinutes()).padStart(2,'0');
      const safeFlow = String(job.label || 'flow').replace(/[\\/:*?"<>|]/g,'_').replace(/\.xlsx?$/i,'').slice(0,60);
      job.scrapeCsvPath = path.join(RESULTS_DIR, `${mm}${dd}${yyyy}_${hh}${mi}_${safeFlow}_frankware-orders.csv`);
      job.scrapeSeen = new Set();
      job.scrapeCount = 0;
      job.scrapeDupes = 0;
    }
    const esc = v => { const s = (v==null ? '' : String(v)); return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
    let out = '';
    if(!fs.existsSync(job.scrapeCsvPath)){
      out += ['PP Location Code','PP Invoice #','Frankware Property #','Frankware Order ID','Frankware Service','Frankware Status','Frankware Price','Frankware Balance','Frankware Write-off'].map(esc).join(',') + '\r\n';
    }
    for(const o of rows){
      const key = (o.prop||'') + '|' + (o.orderId||'');
      if(o.orderId && job.scrapeSeen.has(key)){ job.scrapeDupes++; console.warn('[coord] Frankware scrape: duplicate skipped property='+(o.prop||'')+' order='+(o.orderId||'')); continue; }
      if(o.orderId) job.scrapeSeen.add(key);
      out += [o.loc, o.inv, o.prop, o.orderId, o.service, o.status, (o.price===''?'':o.price), (o.balance===''?'':o.balance), o.writeOff].map(esc).join(',') + '\r\n';
      job.scrapeCount++;
    }
    if(out) fs.appendFileSync(job.scrapeCsvPath, out, 'utf8');
  }catch(e){ console.error('[coord] Frankware scrape CSV append failed for job', job && job.label, e.message); }
}

// v1.3.4 Phase 3: license-aware cap. Launches a headless browser with the given profile,
async function coordRunLogoutSweep(reason){
  if(COORD.sweepRunning) return;
  COORD.sweepRunning = true;
  try{
    const chromiumExe = getBundledChromiumPath();
    if(!chromiumExe){ if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-sweep-result',{ok:false,error:'chromium not found'}); COORD.sweepRunning=false; return; }
    // Pick a profile used this run (fall back to any job's profile).
    let profileId = Array.from(COORD.usedProfileIds)[0];
    if(!profileId){ const firstJob = Array.from(COORD.jobs.values())[0]; profileId = firstJob && firstJob.profileId; }
    if(!profileId){ if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-sweep-result',{ok:false,error:'no profile available for sweep'}); COORD.sweepRunning=false; return; }

    // Login steps: reuse the locked login portion of any job's flow (same as workers use).
    const anyJob = Array.from(COORD.jobs.values()).find(j => Array.isArray(j.flowSteps) && j.flowSteps.length) || {};
    const loginSteps = (anyJob.flowSteps || []).filter(s => s.locked || s.type === 'pestpac-login');

    // Resolve creds for that profile (ctx.keytar with profile fallback), mirror of coordSpawnWorker.
    const all = readAllProfiles();
    const prof = all.find(p => p.id === profileId) || {};
    if (ctx.keytar) {
      prof.companyKey = await ctx.keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
      prof.username   = await ctx.keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
      prof.password   = await ctx.keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
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
    if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-sweep-start', { reason });

    const proc = spawn(process.execPath, [runnerPath, credPath], { stdio:['ignore','pipe','pipe'], env });
    let lastResult = null;
    proc.stdout.on('data', d => {
      String(d).split('\n').filter(Boolean).forEach(line => {
        sweepLog.write(`[OUT] ${line}\n`);
        let msg; try{ msg = JSON.parse(line); }catch{ return; }
        if(msg.type === 'sweep-pass' || msg.type === 'sweep-done') lastResult = msg;
        if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-sweep-progress', msg);
      });
    });
    proc.stderr.on('data', d => sweepLog.write(`[ERR] ${String(d)}\n`));
    proc.on('close', code => {
      sweepLog.write(`[${new Date().toISOString()}] sweep exited code=${code}\n`); sweepLog.end();
      try { fs.unlinkSync(runnerPath); } catch {}
      try { fs.unlinkSync(credPath); } catch {}
      COORD.sweepRunning = false;
      const remaining = lastResult && lastResult.remaining != null ? lastResult.remaining : (code===0?0:null);
      if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-sweep-result', { ok: code===0, remaining, loggedOut: lastResult && lastResult.loggedOut });
    });
  }catch(e){
    COORD.sweepRunning = false;
    if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-sweep-result',{ ok:false, error:e.message });
  }
}

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
  if (ctx.keytar) {
    prof.companyKey = await ctx.keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
    prof.username   = await ctx.keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
    prof.password   = await ctx.keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
  }
  let browser;
  try {
    const { chromium } = require('playwright-core');
    browser = await chromium.launch({ headless: true, executablePath: chromiumExe, args: ['--disable-gpu','--disable-dev-shm-usage'] });
    const page = await (await browser.newContext()).newPage();
    // Login via the shared canonical helper (drift-proof; also platform-aware).
    // Replaces the old inline copy the v2.2.2 refactor missed (check-license-cap
    // was converted, this recheck path was not). Behavior identical for PestPac.
    await loginToPestPacInPage(page, { loginUrl: prof.loginUrl, companyKey: prof.companyKey, username: prof.username, password: prof.password, platform: prof.platform });
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
    if (ctx.mainWindow) ctx.mainWindow.webContents.send('pool-license-update', { freeLicenses: free, buffer: BUF, newTarget, liveWorkers: COORD.workers.size });
    COORD.desiredWorkers = newTarget;
    await coordScaleTo(newTarget);
  } catch (e) {
    try { if (browser) await browser.close(); } catch(_){}
    if (ctx.mainWindow) ctx.mainWindow.webContents.send('pool-license-update', { error: e.message });
  }
}



// ── AUTOMATION RUNNER ─────────────────────────────────────────────────────────
// v1.2.8: resolve a flow by its `name` field. Scans the flows directory, matches by
// `name` first then by filename stem. Returns the parsed flow or null if not found
// (caller decides whether that's an error).
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
        if (ctx.keytar) {
          prof.companyKey = await ctx.keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
          prof.username   = await ctx.keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
          prof.password   = await ctx.keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
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
        if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-once-flow', { phase, job: job.label, state: 'start' });
        const proc = spawn(process.execPath, [runnerPath, credPath], { stdio:['ignore','pipe','pipe'], env });
        proc.stdout.on('data', d => logStream.write(`[OUT] ${String(d)}`));
        proc.stderr.on('data', d => logStream.write(`[ERR] ${String(d)}`));
        proc.on('close', code => {
          logStream.write(`[${new Date().toISOString()}] ${phase} once-flow exit code=${code}\n`); logStream.end();
          try { fs.unlinkSync(runnerPath); } catch {}
          try { fs.unlinkSync(credPath); } catch {}
          if(ctx.mainWindow) ctx.mainWindow.webContents.send('pool-once-flow', { phase, job: job.label, state: 'done', ok: code===0 });
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

return { COORD, coordJournalPath, coordJournalMetaPath, coordOpenJournal, coordMarkPhaseProgress, coordJournalAppend, coordJournalAppendDialog, coordCloseJournal, coordJournalDonePath, coordMarkJournalDone, coordFindOrphanPools, coordNextBatch, coordAllDrained, coordEmitStatus, coordPickJobForWorker, coordSpawnWorker, coordHandleWorkerMessage, coordCheckComplete, coordWriteReadResults, coordAppendScrape, coordRunLogoutSweep, coordMostRecentJournalPoolId, coordScaleTo, coordLicenseScale, coordRunOnceFlow, coordRunOnceFlows };
};
