const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const CURRENT_VERSION = '2.2.0';
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
const automationProcesses = new Map();
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
    const meta = {
      poolId: COORD.poolId,
      batchSize: COORD.batchSize,
      startedAt: new Date().toISOString(),
      jobs: Array.from(COORD.jobs.values()).map(j => ({
        jobId: j.jobId, label: j.label, spreadsheetPath: j.spreadsheetPath,
        profileId: j.profileId, setupFlowId: j.setupFlowId, teardownFlowId: j.teardownFlowId,
        errHandle: j.errHandle, totalRows: j.totalRows, flowSteps: j.flowSteps,
      })),
    };
    fs.writeFileSync(coordJournalMetaPath(COORD.poolId), JSON.stringify(meta));
    COORD.journalStream = fs.createWriteStream(coordJournalPath(COORD.poolId), { flags: 'a' });
  }catch(e){ console.error('[coord] could not open journal:', e.message); COORD.journalStream = null; }
}

// Append one completed-row record. Called on every row-result BEFORE updating counters, so
// the durable record always precedes the in-memory state. One short line; OS-atomic for small writes.
function coordJournalAppend(jobId, row, status){
  if(!COORD.journalStream) return;
  try{ COORD.journalStream.write(JSON.stringify({ j: jobId, r: row, s: status }) + '\n'); }catch(e){}
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
        for(const line of lines){ if(!line) continue; try{ const rec = JSON.parse(line); (completedByJob[rec.j] = completedByJob[rec.j] || new Set()).add(rec.r); }catch{} }
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
function coordPickJobForWorker(){
  for(const job of COORD.jobs.values()){
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
    selectorTimeout: 30, pageLoadMode: 'domcontentloaded', retryCount: 2,
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
    COORD.workers.delete(workerId);
    try { fs.unlinkSync(runnerPath); } catch {}
    try { fs.unlinkSync(credPath); } catch {}
    coordEmitStatus();
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
    case 'shutting-down':
      w.status = 'shutting-down';
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
        try { await coordRunOnceFlows('teardown'); } catch(e) { console.error('[coord] teardown once-flows error:', e.message); }
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
    runningWorkers: automationProcesses.size,
  };
});

// v1.3.4 Phase 3: license-aware cap. Launches a headless browser with the given profile,
// logs in, reads PestPac's license page, parses "Number of free licenses:", and returns
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
    // Login (mirrors the runner's loginToPestPac sequence).
    await page.goto(prof.loginUrl || 'https://login.pestpac.com/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('input[name="uid"]', { timeout: 15000 });
    await page.fill('input[name="uid"]', prof.companyKey || '');
    try { await page.waitForSelector('.MuiBackdrop-root', { state: 'hidden', timeout: 12000 }); } catch {}
    try { await page.click('button[data-testid="CompanyKeyForm-loginBtn"]', { timeout: 15000 }); }
    catch { await page.click('button[data-testid="CompanyKeyForm-loginBtn"]', { force: true }); }
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.fill('input[name="username"]', prof.username || '');
    await page.fill('input[name="password"]', prof.password || '');
    // v2.1.1a: PestPac shows a MUI loading backdrop over the form that intercepts the login
    // click (Playwright reports "<div class=MuiBackdrop-root> intercepts pointer events" and
    // times out). Wait for any backdrop to clear before clicking; fall back to a forced click.
    try { await page.waitForSelector('.MuiBackdrop-root', { state: 'hidden', timeout: 12000 }); } catch {}
    try { await page.click('button[data-testid="loginBtn"]', { timeout: 15000 }); }
    catch { await page.click('button[data-testid="loginBtn"]', { force: true }); }
    await page.waitForSelector('a[href*="AutoLogin"]', { timeout: 30000 });
    // Navigate to the license page and read the free-licenses cell.
    await page.goto('https://app.pestpac.com/license.asp?Mode=View', { waitUntil: 'load', timeout: 30000 });
    // The label cell is <td ...>Number of free licenses:</td>; the value is the NEXT cell.
    const freeText = await page.evaluate(() => {
      const tds = Array.from(document.querySelectorAll('td'));
      for (const td of tds) {
        if ((td.textContent || '').trim().toLowerCase().startsWith('number of free licenses')) {
          // value is usually the adjacent sibling cell
          const sib = td.nextElementSibling;
          if (sib) return (sib.textContent || '').trim();
        }
      }
      return null;
    });
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
ipcMain.handle('pool-submit-job', async (_, { label, flowSteps, spreadsheetPath, profileId, setupFlowId, teardownFlowId, errHandle, resumeFromRow }) => {
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
  COORD.jobs.set(jobId, {
    jobId, label: label || path.basename(spreadsheetPath),
    flowSteps, spreadsheetPath, profileId,
    setupFlowId: setupFlowId || null, teardownFlowId: teardownFlowId || null,
    errHandle: errHandle || 'retry',
    totalRows: total, nextRow: startRow, startRow,
    done: 0, ok: 0, err: 0, skip: 0, finished: false,
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
ipcMain.handle('pool-start', async (_, { workerCount, batchSize, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin, setupScope }) => {
  if (COORD.active) return { ok: false, error: 'Pool already running.' };
  if (COORD.jobs.size === 0) return { ok: false, error: 'No jobs staged.' };
  // v2.1.1 (#8): setup/teardown scope. 'per-worker' (default) keeps the proven behavior where
  // each worker runs the once-flows for its own session. 'per-job' / 'global' run them ONCE,
  // executed by the coordinator via a dedicated headless session, with workers skipping them.
  COORD.setupScope = (setupScope === 'per-job' || setupScope === 'global') ? setupScope : 'per-worker';
  COORD.batchSize = Math.max(1, Math.min(500, parseInt(batchSize) || 10));
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
    try { await coordRunOnceFlows('setup'); } catch(e) { console.error('[coord] setup once-flows error:', e.message); }
  }

  const hwCap = computeHardwareCap();
  let target = Math.max(1, Math.min(parseInt(workerCount) || 1, MAX_WORKERS_HARD_CEILING, hwCap));
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
  const completedByJob = {};
  if (fs.existsSync(jp)) {
    const lines = fs.readFileSync(jp, 'utf8').split('\n');
    for (const line of lines){ if(!line) continue; try{ const rec=JSON.parse(line); (completedByJob[rec.j]=completedByJob[rec.j]||new Set()).add(rec.r); }catch{} }
  }

  // Rebuild COORD.jobs from meta, pre-seeding completedRows.
  COORD.jobs.clear();
  for (const j of meta.jobs){
    COORD.jobs.set(j.jobId, {
      jobId: j.jobId, label: j.label, flowSteps: j.flowSteps,
      spreadsheetPath: j.spreadsheetPath, profileId: j.profileId,
      setupFlowId: j.setupFlowId, teardownFlowId: j.teardownFlowId,
      errHandle: j.errHandle, totalRows: j.totalRows,
      nextRow: 1, done: 0, ok: 0, err: 0, skip: 0, finished: false,
      completedRows: completedByJob[j.jobId] || new Set(),
    });
  }
  // Seed counters from the completed sets so the UI shows real progress immediately.
  for (const job of COORD.jobs.values()){ job.done = job.completedRows.size; }

  COORD.batchSize = Math.max(1, Math.min(500, parseInt(batchSize) || meta.batchSize || 10));
  COORD.active = true;
  // Re-open the SAME journal in append mode (continue the continuous record).
  COORD.poolId = poolId;
  try { COORD.journalStream = fs.createWriteStream(jp, { flags: 'a' }); } catch(e){ COORD.journalStream = null; }

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
  const counts = { ok: 0, skip: 0, error: 0, total: 0 };
  try {
    const lines = fs.readFileSync(jp, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
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
  return { ok: true, poolId, jobs: (meta.jobs||[]).map(j=>({jobId:j.jobId,label:j.label})), rows, counts };
});

// Scale the live worker count toward `target`: spawn if below, retire surplus if above.
// Retirement is graceful — surplus workers get 'drain' and finish their current batch.
async function coordScaleTo(target){
  const live = COORD.workers.size;
  if (target > live) {
    let totalRemaining = 0; for (const j of COORD.jobs.values()) totalRemaining += Math.max(0, j.totalRows - (j.nextRow - 1));
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
    const freeText = await page.evaluate(() => {
      const tds = Array.from(document.querySelectorAll('td'));
      for (const td of tds) { if ((td.textContent||'').trim().toLowerCase().startsWith('number of free licenses')) { const s = td.nextElementSibling; if (s) return (s.textContent||'').trim(); } }
      return null;
    });
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

ipcMain.handle('start-automation', async (_, { stepsJson, spreadsheetPath, profileId, headless, runId, resumeFromRow, endRow, errHandle, rowDelayMin, rowDelayMax, selectorTimeout, pageLoadMode, retryCount, breakerThreshold, reauthInterval, retryRowIndexes, startMode, resumeAction, runMode, setupFlowId, teardownFlowId }) => {
  // v1.3.0 Item 3: log every start attempt with state context. Pairs with renderer-side
  // [run] log lines so cross-process traces can be reconstructed after a stuck-state report.
  console.log('[main] start-automation: runId=' + runId + ', profileId=' + profileId + ', resumeFromRow=' + (resumeFromRow||0) + ', currentMapSize=' + automationProcesses.size);
  // startMode: 'step' | 'step-row' | 'run-all'  (added v1.2.4). Defaults to 'run-all' for back-compat.
  startMode = startMode || 'run-all';
  // v1.2.5 item 2.8: tunable speed/resilience settings. Defaults match design doc.
  selectorTimeout = (selectorTimeout != null) ? Math.min(60, Math.max(1, parseInt(selectorTimeout))) : 30;
  pageLoadMode = (pageLoadMode === 'load') ? 'load' : 'domcontentloaded';
  retryCount = (retryCount != null) ? Math.min(20, Math.max(0, parseInt(retryCount))) : 2;
  // v1.2.5 item 2.3b: consecutive-error circuit breaker. 0 = disabled.
  breakerThreshold = (breakerThreshold != null) ? Math.max(0, parseInt(breakerThreshold)) : 20;
  // v1.2.5 item 2.11: re-auth interval in minutes. 0 = disabled. Logic comes in Phase 7.
  reauthInterval = (reauthInterval != null) ? Math.min(480, Math.max(0, parseInt(reauthInterval))) : 120;
  // v1.2.5 item 2.12: retry-failed-rows. When set, runner processes ONLY these row indexes
  // (source-row numbers, 1-based). Empty/null means normal full-run behavior.
  retryRowIndexes = Array.isArray(retryRowIndexes) ? retryRowIndexes.map(n => parseInt(n)).filter(n => n > 0) : [];
  // v1.3.4 Phase 3: worker-pool concurrency guard. Refuse only when the pool is at its
  // effective cap (hardware-derived or config override), not at a hard 1. Each accepted
  // call becomes one worker with its own runId/row-range.
  const _maxRuns = getMaxConcurrentRuns();
  if (automationProcesses.size >= _maxRuns) {
    console.warn('[main] start-automation REJECTED: pool full, size=' + automationProcesses.size + ', cap=' + _maxRuns);
    return { ok: false, error: `Worker pool is full (${automationProcesses.size}/${_maxRuns} running). Wait for a worker to finish or raise the worker limit.` };
  }
  const steps = JSON.parse(stepsJson);
  const logPath = path.join(getLogsDir(), `BUU-log-${new Date().toISOString().slice(0,10)}-${runId}.xlsx`);
  const checkpointPath = path.join(app.getPath('userData'), `checkpoint-${runId}.json`);
  const runnerPath = path.join(os.tmpdir(), `buu-runner-${runId}.js`);
  const credPath = path.join(os.tmpdir(), `buu-cred-${runId}.enc`);

  // Open the runner log FIRST so any pre-spawn failure is captured.
  // (Was opened later — meaning chromium-not-found and other early errors left no trace.)
  const runnerLogPath = path.join(getLogsDir(), `buu-runner-${runId}.log`);
  let runnerLogStream;
  try {
    runnerLogStream = fs.createWriteStream(runnerLogPath, { flags: 'a' });
    runnerLogStream.write(`[${new Date().toISOString()}] start-automation called: runId=${runId} profileId=${profileId} spreadsheetPath=${spreadsheetPath}\n`);
  } catch (e) {
    return { ok: false, error: 'Cannot create runner log file at ' + runnerLogPath + ': ' + e.message };
  }

  // Expanded checkpoint v2 — written once at run start with full context so the run
  // can be resumed even after a crash, restart, or normal stop. The runner only updates
  // rowIndex/ts inside, never overwriting the context fields.
  let totalRowsForCheckpoint = 0;
  try {
    const probe = require('xlsx');
    const ext = path.extname(spreadsheetPath).toLowerCase();
    if (ext === '.csv') {
      totalRowsForCheckpoint = Math.max(0, fs.readFileSync(spreadsheetPath, 'utf8').split('\n').filter(Boolean).length - 1);
    } else {
      const wb = probe.readFile(spreadsheetPath);
      totalRowsForCheckpoint = probe.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).length;
    }
  } catch {}
  try {
    fs.writeFileSync(checkpointPath, JSON.stringify({
      // v1.2.8: bumped from v2 to v3. Added flowMeta (runMode + setup/teardown refs)
      // and phaseProgress (per-phase completion tracking). v2 readers will still
      // load this file (they'll see extra fields and ignore them); v3 readers handle
      // v2 by defaulting setupCompleted=true, teardownCompleted=false.
      schemaVersion: 3,
      runId,
      profileId,
      spreadsheetPath,
      spreadsheetName: path.basename(spreadsheetPath),
      flowSnapshot: steps,
      // v1.2.8: snapshot of the main flow's composition fields so resume knows what
      // setup/teardown flows were in play. Used by the resume modal to show "this run
      // had a teardown that didn't complete — run it now?" and similar.
      flowMeta: {
        runMode: 'per-row',         // v1.2.8 Phase 4: hardcoded; once-flows aren't run-launched yet
        setupFlowId: null,          // Phase 5 wires the real values from the flow JSON
        teardownFlowId: null,
        setupStepCount: 0,
        teardownStepCount: 0,
      },
      // v1.2.8: phase progress tracker. setupCompleted is set true by the runner when
      // setup finishes; teardownCompleted is set true when teardown finishes. mainRowIndex
      // tracks the row loop progress (same as the legacy rowIndex field, duplicated here
      // for clarity in resume-modal logic).
      phaseProgress: {
        setupCompleted: false,
        mainRowIndex: 0,
        teardownCompleted: false,
      },
      headless: !!headless,
      errHandle: errHandle || 'retry',
      rowDelayMin: rowDelayMin || 0,
      rowDelayMax: rowDelayMax || 0,
      selectorTimeout,
      pageLoadMode,
      retryCount,
      breakerThreshold,
      reauthInterval,
      retryRowIndexes,
      totalRows: totalRowsForCheckpoint,
      startedAt: new Date().toISOString(),
      rowIndex: resumeFromRow || 0,
      ts: new Date().toISOString(),
      logPath,
    }));
  } catch (e) {
    // Non-fatal — run still proceeds without resume capability if userData is read-only
    console.error('Failed to write initial checkpoint:', e.message);
  }

  // Write credentials to temp encrypted file
  const all = readAllProfiles();
  const prof = all.find(p => p.id === profileId) || {};
  if (keytar) {
    prof.companyKey = await keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
    prof.username   = await keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
    prof.password   = await keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
  }
  fs.writeFileSync(credPath, encStore([prof]));

  // Get chromium path FIRST before anything else
  const chromiumExe = getBundledChromiumPath();
  if (!chromiumExe) {
    const errMsg = `Browser engine not found. Expected at: ${path.join(process.resourcesPath || '', 'chromium', 'chrome.exe')}. Please reinstall the application.`;
    runnerLogStream.write(`[${new Date().toISOString()}] FATAL: ${errMsg}\n`);
    runnerLogStream.end();
    mainWindow?.webContents.send('automation-event', { type: 'error', message: errMsg });
    mainWindow?.webContents.send('automation-event', { type: 'done', code: 1, logPath });
    try { fs.unlinkSync(credPath); } catch {}
    return { ok: false, error: 'Chromium not found' };
  }

  // Write runner script with chromium path baked in.
  // v1.2.8: buildRunner takes a config object. We build it as cfg_for_runner so we can
  // validate setup/teardown resolution before spawning the runner.
  const cfg_for_runner = {
    steps,
    logPath,
    checkpointPath,
    resumeFrom: resumeFromRow || 0,
    // v1.3.4 Phase 3: upper row bound for worker-pool sharding. 0 = no bound (process to end).
    // Each worker gets [resumeFrom, endRow]; the runner skips rows outside its slice.
    endRow: endRow || 0,
    headless,
    errHandle: errHandle || 'retry',
    rowDelayMin: rowDelayMin || 0,
    rowDelayMax: rowDelayMax || 0,
    chromiumExePath: chromiumExe,
    startMode,
    selectorTimeout,
    pageLoadMode,
    retryCount,
    breakerThreshold,
    reauthInterval,
    retryRowIndexes,
    // v1.2.8: resolve setup/teardown flow names to step arrays. If a flow can't be
    // resolved, reject the run with a clear error rather than silently dropping it
    // (that would produce a run that creates a batch but never releases it).
    setupSteps: (function(){
      if (!setupFlowId) return [];
      const f = resolveOnceFlowByName(setupFlowId);
      if (!f) {
        // Will be caught below — push an empty array here so the runner build doesn't crash,
        // but we'll throw before spawning.
        return null;
      }
      if (f.runMode !== 'once') {
        return null;
      }
      return f.steps || [];
    })(),
    teardownSteps: (function(){
      if (!teardownFlowId) return [];
      const f = resolveOnceFlowByName(teardownFlowId);
      if (!f) return null;
      if (f.runMode !== 'once') return null;
      return f.steps || [];
    })(),
    runContext: {
      runId,
      today: new Date().toISOString().slice(0,10),
      profileUsername: (prof && prof.username) || ''
    },
    // v1.2.8: resumeAction controls phase gating. 'run-teardown-only' tells the runner to
    // skip setup and the row loop, run teardown only. Other values (or undefined) run all phases.
    resumeAction: resumeAction || null
  };
  // v1.2.8: hard fail if setup/teardown couldn't be resolved (we returned null sentinels above).
  if (cfg_for_runner.setupSteps === null) {
    runnerLogStream.write(`[${new Date().toISOString()}] FATAL: setup flow "${setupFlowId}" not found or not a once-flow\n`);
    runnerLogStream.end();
    return { ok: false, error: 'Setup flow "' + setupFlowId + '" not found or has wrong runMode. Fix or remove the reference, then try again.' };
  }
  if (cfg_for_runner.teardownSteps === null) {
    runnerLogStream.write(`[${new Date().toISOString()}] FATAL: teardown flow "${teardownFlowId}" not found or not a once-flow\n`);
    runnerLogStream.end();
    return { ok: false, error: 'Teardown flow "' + teardownFlowId + '" not found or has wrong runMode. Fix or remove the reference, then try again.' };
  }
  const script = buildRunner(cfg_for_runner);
  fs.writeFileSync(runnerPath, script);

  const env = { ...process.env };

  // Point NODE_PATH so runner can find playwright-core etc
  // When packaged, node_modules live next to app.asar in resources
  const nodeModulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : path.join(__dirname, '..', 'node_modules');
  env.NODE_PATH = nodeModulesPath;
  env.BUU_NODE_MODULES = nodeModulesPath;

  // Electron's process.execPath runs Electron, not Node.
  // Pass ELECTRON_RUN_AS_NODE=1 so Electron acts as plain Node for the runner.
  env.ELECTRON_RUN_AS_NODE = '1';

  // Append spawn-time details to the already-open runner log
  runnerLogStream.write(`[${new Date().toISOString()}] Runner spawning\n`);
  runnerLogStream.write(`[${new Date().toISOString()}] execPath: ${process.execPath}\n`);
  runnerLogStream.write(`[${new Date().toISOString()}] runnerPath: ${runnerPath}\n`);
  runnerLogStream.write(`[${new Date().toISOString()}] ELECTRON_RUN_AS_NODE: ${env.ELECTRON_RUN_AS_NODE}\n`);
  runnerLogStream.write(`[${new Date().toISOString()}] NODE_PATH: ${env.NODE_PATH}\n`);

  automationProcesses.set(runId, { process: null, runId, profileId, logPath, startedAt: Date.now(), runnerLogStream, runnerPath, credPath });

  const proc = spawn(process.execPath, [runnerPath, spreadsheetPath, credPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  // Update Map entry with the live process handle
  const entry = automationProcesses.get(runId);
  if (entry) entry.process = proc;

  proc.stderr.on('data', data => {
    runnerLogStream.write(`[STDERR] ${String(data)}\n`);
    mainWindow?.webContents.send('automation-event', { type: 'stderr', message: String(data) });
  });
  proc.stdout.on('data', data => {
    runnerLogStream.write(`[STDOUT] ${String(data)}\n`);
    String(data).split('\n').filter(Boolean).forEach(line => {
      try { mainWindow?.webContents.send('automation-event', JSON.parse(line)); } catch {}
    });
  });
  proc.on('close', code => {
    // v1.3.0 Item 3: log the close event with the pre-cleanup map state so we can tell
    // if the cleanup ran exactly once. Pairs with the renderer's [run] handleRunEvent log.
    console.log('[main] runner closed: runId=' + runId + ', code=' + code + ', wasInMap=' + automationProcesses.has(runId));
    runnerLogStream.write(`[${new Date().toISOString()}] Runner exited with code: ${code}\n`);
    runnerLogStream.end();
    mainWindow?.webContents.send('automation-event', { type: 'done', code, logPath, runId });
    automationProcesses.delete(runId);
    console.log('[main] runner cleanup complete: runId=' + runId + ', new mapSize=' + automationProcesses.size);
    try { fs.unlinkSync(runnerPath); } catch {}
    try { fs.unlinkSync(credPath); } catch {}
  });

  return { ok: true, logPath };
});

ipcMain.handle('stop-automation', (_, payload) => {
  const targetRunId = payload && payload.runId;
  // v1.3.0 Item 3: log entry and outcome. Helps diagnose force-kill cases that bypass the
  // clean stdin-stop path — the kill leaves no runner-side trace, only these console lines.
  console.log('[main] stop-automation: targetRunId=' + targetRunId + ', currentMapSize=' + automationProcesses.size);
  if (targetRunId) {
    const entry = automationProcesses.get(targetRunId);
    console.log('[main] stop-automation: entry found=' + !!entry + ' — force-killing process');
    if (entry && entry.process) { try { entry.process.kill(); } catch {} }
    automationProcesses.delete(targetRunId);
    console.log('[main] stop-automation: deleted from map, new size=' + automationProcesses.size);
    return { ok: true, stopped: entry ? 1 : 0 };
  }
  // No runId given -> stop all (preserves v1.2.2 behavior)
  let stopped = 0;
  for (const [, entry] of automationProcesses) {
    if (entry.process) { try { entry.process.kill(); stopped++; } catch {} }
  }
  automationProcesses.clear();
  console.log('[main] stop-automation: stop-all path, killed=' + stopped + ', map cleared');
  return { ok: true, stopped };
});

// Send a control command to a running runner via stdin (v1.2.4).
// cmd: 'next-step' | 'next-row' | 'run-all' | 'stop'
// If runId is omitted, applies to the (currently single) running runner.
ipcMain.handle('run-control', (_, payload) => {
  const { runId, cmd } = payload || {};
  // v1.3.0 Item 3: log the inbound cmd and resolution outcome. The 'stop' cmd is the most
  // important one to trace — if the renderer thinks it sent stop but the runner never sees it,
  // the entry-found=false line tells us why (already removed from the map, etc).
  console.log('[main] run-control: cmd=' + cmd + ', runId=' + runId + ', currentMapSize=' + automationProcesses.size);
  if (!cmd) return { ok: false, error: 'Missing cmd' };
  let entry = null;
  if (runId) {
    entry = automationProcesses.get(runId);
  } else {
    entry = Array.from(automationProcesses.values())[0] || null;
  }
  console.log('[main] run-control: entry found=' + !!entry + ', has process=' + !!(entry && entry.process));
  if (!entry || !entry.process) return { ok: false, error: 'No running automation' };
  try {
    entry.process.stdin.write(JSON.stringify({ cmd }) + '\n');
    return { ok: true };
  } catch (e) {
    console.warn('[main] run-control: stdin.write threw: ' + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-checkpoint', (_, runId) => {
  const p = path.join(app.getPath('userData'), `checkpoint-${runId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
});

// Find orphaned v2 checkpoints — runs that didn't complete cleanly.
// Returns an array of { runId, ts, startedAt, spreadsheetPath, spreadsheetName, profileId, rowIndex, totalRows, checkpointPath, profileExists, fileExists }
// Old (v1) checkpoints with only {rowIndex, ts} are filtered out — they predate this feature.
ipcMain.handle('find-orphan-checkpoints', () => {
  const dir = app.getPath('userData');
  const orphans = [];
  if (!fs.existsSync(dir)) return orphans;
  let files;
  try { files = fs.readdirSync(dir); } catch { return orphans; }
  const allProfiles = readAllProfiles();
  for (const f of files) {
    if (!/^checkpoint-.+\.json$/.test(f)) continue;
    const checkpointPath = path.join(dir, f);
    try {
      const c = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      // Skip v1 (no schemaVersion or no flowSnapshot) — can't resume those.
      // v1.2.8: accept both v2 and v3 checkpoints. v2 has no flowMeta/phaseProgress;
      // we synthesize sensible defaults (assumed per-row flow, no setup/teardown,
      // phase progress reflecting "rowIndex-based midpoint").
      if (!c.flowSnapshot || !c.spreadsheetPath) continue;
      if (c.schemaVersion !== 2 && c.schemaVersion !== 3) continue;
      // Skip if currently running
      if (automationProcesses.has(c.runId)) continue;
      // v1.2.8: synthesize phaseProgress for v2 checkpoints so the resume modal can
      // treat all orphans uniformly. A v2 checkpoint with rowIndex>0 means main was
      // in progress; we mark setupCompleted=true (it was an implicit no-op for v2)
      // and teardownCompleted=false (v2 has no teardown concept).
      const phaseProgress = c.phaseProgress || {
        setupCompleted: true,
        mainRowIndex: c.rowIndex || 0,
        teardownCompleted: false,
      };
      const flowMeta = c.flowMeta || {
        runMode: 'per-row',
        setupFlowId: null,
        teardownFlowId: null,
        setupStepCount: 0,
        teardownStepCount: 0,
      };
      orphans.push({
        runId: c.runId,
        ts: c.ts,
        startedAt: c.startedAt,
        spreadsheetPath: c.spreadsheetPath,
        spreadsheetName: c.spreadsheetName || path.basename(c.spreadsheetPath),
        profileId: c.profileId,
        rowIndex: c.rowIndex || 0,
        totalRows: c.totalRows || 0,
        checkpointPath,
        profileExists: !!allProfiles.find(p => p.id === c.profileId),
        fileExists: fs.existsSync(c.spreadsheetPath),
        // v1.2.5 item 2.7: forward the stop-reason annotations so the modal can show them.
        lastError: c.lastError || null,
        lastStop: c.lastStop || null,
        // v1.2.8: forward phase progress + flowMeta so the resume modal can branch on them.
        schemaVersion: c.schemaVersion,
        phaseProgress,
        flowMeta,
      });
    } catch {}
  }
  // Most recent first
  orphans.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return orphans;
});

// Hydrate the full checkpoint (including flowSnapshot) for a Resume action.
// Separate from find-orphan-checkpoints to keep the orphan list payload small.
ipcMain.handle('load-checkpoint', (_, checkpointPath) => {
  if (!checkpointPath || !fs.existsSync(checkpointPath)) return null;
  try { return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); } catch { return null; }
});

ipcMain.handle('discard-checkpoint', (_, checkpointPath) => {
  try { if (checkpointPath && fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── RUNNER SCRIPT BUILDER ─────────────────────────────────────────────────────
// v1.2.8: refactored from 16-arg positional signature to a single config object.
// Destructure to locals so the existing template body (which references the param
// names directly via ${paramName}) keeps working without touching the 1000+ lines below.
// New v1.2.8 fields: setupSteps, teardownSteps, runContext. They default to null/empty
// for back-compat with pre-1.2.8 call sites (none currently expected, but safe).
function buildRunner(cfg) {
  const {
    steps, logPath, checkpointPath, resumeFrom, headless, errHandle,
    rowDelayMin, rowDelayMax, chromiumExePath, startMode,
    selectorTimeout, pageLoadMode, retryCount, breakerThreshold,
    reauthInterval, retryRowIndexes,
    endRow = 0,  // v1.3.4 Phase 3: worker-pool upper row bound (0 = to end)
    // v1.2.8 additions:
    setupSteps = [], teardownSteps = [], runContext = {},
    resumeAction = null  // 'run-teardown-only' skips setup + row loop
  } = cfg;
  return `
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// v1.2.5 item 2.8 (Phase 7): TCP probe for network-aware retry. Builtin module — no NODE_PATH needed.
const net = require('net');

const SPREADSHEET = process.argv[2];
const CRED_PATH = process.argv[3];

// Resolve modules from app node_modules
const _nm = process.env.NODE_PATH || path.join(__dirname);
function _require(mod){
  try{return require(mod);}catch(e){
    try{return require(path.join(_nm,mod));}catch(e2){
      throw new Error('Cannot find: '+mod+' (tried NODE_PATH: '+_nm+')');
    }
  }
}
if(process.env.NODE_PATH){
  try{require('module').Module._initPaths();}catch(e){}
}

const { chromium } = _require('playwright-core');
const XLSX = _require('xlsx');
const LOG_PATH = ${JSON.stringify(logPath)};
const CHECKPOINT = ${JSON.stringify(checkpointPath)};
const RESUME_FROM = ${resumeFrom};
// v1.3.4 Phase 3: worker-pool upper row bound. Worker processes source rows
// (RESUME_FROM, END_ROW]. 0 means no upper bound (process to the end of the sheet).
const END_ROW = ${endRow};
const HEADLESS = ${headless};
const ERR_HANDLE = ${JSON.stringify(errHandle)};
const ROW_DELAY_MIN = ${Math.round(parseFloat(rowDelayMin) * 1000)};
const ROW_DELAY_MAX = ${Math.round(parseFloat(rowDelayMax) * 1000)};
// v1.2.5 item 2.8: tunable speed/resilience
const SELECTOR_TIMEOUT = ${parseInt(selectorTimeout) * 1000};
const PAGE_LOAD_MODE = ${JSON.stringify(pageLoadMode)};
// v2.0.2: navigation timeout for the navigate step. PestPac lead pages can be very slow on a
// large account, so this is 90s (vs the old hardcoded 30s) to cut false skips on slow loads.
const NAV_TIMEOUT = 90000;
const RETRY_COUNT = ${parseInt(retryCount)};
// v1.2.5 item 2.3b: consecutive-error circuit breaker (0 = disabled)
const BREAKER_THRESHOLD = ${parseInt(breakerThreshold)};
// v1.2.5 item 2.11: re-auth interval in ms. 0 = disabled. Logic comes in Phase 7.
const REAUTH_INTERVAL_MS = ${parseInt(reauthInterval) * 60 * 1000};
// v1.2.5 item 2.12: retry-failed-rows. When non-empty, runner processes ONLY these source-row
// numbers (1-based). Use a Set for O(1) lookup since retry runs scan every source row.
const RETRY_ROW_INDEXES = new Set(${JSON.stringify(retryRowIndexes || [])});
const IS_RETRY_RUN = RETRY_ROW_INDEXES.size > 0;

// Run-mode state machine (v1.2.4).
// START_MODE is the initial mode; currentMode is mutated by stdin commands.
// Modes: 'step' = pause before each action; 'step-row' = pause after each row;
//        'run-all' = no pausing; 'stop' = clean shutdown requested.
const START_MODE = ${JSON.stringify(startMode || 'run-all')};
let currentMode = START_MODE;

// Stdin command reader. Each line is a JSON object: {"cmd":"next-step"|"next-row"|"run-all"|"stop"}.
// 'next-step' / 'next-row' resolve a pending pause without changing mode.
// 'run-all' switches mode to run-all (and resolves any pending pause).
// 'stop' switches mode to stop and resolves any pending pause; the loop checks for it.
const _readline = require('readline');
let _pendingResolve = null;
const _rl = _readline.createInterface({ input: process.stdin, terminal: false });
_rl.on('line', function(line){
  let msg;
  try { msg = JSON.parse(line); } catch(e) { return; }
  if (!msg || !msg.cmd) return;
  if (msg.cmd === 'run-all') currentMode = 'run-all';
  if (msg.cmd === 'stop') currentMode = 'stop';
  if (_pendingResolve) { const r = _pendingResolve; _pendingResolve = null; r(msg.cmd); }
});
function waitForCommand(){
  if (currentMode === 'run-all' || currentMode === 'stop') return Promise.resolve('auto');
  return new Promise(function(r){ _pendingResolve = r; });
}

// v1.2.5 item 2.8 (Phase 7): Network-aware retry.
// probeNetwork() does a single TCP connect to PestPac and resolves true/false within 5s.
// Source of truth for "are we connected" — error strings from Playwright are heterogeneous
// and unreliable as a sole classifier. We probe AFTER any row failure to decide whether
// to enter the wait-and-ping loop or fall through to the existing retry/skip logic.
function probeNetwork(){
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
}

// waitForNetwork() loops with backoff until probeNetwork() returns true.
// Honors the user-stop sentinel — if currentMode flips to 'stop' during the wait,
// throws __STOP__ so the row catch handler bails cleanly. Returns total ms waited.
async function waitForNetwork(){
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
}

// v1.2.5 item 2.10 (Phase 8): error classifier.
// Maps an error message to one of seven categories for the new Excel log column.
// String-based heuristic (vs 2.8's probe-based gate) — sufficient for forensic column,
// not used for runtime decisions. Order matters: more-specific patterns checked first.
function classifyError(errMsg){
  const m = String(errMsg || '');
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(m)) return 'internet-down';
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNREFUSED|ECONNRESET/i.test(m)) return 'pestpac-down';
  if (/ERR_|net::/i.test(m)) return 'unknown-network';
  if (/waitForSelector.*Timeout|waiting for selector/i.test(m)) return 'selector';
  if (/Timeout|timed out|TimeoutError/i.test(m)) return 'timeout';
  if (/Assert failed|HTTP 4\\d\\d|status code 4\\d\\d/i.test(m)) return 'validation';
  return 'unknown';
}

// v1.2.5 item 2.10 (Phase 8): phase classifier from error message.
// Heuristic — distinguishes pre-action (waitForSelector failed) from action (click/type
// itself failed) from post-action (assert / follow-up wait failed). Saves us from
// instrumenting every runStep case individually for v1.2.5.
function classifyPhase(errMsg){
  const m = String(errMsg || '');
  if (/waitForSelector|waiting for selector|timeout.*selector/i.test(m)) return 'pre-action';
  if (/Assert failed/i.test(m)) return 'post-action';
  if (/Navigation failed|page\\.goto/i.test(m)) return 'action';
  return 'action';  // default — most errors are action-phase
}

// Resolve a preview snapshot of what's about to happen, used during pauses.
// Mirrors the substitution logic in runStep's r() but does not touch the page.
function resolvePreview(step, row, creds){
  const r = function(v){
    if(!v) return '';
    return v.replace(/{{CRED:companyKey}}/g, creds.companyKey||'')
            .replace(/{{CRED:username}}/g, creds.username||'')
            .replace(/{{CRED:password}}/g, creds.password||'')
            // v1.2.8: match runStep — run-context tokens before row tokens.
            .replace(/{{([^}]+)}}/g, function(_, ref){
              if (ref === 'TODAY') return RUN_CONTEXT.today || '';
              if (ref === 'RUNID') return RUN_CONTEXT.runId || '';
              if (ref === 'PROFILE_USERNAME') return RUN_CONTEXT.profileUsername || '';
              return row[ref] !== undefined ? String(row[ref]) : '';
            });
  };
  let value = '';
  if (step.type === 'type' || step.type === 'select') value = r(step.value || '');
  else if (step.type === 'navigate') value = r(step.url || '');
  else if (step.type === 'textedit') value = '(textedit: ' + (step.editMode || 'find-replace') + ')';
  else if (step.type === 'checkbox') value = '(' + (step.checkAction || 'check') + ')';
  else if (step.type === 'wait') value = '(' + (step.waitType || 'fixed') + ')';
  // v1.3.0 Item 1: when find-by-text is on, show the resolved match + container so the
  // step-mode pause panel tells the user which look-alike will be acted on.
  var selectorOut = step.selector || '';
  if (step.findByText) {
    var matchResolved = r(step.matchText || '');
    selectorOut = 'in [' + (step.containerSel || '?') + '] where text ' + (step.matchMode || 'contains') + ' "' + matchResolved + '"'
                + (step.selector ? ' → ' + step.selector : ' (the matched item)');
  }
  return {
    type: step.type,
    label: step._label || step.type,
    selector: selectorOut,
    value: value,
  };
}

const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\\n');}
// v1.3.4 Item I (checkpoint integrity): read the existing checkpoint and return it parsed,
// or return null if it can't be read/parsed. The crucial contract: a null return means
// "do NOT write" — callers must never write a fresh {} over a checkpoint they failed to
// read, because that destroys the resume context (runId/spreadsheetPath/flowSnapshot/etc).
// This is the root cause of the gutted-checkpoint bug: the old read-modify-write swallowed
// read errors, left prev={}, and wrote that empty object back, making resume impossible.
function readChkOrNull(){
  try{
    var raw = fs.readFileSync(CHECKPOINT,'utf8');
    var obj = JSON.parse(raw);
    // Guard against an already-gutted file: a valid resumable checkpoint has a runId.
    // If the file parsed but has no runId, treat it as unreadable rather than building on it.
    if(obj && typeof obj === 'object' && obj.runId) return obj;
    return null;
  }catch(e){ return null; }
}
// v1.3.4 Item I: atomic write — write to a temp sibling then rename over the target, so a
// crash mid-write can never leave a half-written/truncated checkpoint. rename is atomic on
// the same volume (userData is local AppData, not a network/OneDrive path, so this holds).
function writeChkAtomic(obj){
  try{
    var tmp = CHECKPOINT + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CHECKPOINT);
    return true;
  }catch(e){
    emit({type:'log', message:'Checkpoint write failed (non-fatal): '+(e&&e.message||e)});
    return false;
  }
}
function saveChk(row){
  // Read-or-skip: if we can't read the existing checkpoint intact, skip this update entirely
  // rather than clobbering it. The next successful row will checkpoint again.
  var prev = readChkOrNull();
  if(!prev) return;
  prev.rowIndex=row;prev.ts=new Date().toISOString();
  // v1.2.8: mirror rowIndex into phaseProgress.mainRowIndex for v3 readers.
  if(prev.phaseProgress){ prev.phaseProgress.mainRowIndex = row; }
  writeChkAtomic(prev);
}
// v1.2.8: mark a phase completed (or its progress field) in the checkpoint.
// Used to record setupCompleted=true after setup runs cleanly, teardownCompleted=true
// after teardown runs cleanly. Idempotent.
function markPhaseDone(phase){
  // v1.3.4 Item I: read-or-skip + atomic write (same contract as saveChk). The old version
  // wrote prev={} on a read failure, which is exactly how a checkpoint ended up as
  // {phaseProgress:{...},ts:...} with every resume field gone. If we can't read it, skip.
  var prev = readChkOrNull();
  if(!prev) return;
  if(!prev.phaseProgress) prev.phaseProgress = {setupCompleted:false, mainRowIndex:0, teardownCompleted:false};
  if(phase === 'setup') prev.phaseProgress.setupCompleted = true;
  else if(phase === 'teardown') prev.phaseProgress.teardownCompleted = true;
  prev.ts = new Date().toISOString();
  writeChkAtomic(prev);
}

const ALL_STEPS = ${JSON.stringify(steps)};
const LOGIN_STEPS = ALL_STEPS.filter(s => s.locked && s.type !== 'pestpac-logout');
const DATA_STEPS  = ALL_STEPS.filter(s => !s.locked && s.type !== 'pestpac-logout');
const LOGOUT_STEP = ALL_STEPS.find(s => s.type === 'pestpac-logout') || {type:'pestpac-logout'};

// v1.2.8: setup and teardown once-flows. Their steps come from separate flow JSON files;
// they have no locked/login portion (they reuse the main flow's session). Empty arrays
// when the main flow declares no setup/teardown — the main() runner skips those phases.
const SETUP_STEPS = ${JSON.stringify(setupSteps || [])};
const TEARDOWN_STEPS = ${JSON.stringify(teardownSteps || [])};
// v1.2.8: run-context for once-flow token resolution. Per-row tokens (the {{ColName}} form)
// are resolved against row data; run-context tokens ({{TODAY}}, {{RUNID}}, {{PROFILE_USERNAME}})
// resolve against this object regardless of phase. Per-row flows can also use these tokens.
const RUN_CONTEXT = ${JSON.stringify(runContext || {})};
// v1.2.8: resumeAction gates which phases execute. 'run-teardown-only' is the recovery
// path from the resume modal — runs ONLY teardown, skipping login/setup/main/logout.
// Any other value (or null) runs all phases normally.
const RESUME_ACTION = ${JSON.stringify(resumeAction || null)};

let logEntries=[], flushTimer=null;
function addLog(e){logEntries.push(e);if(logEntries.length%100===0)flush();else{clearTimeout(flushTimer);flushTimer=setTimeout(flush,3000);}}
function flush(){
  // Always write at least a Summary sheet, even with zero rows, so the user
  // has evidence the run happened. Previously returned early on empty logEntries,
  // which meant a run that died before any row completed produced no Excel log.
  let attempt=0;
  const maxAttempts=3;
  // v1.2.5 item 2.10 (Phase 8, sub 3): rich column ordering for Errors / Skipped /
  // All-rows sheets. Most-actionable left, most-detailed right. Pivot-friendly.
  // Headers map to log-entry field names. attemptedValue truncated by the runner.
  const HEADERS = [
    'Row','Status','Error category','Phase','Step #','Step type','Step label',
    'Field/selector','Attempted value','URL','Error message','Timestamp','Failed step','Fields written','Duration (ms)'
  ];
  const HEADER_KEYS = [
    'row','status','errorCategory','phase','stepIndex','stepType','stepLabel',
    'selector','attemptedValue','url','error','timestamp','failedStep','fieldsWritten','durationMs'
  ];
  // Build a worksheet from a list of entries with explicit column order, auto-filter,
  // and frozen header row. Returns the worksheet — caller appends it to the workbook.
  function buildSheet(entries){
    const aoa = [HEADERS];
    for (const e of entries){
      const row = HEADER_KEYS.map(k => (e[k] !== undefined && e[k] !== null) ? e[k] : '');
      aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Auto-filter on the header range. SheetJS 0.18 emits <autoFilter ref="..."/> from this.
    const range = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,aoa.length-1),c:HEADERS.length-1}});
    ws['!autofilter'] = { ref: range };
    // Note: freeze-pane (per design line 386) was scoped here too, but SheetJS 0.18.5
    // community edition doesn't write <pane> elements even when !views is set. The pro
    // edition does. We get auto-filter + column ordering + Stopped reason as the
    // bulk of the diagnostic value; freeze-pane is nice-to-have. Documented in
    // POST-PUSH-NOTES. User can manually freeze rows in Excel via View > Freeze Panes.
    // Reasonable column widths (in 'wch' units = approx character widths).
    ws['!cols'] = [
      {wch:6},{wch:12},{wch:18},{wch:12},{wch:14},{wch:12},{wch:18},
      {wch:30},{wch:24},{wch:40},{wch:50},{wch:22},{wch:18},{wch:32},{wch:14}
    ];
    return ws;
  }
  while(attempt<maxAttempts){
    attempt++;
    try{
      const wb=XLSX.utils.book_new();
      // Filter the in-memory log into category buckets.
      // 'success' / 'reauth' from synthetic entries are also considered "ok" for the rate calc.
      const ok=logEntries.filter(e=>e.status==='ok'||e.status==='ok (retry)'||e.status==='success'||e.status==='reauth');
      // 2.10 (Phase 8): redefine 'errors' as everything failure-like. Pre-2.10 the runner
      // never wrote status='error' for rows (it used 'skip' for retry-exhausted), so the
      // Errors sheet was always empty. After 2.10's synthetic entries, login/reauth
      // failures DO use status='error', and breaker-trip entries use 'circuit-breaker'.
      // The Errors sheet now collects all of these — the things that warrant investigation
      // beyond a routine row-skip.
      const errs=logEntries.filter(e=>e.status==='error'||e.status==='circuit-breaker');
      const skipped=logEntries.filter(e=>e.status==='skip');

      // v1.2.5 item 2.10 sub 3: derive the "Stopped reason" Summary cell from the
      // most recent terminal event in the log. Empty on clean completion.
      // v1.2.8: also surface setup/teardown failures as stopped reasons.
      let stoppedReason = '';
      // Walk backwards through logEntries looking for a synthetic terminal event.
      for (let i = logEntries.length - 1; i >= 0; i--){
        const e = logEntries[i];
        if (e.status === 'circuit-breaker') {
          stoppedReason = e.stepLabel || ('Circuit breaker tripped (last successful row: ' + (e.error || '?') + ')');
          break;
        }
        if (e.status === 'error' && e.phase === 'setup') {
          stoppedReason = 'Setup failed: ' + (e.error || 'unknown');
          break;
        }
        if (e.status === 'error' && e.phase === 'teardown') {
          stoppedReason = 'Teardown failed: ' + (e.error || 'unknown');
          break;
        }
        if (e.status === 'error' && e.phase === 'reauth') {
          stoppedReason = 'Re-auth failed: ' + (e.error || 'unknown');
          break;
        }
        if (e.status === 'error' && e.phase === 'init') {
          stoppedReason = 'Initial login failed: ' + (e.error || 'unknown');
          break;
        }
        if (e.status === 'stopped') {
          stoppedReason = 'Stopped by user at row ' + (e.row || '?');
          break;
        }
      }

      const summaryRows = [
        {Metric:'Total processed',Value:logEntries.filter(e=>e.row).length},
        {Metric:'Successful',Value:ok.filter(e=>e.row).length},
        {Metric:'Errors',Value:errs.length},
        {Metric:'Skipped',Value:skipped.length},
        {Metric:'Success rate',Value:logEntries.filter(e=>e.row).length?Math.round(ok.filter(e=>e.row).length/logEntries.filter(e=>e.row).length*100)+'%':'N/A'},
        {Metric:'Stopped reason',Value:stoppedReason},  // v1.2.5 2.10 sub 3 — empty on clean completion
        {Metric:'Last updated',Value:new Date().toLocaleString()},
        {Metric:'Phase at last flush',Value:(typeof _hbState!=='undefined'&&_hbState&&_hbState.phase)||'unknown'},
      ];
      const summaryWs = XLSX.utils.json_to_sheet(summaryRows);
      summaryWs['!cols'] = [{wch:24},{wch:60}];
      XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

      // v1.2.8: Phases sheet. Summarizes setup/teardown phase entries (synthetic log
      // entries written by runOnceFlow). One row per phase, showing status, duration,
      // and any failure details. Only added when at least one phase entry exists, so
      // pre-1.2.8 logs / flows-without-composition don't get an empty sheet.
      const phaseEntries = logEntries.filter(e => e.phase === 'setup' || e.phase === 'teardown');
      if (phaseEntries.length) {
        const phaseRows = phaseEntries.map(e => ({
          Phase: e.phase === 'setup' ? 'Setup' : 'Teardown',
          Status: e.status === 'success' ? 'Success' : (e.status === 'error' ? 'Failed' : e.status),
          'Started at': e.timestamp || '',
          'Duration (ms)': e.durationMs || '',
          'Step #': e.stepIndex !== '' && e.stepIndex !== undefined ? e.stepIndex : '',
          'Step type': e.stepType || '',
          'Step label': e.stepLabel || '',
          Notes: e.error || ''
        }));
        const phasesWs = XLSX.utils.json_to_sheet(phaseRows);
        phasesWs['!cols'] = [{wch:10},{wch:10},{wch:24},{wch:14},{wch:8},{wch:14},{wch:36},{wch:50}];
        XLSX.utils.book_append_sheet(wb, phasesWs, 'Phases');
      }

      if(logEntries.length){
        XLSX.utils.book_append_sheet(wb, buildSheet(logEntries), 'All rows');
        if(errs.length) XLSX.utils.book_append_sheet(wb, buildSheet(errs), 'Errors only');
        if(skipped.length) XLSX.utils.book_append_sheet(wb, buildSheet(skipped), 'Skipped');
      } else {
        XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([
          {Note:'No rows were processed before this log was flushed. Check the runner log (.log file in the same folder) for diagnostic details.'}
        ]),'Note');
      }
      XLSX.writeFile(wb,LOG_PATH);
      return;
    }catch(e){
      if(attempt>=maxAttempts){
        emit({type:'log-error',message:e.message+' (after '+attempt+' attempts at '+LOG_PATH+')'});
        return;
      }
      // Likely a file lock (Excel/OneDrive). Wait briefly and retry.
      const wait=Date.now()+800;while(Date.now()<wait){}
    }
  }
}

async function* streamRows(fp){
  const ext=path.extname(fp).toLowerCase();
  if(ext==='.csv'){
    const lines=fs.readFileSync(fp,'utf8').split('\\n').filter(Boolean);
    const headers=lines[0].split(',').map(h=>h.trim().replace(/^"|"$/g,''));
    for(let i=1;i<lines.length;i++){
      const vals=lines[i].split(',').map(v=>v.trim().replace(/^"|"$/g,''));
      const row={};headers.forEach((h,j)=>row[h]=vals[j]||'');
      yield row;
    }
  }else{
    const wb=XLSX.readFile(fp);
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    for(const row of rows)yield row;
  }
}

async function countRows(fp){
  const ext=path.extname(fp).toLowerCase();
  if(ext==='.csv'){const c=fs.readFileSync(fp,'utf8').split('\\n').filter(Boolean).length;return Math.max(0,c-1);}
  const wb=XLSX.readFile(fp);return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).length;
}

// v1.2.5 item 2.11 (Phase 7): shared login function. Used by:
//   1. The initial LOGIN_STEPS run (via the pestpac-login step case below)
//   2. Timer-based re-auth (every REAUTH_INTERVAL_MS at row boundaries)
//   3. Connectivity-wait > 10 min (after waitForNetwork() returns)
//   4. Detection-based re-auth (when row-start detects login URL)
// Throws if any step in the sequence fails. Caller decides whether that's fatal.
async function loginToPestPac(page, creds){
  await page.goto(creds.loginUrl||'https://login.pestpac.com/',{waitUntil:'load',timeout:30000});
  await page.waitForSelector('input[name="uid"]',{timeout:15000});
  await page.fill('input[name="uid"]','');
  await page.fill('input[name="uid"]',creds.companyKey||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{force:true}); }
  await page.waitForSelector('input[name="username"]',{timeout:15000});
  await page.fill('input[name="username"]',creds.username||'');
  await page.fill('input[name="password"]',creds.password||'');
  // v2.1.1a: PestPac's MUI loading backdrop intercepts the login click; wait it out, then force.
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="loginBtn"]',{force:true}); }
  await page.waitForSelector('a[href*="AutoLogin"]',{timeout:30000});
}

// v1.2.6: automatic iframe traversal for selector-based steps.
// PestPac renders form pages (and especially modal dialogs like attach-to-lead)
// inside iframes. Playwright's page.locator() queries the top frame only, so a
// selector that resolves fine in DevTools (which auto-scopes to the active frame)
// never matches from page-level. findLocator() walks the top frame first, then
// every iframe, and returns a locator scoped to the frame that contains the match.
//
// Returns: a Locator. Throws if no frame contains the selector after the timeout window.
// Note: behaves identically to page.locator(...) when the selector IS in the top frame —
// just adds one extra count() call. ~10–30ms overhead per step in the worst case.
async function findLocator(page, selector, opts){
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
    // Not found yet — wait briefly and re-scan. This handles "selector appears
    // a few hundred ms after the previous step" without exhausting the timeout immediately.
    await new Promise(function(r){ setTimeout(r, pollMs); });
  }
  // Final attempt with detailed error so the user knows where to look.
  const frameInfo = page.frames().map(function(f){ return f.url() || '(blank)'; }).join(', ');
  throw new Error('Selector "' + selector + '" not found in any frame after ' + timeoutMs + 'ms. Frames searched: [' + frameInfo + ']');
}

// v1.3.0 Item 1: text-match comparator for find-by-text scope. Compares a container's
// visible text against the user's match text using the chosen mode. All non-regex modes
// trim both sides first (PestPac cells are padded with whitespace/labels). Returns boolean.
function matchesText(haystack, needle, mode){
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
}

// v1.3.0 Item 1: find the single container (out of many look-alikes) whose visible text
// matches matchText per mode, then return a locator scoped to targetSel INSIDE it. If
// targetSel is empty, returns the matched container locator itself. Iframe-aware (reuses
// the same top-frame-then-iframes walk as findLocator). Throws a clear error if zero or
// more than one container matches — BUU never guesses which look-alike is the right one.
async function findInContainer(page, containerSel, matchText, targetSel, mode, opts){
  opts = opts || {};
  var timeoutMs = opts.timeout || 30000;
  var pollMs = 250;
  var startedAt = Date.now();
  var lastSeenCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    // Collect every frame to search: top frame first, then all iframes.
    var frames = [page.mainFrame()];
    for (var fi = 0; fi < page.frames().length; fi++) {
      if (page.frames()[fi] !== page.mainFrame()) frames.push(page.frames()[fi]);
    }
    var matched = [];   // {frame, index} for each container whose text matches
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
          // innerText can fail on hidden nodes; fall back to textContent.
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
    // Zero matches yet — wait and rescan (the grid may still be loading).
    await new Promise(function(r){ setTimeout(r, pollMs); });
  }
  throw new Error('Find-by-text found no container matching "' + matchText + '" (mode: ' + (mode||'contains') + ') in selector "' + containerSel + '" after ' + timeoutMs + 'ms. Containers seen during scan: ' + lastSeenCount + '. Check the match text/column value and the container selector.');
}

// v1.3.0 Item 1: resolve the locator a selector-using step should act on. Centralizes the
// findByText branch so each step case stays a one-liner. When step.findByText is on, resolves
// the match text through the same token resolver the step uses, then scopes via findInContainer.
// Otherwise behaves exactly like the legacy findLocator(page, step.selector) call.
async function resolveStepLocator(page, step, resolveFn){
  if (step.findByText) {
    var matchResolved = resolveFn(step.matchText || '');
    return await findInContainer(page, step.containerSel || '', matchResolved, step.selector || '', step.matchMode || 'contains', {timeout: SELECTOR_TIMEOUT});
  }
  return await findLocator(page, step.selector, {timeout: SELECTOR_TIMEOUT});
}

// v1.2.6: diagnostic dump for any selector. Called by step types when the user
// has flipped the debug checkbox on (originally only on click steps in v1.2.5-debug1;
// now extended to all selector-using steps). Shape of output is the same shape
// produced by the original inline debug branch — preserves the [debug-click] log
// prefix so existing log-greps still work, but the second arg distinguishes step type.
async function debugDumpSelector(page, selector, kind){
  const tag = '[debug-' + (kind || 'click') + ']';
  try{
    emit({type:'log', message: tag + ' === START === selector: ' + selector});
    // Top-frame match info
    const top = page.locator(selector);
    const topCount = await top.count();
    emit({type:'log', message: tag + ' page.locator.count(): ' + topCount});
    for (let i = 0; i < topCount; i++) {
      const nth = top.nth(i);
      let visible='?', enabled='?', box='?', hidden='?';
      try { visible = await nth.isVisible(); } catch (e) { visible = 'ERR:' + e.message; }
      try { enabled = await nth.isEnabled(); } catch (e) { enabled = 'ERR:' + e.message; }
      try { hidden  = await nth.isHidden();  } catch (e) { hidden  = 'ERR:' + e.message; }
      try { box     = JSON.stringify(await nth.boundingBox()); } catch (e) { box = 'ERR:' + e.message; }
      emit({type:'log', message: tag + ' match[' + i + '] visible=' + visible + ' hidden=' + hidden + ' enabled=' + enabled + ' box=' + box});
    }
    // What's at the visual center of the first top-frame match?
    if (topCount > 0) {
      try {
        const handle = await top.first().elementHandle();
        if (handle) {
          const ownerInfo = await page.evaluate(function(el){
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const t = document.elementFromPoint(cx, cy);
            const cs = getComputedStyle(el);
            let hiddenAncestor = null;
            let p = el.parentElement;
            while (p) {
              const ps = getComputedStyle(p);
              if (ps.display === 'none' || ps.visibility === 'hidden' || ps.opacity === '0') {
                hiddenAncestor = p.tagName + '#' + (p.id || '') + '.' + (p.className || '') + ' (' + ps.display + '/' + ps.visibility + '/' + ps.opacity + ')';
                break;
              }
              p = p.parentElement;
            }
            return {
              rect: { x: r.x, y: r.y, w: r.width, h: r.height },
              elementAtCenter: t ? t.tagName + '#' + (t.id || '') + '.' + (t.className || '') : 'null',
              elementAtCenterIsTarget: t === el,
              pointerEvents: cs.pointerEvents,
              hiddenAncestor: hiddenAncestor,
              documentReadyState: document.readyState,
              nodeName: el.nodeName,
              isConnected: el.isConnected
            };
          }, handle);
          emit({type:'log', message: tag + ' page.evaluate(): ' + JSON.stringify(ownerInfo)});
        } else {
          emit({type:'log', message: tag + ' elementHandle was null'});
        }
      } catch (e) { emit({type:'log', message: tag + ' elementHandle/evaluate error: ' + e.message}); }
    }
    // Walk every iframe — this is what surfaces the "modal lives in a separate frame" case.
    const frames = page.frames();
    emit({type:'log', message: tag + ' page.frames() count: ' + frames.length});
    for (const f of frames) {
      try {
        const fcount = await f.locator(selector).count();
        emit({type:'log', message: tag + ' frame "' + f.url() + '" matches: ' + fcount});
      } catch (e) {
        emit({type:'log', message: tag + ' frame "' + f.url() + '" error: ' + e.message});
      }
    }
    emit({type:'log', message: tag + ' === END === proceeding to action...'});
  } catch (diagErr) {
    emit({type:'log', message: tag + ' diagnostic itself errored: ' + diagErr.message});
  }
}

async function runStep(page,step,row,creds){
  // v1.2.8: token resolver checks CRED:* literals first, then run-context tokens
  // (TODAY/RUNID/PROFILE_USERNAME from the baked-in RUN_CONTEXT), then falls through
  // to row[col]. Once-flows pass row={} and rely entirely on the run-context path;
  // per-row flows use both paths transparently.
  const r=v=>{
    if(!v)return'';
    return v
      .replace(/{{CRED:companyKey}}/g, creds.companyKey||'')
      .replace(/{{CRED:username}}/g, creds.username||'')
      .replace(/{{CRED:password}}/g, creds.password||'')
      .replace(/{{([^}]+)}}/g, function(_, ref){
        // Run-context tokens — small fixed allowlist resolved from RUN_CONTEXT.
        if (ref === 'TODAY') return RUN_CONTEXT.today || '';
        if (ref === 'RUNID') return RUN_CONTEXT.runId || '';
        if (ref === 'PROFILE_USERNAME') return RUN_CONTEXT.profileUsername || '';
        // Per-row column reference.
        return row[ref] !== undefined ? String(row[ref]) : '';
      });
  };
  const ms=s=>Math.round(parseFloat(s||1)*1000);
  switch(step.type){
    case 'navigate':{const _navUrl=r(step.url);emit({type:'log',message:'Navigate → '+(_navUrl||'(empty URL!)')});if(!_navUrl)throw new Error('Navigate URL resolved to empty — check the navigate step\\'s URL field and the column token (e.g. {{URL}}) matches your spreadsheet header exactly.');await page.goto(_navUrl,{waitUntil:PAGE_LOAD_MODE,timeout:NAV_TIMEOUT});break;}
    case 'click':{
      // v1.2.5-debug1 / v1.2.6: opt-in diagnostic dump. Originally added in the
      // local-only -debug1 build to investigate "Playwright doesn't see this button"
      // failures; v1.2.6 keeps it as a permanent feature (off by default) since it's
      // exactly what you want when iframe traversal or selector matching gets weird.
      if(step.debugClick){
        await debugDumpSelector(page, step.selector, 'click');
      }
      // v1.2.6: findLocator handles iframe traversal automatically.
      // v1.3.0 Item 1: resolveStepLocator adds find-by-text scoping when enabled.
      const loc = await resolveStepLocator(page, step, r);
      await loc.first().waitFor({state:'visible', timeout: SELECTOR_TIMEOUT});
      await loc.first().click();
      if(step.waitFor){
        const waitLoc = await findLocator(page, step.waitFor, {timeout: SELECTOR_TIMEOUT});
        await waitLoc.first().waitFor({state:'visible', timeout: SELECTOR_TIMEOUT});
      }
      break;}
    case 'type':{
      const loc = await resolveStepLocator(page, step, r);
      await loc.first().waitFor({state:'visible', timeout: SELECTOR_TIMEOUT});
      if(step.clearFirst!=='no') await loc.first().fill('');
      const _val = r(step.value);
      const _delay = parseInt(step.typeDelay||0);
      if(_delay>0) await loc.first().pressSequentially(_val, {delay:_delay});
      else await loc.first().fill(_val);
      break;}
    case 'select':{
      const loc = await resolveStepLocator(page, step, r);
      await loc.first().waitFor({state:'visible', timeout: SELECTOR_TIMEOUT});
      await loc.first().selectOption({label: r(step.value)});
      break;}
    case 'checkbox':{
      const loc = await resolveStepLocator(page, step, r);
      await loc.first().waitFor({state:'visible', timeout: SELECTOR_TIMEOUT});
      if(step.checkAction==='check') await loc.first().check();
      else if(step.checkAction==='uncheck') await loc.first().uncheck();
      else if(step.checkAction==='toggle') await loc.first().click();
      else if(step.checkAction==='conditional'){
        const tv=(step.truthyVals||'yes,true,1,x').split(',').map(v=>v.trim().toLowerCase());
        if(tv.includes(String(r(step.condCol)).trim().toLowerCase())) await loc.first().check();
        else await loc.first().uncheck();
      }
      break;}
    case 'clear':{
      const loc = await resolveStepLocator(page, step, r);
      await loc.first().waitFor({state:'visible', timeout: SELECTOR_TIMEOUT});
      await loc.first().fill('');
      break;}
    case 'wait':if(step.waitType==='random'){const mn=ms(step.waitMin||1),mx=ms(step.waitMax||3);await page.waitForTimeout(Math.floor(Math.random()*(mx-mn+1))+mn);}else if(step.waitType==='element'){
      // v1.2.6: iframe-aware wait. Note 'wait' steps keep their original 30s timeout
      // (independent of SELECTOR_TIMEOUT) since users explicitly set them as gates.
      const loc = await findLocator(page, step.waitSel||'', {timeout: 30000});
      await loc.first().waitFor({state:'visible', timeout: 30000});
    }else if(step.waitType==='navigation')await page.waitForNavigation({timeout:30000});else await page.waitForTimeout(ms(step.waitSec||1));break;
    case 'assert':{
      const loc = await resolveStepLocator(page, step, r);
      await loc.first().waitFor({state:'visible', timeout: SELECTOR_TIMEOUT});
      if(step.expected){
        const t = await loc.first().textContent();
        if(!t || !t.includes(step.expected)) throw new Error('Assert failed: expected "'+step.expected+'" got "'+(t||'(empty)')+'"');
      }
      break;}
    case 'pestpac-login':{
      // v1.2.5 item 2.11 (Phase 7): delegate to shared helper. The body lives in
      // loginToPestPac() above so the same sequence is used by the three re-auth
      // triggers (timer / connectivity-wait / detection) without duplication.
      await loginToPestPac(page, creds);
      break;}
    case 'pestpac-logout':{
      // Navigate to search, click user menu, click Log Out
      await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'load',timeout:15000});
      await page.waitForSelector('div.select',{timeout:10000});
      await page.click('div.select');
      await page.waitForSelector('a.logout',{timeout:5000});
      await page.click('a.logout');
      await page.waitForTimeout(1500);
      break;}
    case 'fileupload':{
      // v2.0.0: upload a file via Playwright setInputFiles. Path resolves per row from a
      // column, or a fixed folder + a filename column. File must exist on this PC.
      let _filePath='';
      if(step.pathSource==='fixed'){ const _base=(step.baseFolder||'').replace(/[\\\\/]+$/,''); const _fn=r(step.fileNameColumn||''); _filePath=_fn?(_base+'\\\\'+_fn):''; }
      else { _filePath=r(step.pathColumn||''); }
      emit({type:'log',message:'Upload file → '+(_filePath||'(no path resolved!)')});
      if(!_filePath) throw new Error('File upload: no file path resolved for this row');
      if(!fs.existsSync(_filePath)) throw new Error('File upload: file not found: '+_filePath);
      const _ul=await resolveStepLocator(page, step, r);
      await _ul.first().setInputFiles(_filePath);
      break;}
    case 'dialog':{
      // Register a one-time dialog handler for the next dialog that appears.
      // v1.2.7-fix: previously this used page.once() with no cleanup. If a row's
      // trigger click didn't actually fire a dialog — e.g. PestPac skipped the
      // warning because the employee already had access rights — the listener
      // stayed attached. Each subsequent row registered another, until a row
      // that DID fire a dialog made all stacked listeners run, all racing to
      // .accept() the same dialog. First wins; rest crash with "Cannot accept
      // dialog which is already handled" → unhandled rejection → process exit.
      // Fix: stash the current listener on the page object and remove it before
      // registering a new one. Wrap accept/dismiss in try/catch as belt-and-
      // suspenders against any other source of double-handling.
      const matchText = step.dialogMatch||'';
      const dialogAction = step.dialogAction||'accept';
      if (page._buuDialogListener) {
        try { page.off('dialog', page._buuDialogListener); } catch(_){}
        page._buuDialogListener = null;
      }
      const handler = async dialog => {
        // Single-shot: detach immediately so a second dialog in the same row
        // doesn't re-enter THIS handler. A separate dialog step would re-register.
        try { page.off('dialog', handler); } catch(_){}
        if (page._buuDialogListener === handler) page._buuDialogListener = null;
        const msg = dialog.message();
        const matches = !matchText || msg.toLowerCase().includes(matchText.toLowerCase());
        emit({ type: 'dialog', message: msg, dialogType: dialog.type(), action: matches ? dialogAction : 'ignored' });
        try {
          if (matches) {
            if (dialogAction === 'dismiss') await dialog.dismiss();
            else await dialog.accept();
          } else {
            await dialog.dismiss();
          }
        } catch (e) {
          // Already-handled dialog (rare race) — log and move on. Don't let it
          // bubble out of an async listener as an unhandled rejection.
          emit({ type: 'log', message: 'Dialog handler swallowed error: ' + (e && e.message || e) });
        }
      };
      page._buuDialogListener = handler;
      page.on('dialog', handler);
      break;}
    case 'textedit':{
      await page.waitForSelector(step.selector,{timeout:SELECTOR_TIMEOUT});
      const currentVal = await page.$eval(step.selector, el => el.value || el.textContent || el.innerText || '');
      const rr = v => {
        // v1.2.8: same logic as the main resolver above — run-context tokens take
        // precedence over row lookup so once-flow textedit steps work.
        if(!v) return '';
        return v
          .replace(/{{CRED:companyKey}}/g, creds.companyKey||'')
          .replace(/{{CRED:username}}/g, creds.username||'')
          .replace(/{{CRED:password}}/g, creds.password||'')
          .replace(/{{([^}]+)}}/g, function(_, ref){
            if (ref === 'TODAY') return RUN_CONTEXT.today || '';
            if (ref === 'RUNID') return RUN_CONTEXT.runId || '';
            if (ref === 'PROFILE_USERNAME') return RUN_CONTEXT.profileUsername || '';
            return row[ref] !== undefined ? String(row[ref]) : '';
          });
      };
      const search = rr(step.searchVal||'');
      const replaceStr = rr(step.replaceVal||'');
      const ch = step.charVal||'@';
      const flags = (step.regexFlags||'gi');
      const ci = step.caseSensitive==='yes' ? '' : 'i';
      let newVal = currentVal;
      switch(step.editMode||'find-replace'){
        case 'find-replace':
          newVal = currentVal.split(search).join(replaceStr);
          if(step.caseSensitive!=='yes'){
            // Case-insensitive replace using split approach
            const searchLower=search.toLowerCase();
            const parts=currentVal.split('');
            let result='';let i=0;
            while(i<currentVal.length){
              if(currentVal.substring(i,i+search.length).toLowerCase()===searchLower){
                result+=replaceStr;i+=search.length;
              }else{result+=currentVal[i];i++;}
            }
            newVal=result;
          }
          break;
        case 'exact-remove':
          newVal = currentVal.split(search).join('');
          break;
        case 'partial-remove-word':
          newVal = currentVal.split(/\s+/).filter(w => !(step.caseSensitive==='yes' ? w.includes(search) : w.toLowerCase().includes(search.toLowerCase()))).join(' ').trim();
          break;
        case 'partial-remove-piece':
          newVal = currentVal.split(/\s+/).map(w => {
            const idx = step.caseSensitive==='yes' ? w.indexOf(search) : w.toLowerCase().indexOf(search.toLowerCase());
            if(idx<0) return w;
            return w.slice(0,idx) + w.slice(idx+search.length);
          }).join(' ').trim();
          break;
        case 'partial-replace-piece':
          newVal = currentVal.split(/\s+/).map(w => {
            const idx = step.caseSensitive==='yes' ? w.indexOf(search) : w.toLowerCase().indexOf(search.toLowerCase());
            if(idx<0) return w;
            return w.slice(0,idx) + replaceStr + w.slice(idx+search.length);
          }).join(' ').trim();
          break;
        case 'remove-after':
          {const idx=currentVal.indexOf(ch);if(idx>=0)newVal=currentVal.slice(0,idx);}
          break;
        case 'remove-before':
          {const idx=currentVal.indexOf(ch);if(idx>=0)newVal=currentVal.slice(idx+ch.length);}
          break;
        case 'trim':
          newVal = currentVal.trim();
          break;
        case 'remove-extra-spaces':
          newVal = currentVal.trim().replace(/  +/g,' ');
          break;
        case 'regex':
          try{newVal = currentVal.replace(new RegExp(search, flags), replace);}
          catch(e){throw new Error('Invalid regex pattern: '+search+' — '+e.message);}
          break;
      }
      // Write the new value back
      const tag = await page.$eval(step.selector, el => el.tagName.toLowerCase());
      if(tag==='input'||tag==='textarea'){
        await page.fill(step.selector, newVal);
      } else {
        await page.$eval(step.selector, (el,v) => { el.textContent=v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }, newVal);
      }
      break;}
  }
}

// v1.2.8: run a once-flow's steps sequentially against the shared page/creds context.
// Used by main() for the setup phase (before row loop) and teardown phase (after row loop).
// Phase is 'setup' or 'teardown', used purely for event labeling.
// Returns {ok: true} on success, {ok: false, error, stepIndex, stepLabel} on failure.
// Failures are NOT retried — once-flow steps run once and propagate failure to the caller.
// (retry-count from v1.2.5 only applies to per-row main flow steps; reasoning in design §6.)
async function runOnceFlow(page, steps, creds, phase){
  emit({type:'phase-start', phase: phase, stepCount: steps.length});
  const _phaseStart = Date.now();
  // synthLog-equivalent for once-flows. Mirrors main()'s synthLog but uses page.url()
  // directly since this runs outside main()'s closure.
  function _synthOnceLog(opts){
    const u = (function(){ try { return page.url() || ''; } catch { return ''; } })();
    addLog({
      row: '',
      timestamp: new Date().toISOString(),
      url: u,
      status: opts.status || 'success',
      error: opts.error || '',
      failedStep: '',
      fieldsWritten: '',
      durationMs: opts.durationMs || 0,
      phase: opts.phase || phase,
      errorCategory: opts.errorCategory || '',
      stepIndex: opts.stepIndex !== undefined ? String(opts.stepIndex) : '',
      stepType: opts.stepType || '',
      stepLabel: opts.label || '',
      selector: '',
      attemptedValue: ''
    });
  }
  for (let i = 0; i < steps.length; i++) {
    // v1.2.8 Phase 7: respect user-Stop between once-flow steps. currentMode is set by
    // the stdin readline handler. We check at step boundaries (safer than mid-step abort)
    // so the current Playwright action completes before we bail. Returns a distinct
    // {ok:false, stopped:true} so the caller (main()) can mark this as user-stop rather
    // than a step failure in the log/checkpoint.
    if (currentMode === 'stop') {
      emit({type:'phase-end', phase: phase, status: 'stopped', stepIndex: i, durationMs: Date.now() - _phaseStart});
      _synthOnceLog({status: 'stopped', label: phase + ' stopped by user before step ' + (i+1), durationMs: Date.now() - _phaseStart, stepIndex: i});
      return {ok: false, stopped: true, stepIndex: i, stepLabel: (steps[i] && (steps[i]._label||steps[i].type)) || ''};
    }
    const step = steps[i];
    const stepLabel = step._label || step.type;
    // v1.3.0 Item 9: setup/teardown participate in step mode. When the user picked
    // "Step through each step", pause before each once-flow step too — not just main-row
    // steps. Same pause-and-wait mechanism main()'s attempt() uses. Dialog steps skip the
    // pause (Item 5 rationale: they register an invisible listener, nothing to verify).
    // The pause-step event carries phase ('setup'/'teardown') so the renderer labels the
    // panel "Setup · step X of Y" instead of "Row N · step X".
    if (currentMode === 'step' && step.type !== 'dialog') {
      const _preview = resolvePreview(step, {}, creds);
      emit({type:'pause-step', phase: phase, stepIndex: i, totalSteps: steps.length, step: _preview, row: {}, mode: currentMode});
      const cmd = await waitForCommand();
      if (currentMode === 'stop') {
        emit({type:'phase-end', phase: phase, status: 'stopped', stepIndex: i, durationMs: Date.now() - _phaseStart});
        _synthOnceLog({status: 'stopped', label: phase + ' stopped by user at step ' + (i+1), durationMs: Date.now() - _phaseStart, stepIndex: i});
        return {ok: false, stopped: true, stepIndex: i, stepLabel: stepLabel};
      }
      // 'next-step' / 'run-all' / 'auto' all fall through to execute the step.
      // 'next-row' has no meaning in a once-flow (no rows) — treat as next-step.
    }
    emit({type:'phase-step', phase: phase, stepIndex: i, totalSteps: steps.length, stepType: step.type, stepLabel: stepLabel});
    try {
      // row={} — once-flows have no row context. Run-context tokens still resolve via RUN_CONTEXT.
      await runStep(page, step, {}, creds);
    } catch (e) {
      emit({type:'phase-end', phase: phase, status: 'failed', stepIndex: i, stepLabel: stepLabel, error: e.message, durationMs: Date.now() - _phaseStart});
      _synthOnceLog({status: 'error', label: phase + ' failed at step ' + (i+1) + ': ' + stepLabel, error: e.message, errorCategory: classifyError(e.message), durationMs: Date.now() - _phaseStart, stepIndex: i, stepType: step.type});
      return {ok: false, error: e.message, stepIndex: i, stepLabel: stepLabel};
    }
  }
  emit({type:'phase-end', phase: phase, status: 'success', durationMs: Date.now() - _phaseStart});
  _synthOnceLog({status: 'success', label: phase + ' complete (' + steps.length + ' steps)', durationMs: Date.now() - _phaseStart});
  return {ok: true};
}

async function main(){
  const creds=dec(fs.readFileSync(CRED_PATH,'utf8'))[0]||{};
  const totalRows=await countRows(SPREADSHEET);
  emit({type:'start',totalRows,resumeFrom:RESUME_FROM});

  // Heartbeat — emit every 5 seconds so the UI can tell the runner is alive
  // even during slow operations like login or page navigation.
  let _hbState={phase:'starting',rowIndex:0,totalRows:totalRows,startedAt:Date.now()};
  const _heartbeat=setInterval(function(){
    emit({type:'heartbeat',phase:_hbState.phase,rowIndex:_hbState.rowIndex,totalRows:_hbState.totalRows,elapsed:Date.now()-_hbState.startedAt});
  },5000);
  process.on('exit',function(){clearInterval(_heartbeat);});

  const CHROMIUM_EXE = ${JSON.stringify(chromiumExePath)};
  if (!fs.existsSync(CHROMIUM_EXE)) {
    emit({ type: 'fatal', error: 'Bundled browser not found at: ' + CHROMIUM_EXE });
    flush();
    process.exit(1);
  }
  emit({ type: 'log', message: 'Using browser: ' + CHROMIUM_EXE });
  // v1.3.4 Phase 2: incognito + lean launch. newContext() is already a fresh isolated
  // (incognito-equivalent) context — no shared cookies/cache. We make it explicit and add
  // launch args that cut per-worker resource use, which matters a lot in the worker pool
  // (many Chromiums at once). --disable-gpu only when headless (no rendering surface needed).
  const _launchArgs = ['--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'];
  if (HEADLESS) _launchArgs.push('--disable-gpu');
  const browser = await chromium.launch({ headless: HEADLESS, executablePath: CHROMIUM_EXE, args: _launchArgs });
  // Explicit fresh incognito context. No persistent storage — every worker starts clean,
  // which also sidesteps PestPac session/cache cruft that can slow first navigations.
  const _ctx = await browser.newContext();
  const page = await _ctx.newPage();
  let ri=0,ok=0,errs=0,skipped=0,start=Date.now();
  // v1.2.5 item 2.3b: circuit breaker state
  let consecutiveErrors=0,lastSuccessfulRow=0,_breakerTripped=false;
  // v1.2.5 item 2.7: track user-initiated stops so the finally block can preserve
  // the checkpoint and annotate it with lastStop info.
  let _userStopRequested=false;

  // v1.2.5 item 2.10 (Phase 8, sub 2): synthetic log entries for run-level events
  // (initial login, re-auth, breaker trip, fatal). These appear as All-rows timeline
  // entries with empty row number and explicit Phase column, so the user can see WHEN
  // auth events / failures happened relative to row processing.
  // status values per design: 'success' | 'error' | 'reauth' | 'circuit-breaker'.
  function synthLog(opts){
    const u = (function(){ try { return page.url() || ''; } catch { return ''; } })();
    addLog({
      row: '',
      timestamp: new Date().toISOString(),
      url: u,
      status: opts.status || 'success',
      error: opts.error || '',
      failedStep: '',
      fieldsWritten: '',
      durationMs: opts.durationMs || 0,
      // 2.10 enrichment fields — synthetic entries set Phase, leave step columns empty
      phase: opts.phase || '',
      errorCategory: opts.errorCategory || '',
      stepIndex: '',
      stepType: '',
      stepLabel: opts.label || '',  // label is the human description of the event
      selector: '',
      attemptedValue: ''
    });
  }

  // Run login steps once before the row loop
  _hbState.phase='logging-in';
  const _loginStartedAt = Date.now();
  for(const step of LOGIN_STEPS){
    try{ await runStep(page,step,{},creds); }
    catch(e){
      // v1.2.5 item 2.10 sub 2: synthetic 'init' entry for failed initial login.
      synthLog({phase:'init',status:'error',label:'Initial login failed at step: '+(step._label||step.type),error:e.message,durationMs:Date.now()-_loginStartedAt,errorCategory:classifyError(e.message)});
      emit({type:'fatal',error:'Login failed at step '+( step._label||step.type)+': '+e.message});
      flush();
      await browser.close();
      process.exit(1);
    }
  }
  // v1.2.5 item 2.10 sub 2: synthetic 'init' entry for successful initial login.
  synthLog({phase:'init',status:'success',label:'Initial login complete',durationMs:Date.now()-_loginStartedAt});

  // v1.2.8: Phase 1 of the three-phase pipeline — setup once-flow.
  // Runs after login, before the per-row loop. Failure is fatal (no rows attempted, no
  // teardown attempted). Skipped when no setup steps were declared.
  // Track whether setup succeeded so the finally block knows whether teardown should run.
  let _setupCompleted = false;
  // v1.2.8: run-teardown-only resume action skips setup AND the row loop entirely.
  // We bypass both phases and let the finally block run teardown only.
  // _setupCompleted is set true unconditionally so the teardown gate passes.
  const _teardownOnlyMode = (RESUME_ACTION === 'run-teardown-only');
  if (_teardownOnlyMode) {
    emit({type:'log', message: 'Resume mode: run-teardown-only. Skipping setup and row loop.'});
    _setupCompleted = true;
  } else if (SETUP_STEPS && SETUP_STEPS.length > 0) {
    _hbState.phase = 'setup';
    const _setupResult = await runOnceFlow(page, SETUP_STEPS, creds, 'setup');
    if (!_setupResult.ok) {
      // v1.2.8 Phase 7: distinguish user-stop (clean exit) from failure (annotated as fatal).
      if (_setupResult.stopped) {
        emit({type:'log', message: 'Setup stopped by user. Skipping row loop and teardown.'});
        try{
          if(fs.existsSync(CHECKPOINT)){
            const cp = JSON.parse(fs.readFileSync(CHECKPOINT,'utf8'));
            cp.lastStop = {phase: 'setup', stepIndex: _setupResult.stepIndex, ts: new Date().toISOString()};
            cp.phaseProgress = {setupCompleted: false, mainRowIndex: 0, teardownCompleted: false};
            fs.writeFileSync(CHECKPOINT, JSON.stringify(cp));
          }
        }catch{}
        flush();
        await browser.close();
        clearInterval(_heartbeat);
        process.exit(0);  // clean exit — user requested
      }
      // Genuine setup failure — fatal.
      emit({type:'fatal', error: 'Setup failed at step ' + (_setupResult.stepIndex + 1) + ': ' + _setupResult.error});
      flush();
      await browser.close();
      clearInterval(_heartbeat);
      // v1.2.5 item 2.7: annotate checkpoint so the resume modal can show the setup failure.
      try{
        if(fs.existsSync(CHECKPOINT)){
          const cp = JSON.parse(fs.readFileSync(CHECKPOINT,'utf8'));
          cp.lastError = {phase: 'setup', message: _setupResult.error, stepIndex: _setupResult.stepIndex, stepLabel: _setupResult.stepLabel, ts: new Date().toISOString()};
          // v1.2.8: track which phase progress is at, so resume can offer the right recovery.
          cp.phaseProgress = {setupCompleted: false, mainRowIndex: 0, teardownCompleted: false};
          fs.writeFileSync(CHECKPOINT, JSON.stringify(cp));
        }
      }catch{}
      process.exit(1);
    }
    _setupCompleted = true;
    markPhaseDone('setup');  // v1.2.8 Phase 4: persist setup completion so resume knows
  } else {
    // No setup phase declared — trivially "completed" so teardown gates still work.
    _setupCompleted = true;
  }

  // v1.2.5 item 2.11 (Phase 7): re-auth state and helpers.
  // Three triggers fire maybeReauth(reason):
  //   1. Timer: at row boundaries when Date.now() >= nextReauthAt (REAUTH_INTERVAL_MS=0 disables)
  //   2. Connectivity-wait: after waitForNetwork() returns waitedMs > 10*60*1000
  //   3. Detection: at row-start when isOnLoginPage() returns true
  // Re-auth never interleaves with row execution — all triggers fire at row boundaries
  // (or during the network-wait gate, which is between rows by definition).
  let nextReauthAt = REAUTH_INTERVAL_MS > 0 ? Date.now() + REAUTH_INTERVAL_MS : 0;
  async function maybeReauth(reason){
    emit({type:'log',message:'Re-authenticating ('+reason+')…'});
    _hbState.phase='reauth-'+reason;
    // v1.2.5 item 2.10 sub 2: synthetic timeline entry — re-auth started.
    const _reauthStartedAt = Date.now();
    try{
      await loginToPestPac(page, creds);
      // Reset the timer regardless of which trigger fired — a fresh login means
      // we don't need another timer-based re-auth for REAUTH_INTERVAL_MS.
      if(REAUTH_INTERVAL_MS > 0) nextReauthAt = Date.now() + REAUTH_INTERVAL_MS;
      emit({type:'log',message:'Re-auth complete ('+reason+'). Continuing.'});
      _hbState.phase='running';
      // v1.2.5 item 2.10 sub 2: synthetic timeline entry — re-auth succeeded.
      synthLog({phase:'reauth',status:'reauth',label:'Re-auth ('+reason+') succeeded',durationMs:Date.now()-_reauthStartedAt});
    }catch(e){
      // v1.2.5 item 2.10 sub 2: synthetic timeline entry — re-auth failed.
      synthLog({phase:'reauth',status:'error',label:'Re-auth ('+reason+') failed',error:e.message,durationMs:Date.now()-_reauthStartedAt,errorCategory:classifyError(e.message)});
      // Re-auth failure is fatal — we can't proceed without a valid session.
      emit({type:'fatal',error:'Re-auth failed ('+reason+'): '+e.message});
      throw e;  // Caught by main()'s outer catch which writes lastError and exits.
    }
  }
  function isOnLoginPage(){
    try{
      const u = page.url() || '';
      // Match login.pestpac.com domain (initial login destination + session-expired redirect).
      return /login\\.pestpac\\.com/i.test(u);
    }catch{return false;}
  }

  try{
    _hbState.phase='running';
    // Emit initial mode so UI can position itself before the first row.
    emit({type:'mode',mode:currentMode});
    let _stopRequested=false;
    // v1.2.8: in teardown-only mode, skip the row loop entirely by pre-setting _stopRequested.
    // The for-await will check this on the very first iteration and bail without doing work.
    // We avoid an early-return here because we still want to fall through to the finally
    // block (which runs teardown when _setupCompleted is true).
    if (_teardownOnlyMode) {
      _stopRequested = true;
      emit({type:'log', message: 'Skipping row loop in teardown-only mode.'});
    }
    for await(const row of streamRows(SPREADSHEET)){
      if(_stopRequested) break;
      ri++;
      if(ri<=RESUME_FROM)continue;
      // v1.3.4 Phase 3: worker-pool upper bound. Once past this worker's slice, stop —
      // remaining rows belong to other workers. END_ROW=0 means no bound (full sheet).
      if(END_ROW > 0 && ri > END_ROW) break;
      // v1.2.5 item 2.12: retry-failed mode skips any source row not in the retry set.
      // Increment ri (so log row numbers match source) but skip processing entirely.
      if(IS_RETRY_RUN && !RETRY_ROW_INDEXES.has(ri)) continue;
      _hbState.rowIndex=ri;
      saveChk(ri);

      // v1.2.5 item 2.11 (Phase 7): re-auth at row boundary.
      // Trigger 1 (timer): proactive re-auth before session expires. nextReauthAt=0 disables.
      if(nextReauthAt > 0 && Date.now() >= nextReauthAt){
        try{ await maybeReauth('timer'); }
        catch(e){ _stopRequested=true; break; }
      }
      // Trigger 3 (detection): if we're sitting on the login page, the session expired.
      // Re-auth before the row's navigate steps so they don't all fail with "selector not found".
      // Skipped if trigger 1 already ran (page is now post-login).
      else if(isOnLoginPage()){
        try{ await maybeReauth('detected-login-page'); }
        catch(e){ _stopRequested=true; break; }
      }

      emit({type:'row-start',rowIndex:ri,rowNum:ri,totalRows,url:row.URL||row.url||''});
      const t0=Date.now();
      const entry={row:ri,timestamp:new Date().toISOString(),url:row.URL||row.url||'',status:'ok',error:'',failedStep:'',fieldsWritten:'',durationMs:0,
        // v1.2.5 item 2.10 (Phase 8): rich error-attribution columns. Populated only on failure.
        errorCategory:'',phase:'',stepIndex:'',stepType:'',stepLabel:'',selector:'',attemptedValue:''};
      let done=[];
      // v1.2.5 item 2.10: tracks the in-flight step for attribution when runStep throws.
      // Updated by attempt() before each runStep call. Read by the outer catch.
      let _currentStepCtx=null;

      // attempt() walks DATA_STEPS, pausing before each step when in 'step' mode.
      // Throws '__STOP__' if user requested stop (caught below); throws '__NEXT_ROW__'
      // to short-circuit out of the step loop and proceed to the next row.
      const attempt=async()=>{
        done=[];
        for(let si=0;si<DATA_STEPS.length;si++){
          const s=DATA_STEPS[si];
          // v1.2.5 item 2.10: capture step context BEFORE runStep so the outer catch
          // (which doesn't have access to si) can attribute the error correctly.
          const _preview=resolvePreview(s,row,creds);
          _currentStepCtx={
            stepIndex:si,
            totalSteps:DATA_STEPS.length,
            stepType:s.type||'',
            stepLabel:s._label||'',
            selector:s.selector||'',
            attemptedValue:_preview.value||''
          };
          if(currentMode==='step' && s.type !== 'dialog'){
            // v1.3.0 Item 5: skip the pause for dialog steps. A dialog step just registers a
            // one-shot page.on('dialog') listener — nothing visible happens until the NEXT step
            // (usually a click) fires the dialog. Pausing here would make the user hit Next on
            // an invisible no-op, then immediately hit Next again on the real action. Annoying
            // and confusing. The dialog handler still runs whenever the dialog actually fires.
            emit({type:'pause-step',rowIndex:ri,totalRows,stepIndex:si,totalSteps:DATA_STEPS.length,step:_preview,row,mode:currentMode});
            const cmd=await waitForCommand();
            if(currentMode==='stop') throw new Error('__STOP__');
            if(cmd==='next-row') throw new Error('__NEXT_ROW__');
            // 'next-step' / 'run-all' / 'auto' all fall through to execute
          }
          await runStep(page,s,row,creds);
          done.push(s._label||s.type);
        }
        // Cleared after a successful walk so retry attempts don't carry stale context.
        _currentStepCtx=null;
      };

      try{
        await attempt();
        entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;ok++;
        // v1.2.5 item 2.3b: success resets the circuit breaker
        consecutiveErrors=0;lastSuccessfulRow=ri;
        emit({type:'row-done',rowIndex:ri,totalRows,status:'ok',url:entry.url,fieldsWritten:entry.fieldsWritten,durationMs:entry.durationMs,ok,errs,skipped,elapsed:Date.now()-start});
      }catch(e){
        // Clean stop sentinel — bail out of the row loop entirely.
        if(e && e.message==='__STOP__'){
          entry.status='stopped';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;
          addLog(entry);
          emit({type:'stopped',rowIndex:ri,reason:'user'});
          _userStopRequested=true;
          _stopRequested=true;
          break;
        }
        // User chose Next-row mid-step — record what got done, count as skip, move on.
        if(e && e.message==='__NEXT_ROW__'){
          entry.status='skip';entry.error='Skipped via Next-row during step-through';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;
          skipped++;
          emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:'(user skipped)',url:entry.url,ok,errs,skipped,elapsed:Date.now()-start});
        }else{
          // v1.2.5 item 2.8 (Phase 7): Network-aware retry gate.
          // Probe AFTER the failure to decide what kind of failure this is. If PestPac is
          // unreachable, wait for connectivity to come back and only THEN fall through to
          // the existing retry/skip logic — so the bounded retry attempts run on a fresh
          // connection instead of burning all 2 attempts during a multi-minute outage.
          // (This is the fix for the 5/1 disaster pattern: lost connectivity at row N,
          // 1991 subsequent rows all 'failed' because retries hit the same dead network.)
          try {
            if (await probeNetwork() === false) {
              emit({type:'log',message:'Network down detected at row '+ri+' — waiting for reconnection before retry. (User Stop will exit cleanly.)'});
              const waitedMs = await waitForNetwork();
              emit({type:'log',message:'Network restored after '+Math.round(waitedMs/1000)+'s. Resuming row '+ri+'.'});
              // v1.2.5 item 2.11 trigger 2: long outage probably expired the session.
              // Re-auth before the retry attempts so they don't waste budget hitting the login page.
              if (waitedMs > 10 * 60 * 1000) {
                try { await maybeReauth('connectivity-wait'); }
                catch(e){ _stopRequested=true; break; }
              }
            }
          } catch (waitErr) {
            // waitForNetwork() throws __STOP__ when user clicks Stop during the wait loop.
            if (waitErr && waitErr.message === '__STOP__') {
              entry.status='stopped';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;
              addLog(entry);
              emit({type:'stopped',rowIndex:ri,reason:'user-during-network-wait'});
              _userStopRequested=true;
              _stopRequested=true;
              break;
            }
            // Unexpected error from the network gate itself — log and fall through.
            emit({type:'log',message:'Network gate unexpected error: '+(waitErr && waitErr.message)+' — continuing with retry logic'});
          }
          // Fall through to the existing retry/skip handling. If we just waited for
          // connectivity, the retry attempts now operate on a fresh connection.
          if(ERR_HANDLE==='retry'){
          // v1.2.5 item 2.8: configurable retry count (was hardcoded 1 attempt).
          let retryAttempt = 0;
          let retrySucceeded = false;
          let lastError = e;
          while(retryAttempt < RETRY_COUNT && !retrySucceeded){
            retryAttempt++;
            emit({type:'row-retry',rowIndex:ri,error:lastError.message,attempt:retryAttempt,maxAttempts:RETRY_COUNT});
            try{
              await attempt();
              entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;entry.status='ok (retry)';ok++;
              emit({type:'row-done',rowIndex:ri,totalRows,status:'ok-retry',url:entry.url,fieldsWritten:entry.fieldsWritten,durationMs:entry.durationMs,ok,errs,skipped,elapsed:Date.now()-start});
              retrySucceeded = true;
            }catch(e2){
              // Retry-attempt sentinels also possible
              if(e2 && e2.message==='__STOP__'){entry.status='stopped';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;addLog(entry);emit({type:'stopped',rowIndex:ri,reason:'user'});_userStopRequested=true;_stopRequested=true;break;}
              if(e2 && e2.message==='__NEXT_ROW__'){entry.status='skip';entry.error='Skipped via Next-row during step-through';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;skipped++;emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:'(user skipped)',url:entry.url,ok,errs,skipped,elapsed:Date.now()-start});retrySucceeded=true;break;}
              lastError = e2;
            }
          }
          if(_stopRequested) break;
          if(!retrySucceeded){
            const errMsg = retryAttempt === 0 ? e.message : ('After '+retryAttempt+' retry attempt(s): '+lastError.message);
            entry.status='skip';entry.error=errMsg;entry.failedStep=done[done.length-1]||'?';entry.fieldsWritten=done.slice(0,-1).join(' | ');entry.durationMs=Date.now()-t0;skipped++;
            // v1.2.5 item 2.10 (Phase 8): populate rich error-attribution columns from
            // the in-flight step ctx + classifier. Truncate attemptedValue per design.
            if(_currentStepCtx){
              entry.stepIndex='Step '+(_currentStepCtx.stepIndex+1)+' of '+_currentStepCtx.totalSteps;
              entry.stepType=_currentStepCtx.stepType;
              entry.stepLabel=_currentStepCtx.stepLabel;
              entry.selector=_currentStepCtx.selector;
              const av=_currentStepCtx.attemptedValue||'';
              entry.attemptedValue = av.length > 100 ? (av.slice(0,100)+'…') : av;
            }
            entry.errorCategory=classifyError(errMsg);
            entry.phase=classifyPhase(errMsg);
            // v1.2.5 item 2.3b: counts toward circuit breaker (BUU tried, couldn't make it work)
            consecutiveErrors++;
            emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:entry.failedStep,url:entry.url,ok,errs,skipped,elapsed:Date.now()-start,
              // v1.2.5 item 2.10: pass enrichment fields through to the live UI so the renderer can show e.g. status='skip' instead of misclassifying as 'FAILED'.
              status:entry.status,errorCategory:entry.errorCategory,phase:entry.phase,stepIndex:entry.stepIndex,stepType:entry.stepType});
          }
          }else{
            // ERR_HANDLE === 'skip' (legacy 'stop' handled by renderer-side upgrade per item 2.3)
            entry.status='skip';entry.error=e.message;entry.failedStep=done[done.length-1]||'?';entry.fieldsWritten=done.slice(0,-1).join(' | ');entry.durationMs=Date.now()-t0;
            // v1.2.5 item 2.10 (Phase 8): same enrichment as the retry-exhausted branch above.
            if(_currentStepCtx){
              entry.stepIndex='Step '+(_currentStepCtx.stepIndex+1)+' of '+_currentStepCtx.totalSteps;
              entry.stepType=_currentStepCtx.stepType;
              entry.stepLabel=_currentStepCtx.stepLabel;
              entry.selector=_currentStepCtx.selector;
              const av=_currentStepCtx.attemptedValue||'';
              entry.attemptedValue = av.length > 100 ? (av.slice(0,100)+'…') : av;
            }
            entry.errorCategory=classifyError(e.message);
            entry.phase=classifyPhase(e.message);
            skipped++;
            // v1.2.5 item 2.3b: counts toward circuit breaker
            consecutiveErrors++;
            emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:entry.failedStep,url:entry.url,ok,errs,skipped,elapsed:Date.now()-start,
              status:entry.status,errorCategory:entry.errorCategory,phase:entry.phase,stepIndex:entry.stepIndex,stepType:entry.stepType});
          }
        }
      }
      addLog(entry);

      // v1.2.5 item 2.3b: circuit breaker check. After threshold consecutive failures, stop the run
      // and preserve the checkpoint so user can resume. User-initiated skips (__NEXT_ROW__) don't
      // increment the counter, so they don't trip this.
      if(BREAKER_THRESHOLD > 0 && consecutiveErrors >= BREAKER_THRESHOLD){
        _breakerTripped=true;
        // Annotate the checkpoint with breaker info. Schema additions are forward-compatible — Phase 6 (item 2.7)
        // will generalize this with a richer lastError/lastStop schema, but this minimal write is enough today.
        try{
          if(fs.existsSync(CHECKPOINT)){
            const cp=JSON.parse(fs.readFileSync(CHECKPOINT,'utf8'));
            cp.lastError={phase:'circuit-breaker',consecutiveErrors,lastSuccessfulRow,rowIndex:ri,ts:new Date().toISOString()};
            fs.writeFileSync(CHECKPOINT,JSON.stringify(cp));
          }
        }catch(e){
          emit({type:'log',message:'Warning: could not annotate checkpoint with breaker info: '+e.message});
        }
        emit({type:'circuit-breaker',rowIndex:ri,totalRows,consecutiveErrors,lastSuccessfulRow,ok,errs,skipped,elapsed:Date.now()-start});
        // v1.2.5 item 2.10 sub 2: synthetic timeline entry — breaker trip.
        synthLog({phase:'cleanup',status:'circuit-breaker',label:'Circuit breaker tripped after '+consecutiveErrors+' consecutive errors near row '+ri,error:'Last successful row: '+lastSuccessfulRow});
        _stopRequested=true;
        break;
      }

      // Row-pause point: if we're in step-row mode and not the last row, wait for user.
      // Pause comes BEFORE the inter-row delay so the wait isn't doubled while user is looking.
      if(currentMode==='step-row' && ri<totalRows && !_stopRequested){
        emit({type:'pause-row',rowIndex:ri,totalRows,ok,errs,skipped,elapsed:Date.now()-start,mode:currentMode});
        await waitForCommand();
        if(currentMode==='stop'){_userStopRequested=true;_stopRequested=true; break;}
      }

      if(ri<totalRows && !_stopRequested){const delay=Math.floor(Math.random()*(ROW_DELAY_MAX-ROW_DELAY_MIN+1))+ROW_DELAY_MIN;await page.waitForTimeout(delay);}
    }
  }finally{
    _hbState.phase='cleanup';
    flush();
    // v1.2.5 item 2.7: preserve checkpoint for any non-clean exit (breaker, user stop, fatal).
    // The runner's stop paths set _breakerTripped or _userStopRequested. The fatal path
    // (main().catch) writes lastError directly before exit and never reaches this finally.
    const _preserveCheckpoint = _breakerTripped || _userStopRequested;
    // Annotate user stops with lastStop. Breaker already wrote its own lastError above.
    if(_userStopRequested){
      try{
        if(fs.existsSync(CHECKPOINT)){
          const cp=JSON.parse(fs.readFileSync(CHECKPOINT,'utf8'));
          cp.lastStop={phase:'user-stop',rowIndex:ri,lastSuccessfulRow,ts:new Date().toISOString()};
          fs.writeFileSync(CHECKPOINT,JSON.stringify(cp));
        }
      }catch(e){
        emit({type:'log',message:'Warning: could not annotate checkpoint with stop info: '+e.message});
      }
    }
    if(!_preserveCheckpoint){
      try{fs.unlinkSync(CHECKPOINT);}catch{}
    }
    // v1.2.8: Phase 3 of the three-phase pipeline — teardown once-flow.
    // Runs on completed / breaker / user-stop, NOT on setup-fail (we exited above) and
    // NOT on fatal mid-loop (caught by main().catch). Gated on _setupCompleted to skip
    // teardown when setup never ran successfully.
    let _teardownCompleted = false;
    if (_setupCompleted && TEARDOWN_STEPS && TEARDOWN_STEPS.length > 0) {
      _hbState.phase = 'teardown';
      try {
        const _teardownResult = await runOnceFlow(page, TEARDOWN_STEPS, creds, 'teardown');
        if (_teardownResult.ok) {
          _teardownCompleted = true;
          markPhaseDone('teardown');  // v1.2.8 Phase 4: persist teardown completion
        } else {
          // v1.2.8 Phase 7: distinguish user-stop from genuine failure. Either way teardown
          // didn't finish — but the resume modal labels them differently and the user's
          // recovery affordance is the same: "Run teardown only" via the resume modal.
          try {
            if (fs.existsSync(CHECKPOINT)) {
              const cp = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));
              if (_teardownResult.stopped) {
                cp.lastStop = cp.lastStop || {phase: 'teardown', stepIndex: _teardownResult.stepIndex, ts: new Date().toISOString()};
              } else {
                cp.lastError = cp.lastError || {phase: 'teardown', message: _teardownResult.error, stepIndex: _teardownResult.stepIndex, stepLabel: _teardownResult.stepLabel, ts: new Date().toISOString()};
              }
              cp.phaseProgress = {setupCompleted: true, mainRowIndex: ri, teardownCompleted: false};
              fs.writeFileSync(CHECKPOINT, JSON.stringify(cp));
            }
          } catch {}
        }
      } catch (e) {
        // Defensive — runOnceFlow shouldn't throw (it catches internally), but if it does
        // we don't want to crash the cleanup path.
        emit({type:'log', message: 'Teardown phase threw unexpectedly: ' + e.message});
      }
      flush();
    } else {
      // No teardown declared, OR setup never ran. Mark "completed" for resume logic.
      _teardownCompleted = true;
    }
    try{await runStep(page,LOGOUT_STEP,{},creds);}catch{}
    await browser.close();
    clearInterval(_heartbeat);
  }
  emit({type:'complete',totalRows:ri,ok,errs,skipped,elapsed:Date.now()-start,logPath:LOG_PATH});
}

main().catch(e=>{
  emit({type:'fatal',error:e.message});
  // v1.2.5 item 2.7: annotate checkpoint so the resume modal can show what went wrong.
  // The finally block in main() never ran, so we write directly here. Checkpoint is preserved
  // by virtue of NOT calling unlinkSync (the only deletion path lives in the finally block).
  try{
    if(fs.existsSync(CHECKPOINT)){
      const cp=JSON.parse(fs.readFileSync(CHECKPOINT,'utf8'));
      cp.lastError={phase:'fatal',message:e.message,stack:(e.stack||'').split('\\n').slice(0,5).join('\\n'),ts:new Date().toISOString()};
      fs.writeFileSync(CHECKPOINT,JSON.stringify(cp));
    }
  }catch{}
  try{flush();}catch{}
  process.exit(1);
});
`;
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
  } = cfg;
  return `
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const _nm = process.env.NODE_PATH || path.join(__dirname);
function _require(mod){ try{return require(mod);}catch(e){ try{return require(path.join(_nm,mod));}catch(e2){ throw new Error('Cannot find: '+mod); } } }
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
const CHROMIUM_EXE = ${JSON.stringify(chromiumExePath)};
const FLOW_STEPS = ${JSON.stringify(flowSteps)};
const SETUP_STEPS = ${JSON.stringify(setupSteps)};
const TEARDOWN_STEPS = ${JSON.stringify(teardownSteps)};
const RUN_CONTEXT = ${JSON.stringify(runContext)};
const LOGIN_STEPS = FLOW_STEPS.filter(s => s.locked && s.type !== 'pestpac-logout');
const DATA_STEPS  = FLOW_STEPS.filter(s => !s.locked && s.type !== 'pestpac-logout');
const LOGOUT_STEP = FLOW_STEPS.find(s => s.type === 'pestpac-logout') || {type:'pestpac-logout'};

const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\\n');}

// ── stdin command channel: receives {cmd:'batch',rows:[...]} or {cmd:'drain'} ──
let _pendingBatchResolve = null;
// v2.1.0: a drain command can arrive AT ANY TIME (mid-row, mid-batch). We set a global flag
// immediately so the row loop can stop after the current row and log out cleanly, instead of
// only noticing drain at the next batch boundary (which, with slow pages, meant the coordinator
// force-killed the worker mid-row before it could log out - leaving sessions logged in).
let _draining = false;
const _readline = require('readline');
const _rl = _readline.createInterface({ input: process.stdin, terminal: false });
_rl.on('line', function(line){
  let msg; try{ msg = JSON.parse(line); }catch(e){ return; }
  if(!msg || !msg.cmd) return;
  if(msg.cmd === 'drain'){ _draining = true; }
  if(_pendingBatchResolve){ const r=_pendingBatchResolve; _pendingBatchResolve=null; r(msg); }
});
function requestBatch(){
  emit({type:'request-batch'});
  return new Promise(function(r){ _pendingBatchResolve = r; });
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

async function loginToPestPac(page, creds){
  await page.goto(creds.loginUrl||'https://login.pestpac.com/',{waitUntil:'load',timeout:30000});
  await page.waitForSelector('input[name="uid"]',{timeout:15000});
  await page.fill('input[name="uid"]',creds.companyKey||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{force:true}); }
  await page.waitForSelector('input[name="username"]',{timeout:15000});
  await page.fill('input[name="username"]',creds.username||'');
  await page.fill('input[name="password"]',creds.password||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="loginBtn"]',{force:true}); }
  await page.waitForSelector('a[href*="AutoLogin"]',{timeout:30000});
}

async function findLocator(page, selector, opts){
  opts=opts||{}; const timeoutMs=opts.timeout||30000; const startedAt=Date.now();
  while(Date.now()-startedAt<timeoutMs){
    try{ const top=page.locator(selector); if(await top.count()>0) return top; }catch(_){}
    const main=page.mainFrame();
    for(const f of page.frames()){ if(f===main) continue; try{ const inF=f.locator(selector); if(await inF.count()>0) return inF; }catch(_){} }
    await new Promise(function(r){ setTimeout(r,250); });
  }
  throw new Error('Selector "'+selector+'" not found in any frame after '+timeoutMs+'ms');
}
function matchesText(h,n,mode){ h=(h==null?'':String(h)); n=(n==null?'':String(n)); switch(mode||'contains'){ case 'exact':return h.trim()===n.trim(); case 'starts':return h.trim().indexOf(n.trim())===0; case 'ends':{var ht=h.trim(),nt=n.trim();return nt.length<=ht.length&&ht.lastIndexOf(nt)===(ht.length-nt.length);} case 'contains-ci':return h.trim().toLowerCase().indexOf(n.trim().toLowerCase())!==-1; case 'exact-ci':return h.trim().toLowerCase()===n.trim().toLowerCase(); case 'regex':try{return new RegExp(n).test(h);}catch(e){throw new Error('regex invalid: '+n);} default:return h.trim().indexOf(n.trim())!==-1; } }
async function findInContainer(page, containerSel, matchText, targetSel, mode, opts){
  opts=opts||{}; const timeoutMs=opts.timeout||30000; const startedAt=Date.now();
  while(Date.now()-startedAt<timeoutMs){
    const frames=[page.mainFrame()]; for(const f of page.frames()){ if(f!==page.mainFrame()) frames.push(f); }
    const matched=[];
    for(const f of frames){ let containers; try{ containers=f.locator(containerSel); }catch(e){ continue; } let count; try{ count=await containers.count(); }catch(e){ continue; }
      for(let ci=0; ci<count; ci++){ let txt=''; try{ txt=await containers.nth(ci).innerText({timeout:2000}); }catch(e){ try{ txt=await containers.nth(ci).textContent({timeout:2000})||''; }catch(e2){ txt=''; } } if(matchesText(txt,matchText,mode)) matched.push({frame:f,index:ci}); } }
    if(matched.length===1){ const m=matched[0]; const c=m.frame.locator(containerSel).nth(m.index); return targetSel?c.locator(targetSel):c; }
    if(matched.length>1) throw new Error('Find-by-text matched '+matched.length+' containers for "'+matchText+'"; expected 1.');
    await new Promise(function(r){ setTimeout(r,250); });
  }
  throw new Error('Find-by-text found no container matching "'+matchText+'"');
}
async function resolveStepLocator(page, step, resolveFn){
  if(step.findByText){ const m=resolveFn(step.matchText||''); return await findInContainer(page, step.containerSel||'', m, step.selector||'', step.matchMode||'contains', {timeout:SELECTOR_TIMEOUT}); }
  return await findLocator(page, step.selector, {timeout:SELECTOR_TIMEOUT});
}

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
  // v2.1.0: emit step progress (e.g. step 7/8) so the UI can show what each worker is doing.
  const attempt=async()=>{ done.length=0; for(let si=0;si<DATA_STEPS.length;si++){ emit({type:'step', row:rowNum, step:si+1, totalSteps:DATA_STEPS.length}); await runStep(page, DATA_STEPS[si], row, creds); done.push(DATA_STEPS[si]._label||DATA_STEPS[si].type); } };
  try{ await attempt(); return {status:'ok', fieldsWritten:done.join(' | ')}; }
  catch(e){
    if(ERR_HANDLE==='retry'){
      let attemptN=0, lastErr=e;
      while(attemptN<RETRY_COUNT){ attemptN++; try{ await attempt(); return {status:'ok (retry)', fieldsWritten:done.join(' | ')}; }catch(e2){ lastErr=e2; } }
      return {status:'skip', error:('After '+attemptN+' retries: '+lastErr.message), failedStep:done[done.length-1]||'?'};
    }
    return {status:'skip', error:e.message, failedStep:done[done.length-1]||'?'};
  }
}

async function main(){
  const creds=dec(fs.readFileSync(CRED_PATH,'utf8'))[0]||{};
  const ALL_ROWS = loadAllRows(SPREADSHEET);
  const browser = await chromium.launch({ headless:true, executablePath:CHROMIUM_EXE, args:['--disable-gpu','--disable-dev-shm-usage','--disable-background-timer-throttling'] });
  const page = await (await browser.newContext()).newPage();

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
  while(!_draining){
    const msg = await requestBatch();
    if(!msg || msg.cmd==='drain' || _draining){ break; }
    if(msg.cmd!=='batch' || !Array.isArray(msg.rows) || msg.rows.length===0){ continue; }
    for(let _bi=0; _bi<msg.rows.length; _bi++){
      const rowNum = msg.rows[_bi];
      if(_draining){ break; }
      const row = ALL_ROWS[rowNum-1];
      if(!row){ emit({type:'row-result', row:rowNum, status:'skip', error:'row index out of range'}); continue; }
      // batchPos/batchSize = e.g. 3/10 (which row of this batch); totalSteps for the step counter.
      emit({type:'row-start', row:rowNum, batchPos:_bi+1, batchSize:msg.rows.length});
      const t0=Date.now();
      const res = await processRow(page, row, creds, rowNum);
      const entry={ row:rowNum, timestamp:new Date().toISOString(), url:row.URL||row.url||'', status:res.status, error:res.error||'', failedStep:res.failedStep||'', fieldsWritten:res.fieldsWritten||'', durationMs:Date.now()-t0 };
      addLog(entry);
      // v2.2.0: include any read-field values captured this row so the coordinator can write the
      // dedicated results workbook. row.__reads is { colName: {value,label,out} }.
      emit({type:'row-result', row:rowNum, status:res.status, error:res.error||'', durationMs:Date.now()-t0, reads: row.__reads||null});
    }
  }

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

async function findLocator(page, selector, opts){
  if(selector && selector.startsWith('xpath=')) return page.locator(selector);
  return page.locator(selector);
}
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
async function loginToPestPac(page, creds){
  await page.goto(creds.loginUrl||'https://login.pestpac.com/',{waitUntil:'load',timeout:30000});
  await page.waitForSelector('input[name="uid"]',{timeout:15000});
  await page.fill('input[name="uid"]',creds.companyKey||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{force:true}); }
  await page.waitForSelector('input[name="username"]',{timeout:15000});
  await page.fill('input[name="username"]',creds.username||'');
  await page.fill('input[name="password"]',creds.password||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="LoginForm-loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="LoginForm-loginBtn"]',{force:true}); }
  await page.waitForLoadState('load',{timeout:30000});
}

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
async function loginToPestPac(page, creds){
  await page.goto(creds.loginUrl||'https://login.pestpac.com/',{waitUntil:'load',timeout:30000});
  await page.waitForSelector('input[name="uid"]',{timeout:15000});
  await page.fill('input[name="uid"]',creds.companyKey||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{force:true}); }
  await page.waitForSelector('input[name="username"]',{timeout:15000});
  await page.fill('input[name="username"]',creds.username||'');
  await page.fill('input[name="password"]',creds.password||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="LoginForm-loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="LoginForm-loginBtn"]',{force:true}); }
  await page.waitForLoadState('load',{timeout:30000});
}
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
