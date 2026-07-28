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

// Phase 3 CRASH SAFETY: pidfile of live worker processes. If the coordinator dies
// (crash, force-close), the next launch reads this file and kills any survivors whose
// PID still resolves to our own executable name (guards against PID reuse).
const PIDFILE = () => path.join(app.getPath('userData'), 'worker-pids.json');
function coordPidfileRead(){ try { return JSON.parse(fs.readFileSync(PIDFILE(), 'utf8')).pids || []; } catch(e){ return []; } }
function coordPidfileWrite(pids){ try { fs.writeFileSync(PIDFILE(), JSON.stringify({ pids })); } catch(e){} }
function coordPidfileAdd(pid){ if(!pid) return; const p = coordPidfileRead(); if(!p.includes(pid)) p.push(pid); coordPidfileWrite(p); }
function coordPidfileRemove(pid){ if(!pid) return; coordPidfileWrite(coordPidfileRead().filter(x => x !== pid)); }

module.exports = function wireCoordinator(ctx) {
const { SERVICE_NAME, MAX_WORKERS_HARD_CEILING, loadRowsForJob, getLogsDir, getFlowsDir, encStore, readAllProfiles, readConfig, getBundledChromiumPath, licenseReaderLogout, loginToPestPacInPage, logoutFromInPage, resolveOnceFlowByName, buildPoolWorker, buildLogoutSweeper, buildOnceFlowRunner } = ctx;

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
  jobs: new Map(),      // jobId -> { jobId, label, flowSteps, spreadsheetPath, profileId, setupFlowId, teardownFlowId, errHandle, totalRows, nextRow, rows, done, ok, err, skip, finished }
  workers: new Map(),   // workerId -> { workerId, jobId, process, status, batch, done, ok, err, skip, startedAt, runnerLogStream, runnerPath, credPath }
  desiredWorkers: 0,    // target worker count (license/hardware bounded)
  licenseTimer: null,
  poolId: null,         // v2.0.0 resume: id for this pool run's journal file
  journalStream: null,  // append-only results journal (one line per completed row)
  usedProfileIds: new Set(), // v2.1.1: profiles used this run — the logout sweep logs in with one
  sweepRunning: false,
  possibleLeaks: [],   // Phase 3: workerIds that exited without VERIFIED logout (license may be held)
  stopping: false,     // Phase 3 (D2): pool-stop in progress — gates stall-guard respawn + prompt sweep
  _stopSweepFired: false,
  // 3.0.4 (2b) crash-loop breaker state: consecutive workers that died in <15s with
  // zero rows done. 3 in a row = a crash loop, not bad luck — stop the pool, surface
  // the error. Reset on every pool-start and on any healthy exit/row completion.
  _instantExits: 0,
  _lastFatal: null,    // { ts, workerId, error } from the last worker 'fatal' message
  // R4 adaptive scaling state
  autoScale: true,       // pressure auto only ever reduces below the manual slider
  // v3.0.3: manualTarget DELETED. It was the target AND the ceiling, which made auto
  // incapable of ever adding a worker. Start seeds, Max clamps, heuristics decide.
  startWorkers: 1,       // seed only — NOT a floor; heuristics may go below it
  maxWorkers: 150,       // the user's LIVE lid; lower it mid-run and workers drain
  hwSlider: 4,           // 1-5, 4 = 100% of the comfortable hardware cap
  ppSlider: 4,           // 1-5, 4 = 100% of the measured PestPac optimum
  throughput: null,      // rows/min, the ONLY signal the scaler reads
  _rowTimes: [],         // completion timestamps (bounded)
  _tp: null,             // W -> { t: rows/sec, n: samples }
  _tpBest: null,         // { w, t } best measured — this is what lands in the flow
  scaleMultiplier: 3,    // cores × this = comfortable hardware cap (advisory; amber past it)
  licenseCap: Infinity,  // set by coordLicenseScale each eval when elastic is on
  licenseChecker: null,  // 3.x: { active, status } while the elastic license-reader session is logged in — COUNTED + shown as a card so it is never an invisible seat
  _lastFreeLicenses: null, // 3.x: last measured PestPac free-license count (for the readout)
  _lastUsedLicenses: null,  // 3.x: last measured PestPac IN-USE license count
  _lastTotalLicenses: null, // 3.x: last measured PestPac TOTAL license count
  // v3.0.3: _durBaseline/_durRolling/_pressureHigh DELETED. Scaling measures rows/min
  // (COORD._rowTimes / COORD._tp), never row latency. See TODO.md 3.0.3 for the data.
  pressure: null,
  capReason: 'manual',  // v2.1.1: guards against double-spawning the logout sweeper
  setupScope: 'per-job', // 3.x: DEFAULT changed per-worker -> per-job so setup/teardown run ONCE per job (one batch opened/released), not once per worker. 'per-worker' | 'per-job' | 'global'
  startMode: 'run-all',     // v2.2.2 Session 2C: 'run-all' | 'step' | 'step-row'. Forces
                            // workers=1 batch=1 when 'step'/'step-row'. Transitions via
                            // pool-run-control(cmd:'run-all') unlock the configured worker count.
  startModeTarget: { workers: 1 }, // configured target; restored on Run-All transition.
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
      // R1: one reader, one precedence rule (journal.js). Requeued rows are in-flight,
      // not completions — surfaced so the resume prompt can name them.
      const st = require('../journal').readJournalRowStates(poolId);
      const completedByJob = st.completedByJob;
      const jp = coordJournalPath(poolId);
      let totalRemaining = 0;
      const jobs = meta.jobs.map(j => {
        const completed = (completedByJob[j.jobId] || new Set()).size;
        const remaining = Math.max(0, j.totalRows - completed);
        totalRemaining += remaining;
        return { jobId: j.jobId, label: j.label, total: j.totalRows, completed, remaining };
      });
      // Only surface pools that actually have remaining work.
      if(totalRemaining > 0) out.push({ poolId, startedAt: meta.startedAt, jobs, totalRemaining, inFlightRows: st.inFlight.map(x => x.r).sort((a,b)=>a-b).slice(0, 50) });
      else { // 3.x: fully done but never marked. KEEP the journal + meta (they are the audit
        // trail — Matthew: never auto-delete journals). Just write the .done marker so this run
        // is not offered for resume or re-scanned. This replaces the old fs.unlinkSync that was
        // silently erasing completed-run journals on the next startup.
        try{ fs.writeFileSync(coordJournalDonePath(poolId), new Date().toISOString()); }catch(e){}
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
    while(batch.length < 1 && job.requeue.length){
      const r = job.requeue.shift();
      if(job.completedRows && job.completedRows.has(r)) continue;
      batch.push(r);
    }
  }
  while(batch.length < 1 && job.nextRow <= job.totalRows){
    const r = job.nextRow;
    job.nextRow++;
    if(job.completedRows && job.completedRows.has(r)) continue; // already done in a prior run
    // Phase 2 teardown: retry-failed filtering moved coordinator-side (worker cfg no longer
    // carries the set; unselected rows are simply never handed out or journaled).
    if(job.retryRowIndexes && job.retryRowIndexes.length){
      if(!job._retrySet) job._retrySet = new Set(job.retryRowIndexes);
      if(!job._retrySet.has(r)) continue;
    }
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
// Phase 3 (D3): THROTTLE. coordEmitStatus used to fire on EVERY worker message — at
// 100+ workers that is hundreds of full status broadcasts per second, each triggering
// a full worker-grid innerHTML rebuild in the renderer. The render storm saturated the
// renderer main thread and starved every input in the app ("can no longer type").
// Coalesce to at most one broadcast per 250ms; a trailing emit catches the final state.
// v3.0.2: the ONLY safe way to talk to the renderer. `if (ctx.mainWindow)` was never a
// real guard — a destroyed BrowserWindow stays truthy, so every send site threw
// "Object has been destroyed" once the window went away while workers were still
// exiting. isDestroyed() is the real check; the try/catch covers the teardown race
// where the window dies between the check and the send.
function _send(channel, payload) {
  const w = ctx.mainWindow;
  if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed())) return false;
  try {
    const wc = w.webContents;
    if (!wc || wc.isDestroyed()) return false;
    wc.send(channel, payload);
    return true;
  } catch (e) { return false; }
}

let _emitTimer = null;
let _emitPending = false;
function coordEmitStatus() {
  if (_emitTimer) { _emitPending = true; return; }
  _coordEmitStatusNow();
  _emitTimer = setTimeout(() => {
    _emitTimer = null;
    if (_emitPending) { _emitPending = false; coordEmitStatus(); }
  }, 250);
}
function _coordEmitStatusNow(){
  if(!ctx.mainWindow) return;
  const jobs = Array.from(COORD.jobs.values()).map(j => ({
    jobId: j.jobId, label: j.label, totalRows: j.totalRows,
    done: j.done, ok: j.ok, err: j.err,
    // v2.2.3 Session 3B (A5): distinctDone is the number of UNIQUE rows that have completed
    // (counted via the journal-backed completedRows set). j.done counts every row-result
    // emit including reclaim re-processes, so distinctDone is the trustworthy headline.
    distinctDone: (j.completedRows ? j.completedRows.size : j.done),
    remaining: Math.max(0, j.totalRows - (j.nextRow - 1)), finished: j.finished,
    // v2.2.3 Session 3F (B2): expose the source spreadsheet path so the renderer can offer
    // an Archive button (move to upcoming/Finished/) on completed jobs.
    spreadsheetPath: j.spreadsheetPath || null,
  }));
  const workers = Array.from(COORD.workers.values()).map(w => ({
    workerId: w.workerId, jobId: w.jobId, status: w.status,
    done: w.done, ok: w.ok, err: w.err,
    // v2.1.0 live detail: current row, position in batch, step in flow, logout result
    currentRow: w.currentRow,
    step: w.step, totalSteps: w.totalSteps, loggedOut: w.loggedOut, logoutAttempts: w.logoutAttempts||0,
  }));
  // 3.x: the elastic license-checker is a REAL logged-in PestPac session (a consumed seat).
  // Surface it as its own card and count it toward live sessions, so it is never an
  // invisible/uncounted login. status carries an 'lc-' prefix the renderer labels distinctly.
  const _checkerLive = (COORD.licenseChecker && COORD.licenseChecker.active) ? 1 : 0;
  if (_checkerLive) {
    workers.push({ workerId:'license-checker', kind:'license-checker', jobId:null,
      status:'lc-'+(COORD.licenseChecker.status||'checking'), done:0, ok:0, err:0,
      currentRow:null, step:null, totalSteps:null, loggedOut:true, logoutAttempts:0 });
  }
  _send('pool-status', {
    active: COORD.active,
    desiredWorkers: COORD.desiredWorkers, pressure: COORD.pressure, capReason: COORD.capReason, manualTarget: COORD.manualTarget,
    licenseCap: Number.isFinite(COORD.licenseCap) ? COORD.licenseCap : null,
    liveWorkers: COORD.workers.size,
    liveSessions: COORD.workers.size + _checkerLive,   // 3.x: total real PestPac sessions BUU holds (workers + checker)
    freeLicenses: COORD._lastFreeLicenses,
    usedLicenses: COORD._lastUsedLicenses,   // 3.x: PestPac licenses currently IN USE
    totalLicenses: COORD._lastTotalLicenses, // 3.x: PestPac total licenses
    licenseChecker: _checkerLive ? { status: COORD.licenseChecker.status } : null,
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
    // retryCount defaults to 2 (prior hardcode);
    // reauthIntervalMin 0 = no proactive re-auth.
    retryCount: Number.isFinite(job.retryCount) ? job.retryCount : 2,
    reauthIntervalMin: Number.isFinite(job.reauthIntervalMin) ? job.reauthIntervalMin : 0,
    // v2.2.2 Session 2C: passing the pool-level startMode so the worker knows whether to
    // pause before each step (step), pause after each row (step-row), or just run (run-all).
    startMode: COORD.startMode || 'run-all',
    // v2.2.3 Session 3C (A1): diagnostic capture config (forwards to worker template).
    diagnosticCapture: !!COORD.diagnosticCapture,
    captureDir: captureDir,
    captureBucketCap: COORD.captureBucketCap || 10,
    runContext: { runId: workerId, poolId: COORD.poolId, jobId, userDataDir: app.getPath('userData'), runStartTs: parseInt(String(COORD.poolId||'').replace(/^pool/,''), 10) || Date.now() /* R6: {{RUNDATE}} base - pool start */, profileUsername: prof.username || '' },
  });
  fs.writeFileSync(runnerPath, script);

  const env = { ...process.env };
  const nodeModulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : path.join(__dirname, '..', 'node_modules');
  env.NODE_PATH = nodeModulesPath; env.BUU_NODE_MODULES = nodeModulesPath; env.ELECTRON_RUN_AS_NODE = '1';

  const entry = { workerId, jobId, process: null, status: 'starting', batch: [], done:0, ok:0, err:0, startedAt: Date.now(), lastActivity: Date.now(), runnerLogStream, runnerPath, credPath, logPath };
  COORD.workers.set(workerId, entry);

  const proc = spawn(process.execPath, [runnerPath, job.spreadsheetPath || '__none__', credPath], { stdio:['pipe','pipe','pipe'], env });
  coordPidfileAdd(proc.pid);
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
    coordPidfileRemove(proc.pid);
    runnerLogStream.write(`[${new Date().toISOString()}] worker exited code=${code}\n`);
    runnerLogStream.end();
    const w = COORD.workers.get(workerId);
    if(w){ w.status = (code===0?'done':'error'); }
    // 3.0.4 (2b): instant-exit accounting for the crash-loop breaker. A worker that
    // died in under 15s having completed ZERO rows is a crash, not a retirement —
    // three in a row means the next respawn will die the same way.
    if(w){
      const lifeMs = Date.now() - (w.startedAt || Date.now());
      if((w.done||0) === 0 && lifeMs < 15000) COORD._instantExits = (COORD._instantExits||0) + 1;
      else COORD._instantExits = 0;
    }
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
        // only count rows that weren't already requeued (e.g. by a worker-side 'reclaim'
        // message that did arrive). The set-of-already-requeued check avoids double-counting
        // when the worker emitted reclaim AND then the process closed.
        const alreadyRequeued = new Set(cjob.requeue);
        for(const r of w.batch){
          if(cjob.completedRows && cjob.completedRows.has(r)) continue;
          if(alreadyRequeued.has(r)) continue;
          cjob.requeue.push(r);
          // R1: every row is guaranteed a terminal journal line — a crash can no longer
          // leave silence. When the row re-runs, its later line wins (requeued is not a
          // completion for the reader).
          coordJournalAppend(w.jobId, r, 'error', { reason: 'requeued', error: 'worker died mid-row; row returned to the queue', workerId: w.workerId });
        }
        if(cjob.requeue.length) cjob.finished = false;
      }
    }
    COORD.workers.delete(workerId);
    try { fs.unlinkSync(runnerPath); } catch {}
    try { fs.unlinkSync(credPath); } catch {}
    coordEmitStatus();
    // Phase 3 (D2): when the pool is stopping, fire the logout sweep PROMPTLY once the
    // last worker is gone instead of on the old fixed 184s clock. sweepRunning +
    // _stopSweepFired guard doubles with the fuse-path backstop in pool-stop.
    if(COORD.stopping && COORD.workers.size === 0 && !COORD._stopSweepFired){
      COORD._stopSweepFired = true;
      setTimeout(() => coordRunLogoutSweep('pool-stop'), 1500);
    }
    // v2.2.1 LOSSLESS RECLAIM (stall guard): lazy reclaim relies on a live worker eventually
    // pulling the requeued rows. If THIS was the last worker and the pool is still active with
    // work outstanding (forward queue OR reclaimed requeue), nothing would pull it — the elastic
    // timer is minutes away and a non-elastic pool has no timer at all — so the pool would hang
    // with rows unprocessed. Spawn exactly one worker to drain the remainder. coordPickJobForWorker
    // is requeue-aware, so this also covers requeue-only-remaining. Not aggressive: only fires at
    // zero live workers, and only while there is genuinely work left.
    // 3.0.4 (2b): CRASH-LOOP BREAKER — runs BEFORE the stall-guard so a third instant
    // death stops the pool instead of feeding it another worker. This is the fix for
    // 07-16: workers fataled on ENOENT in <1s each and the stall-guard respawned them
    // forever with zero rows done and nothing surfaced. Stop mirrors pool-stop
    // semantics (jobs drained, sweep fired); the error reaches the error strip.
    if(COORD.active && !COORD.stopping && (COORD._instantExits||0) >= 3){
      const why = (COORD._lastFatal && COORD._lastFatal.error) || 'worker died instantly, repeatedly (no fatal detail)';
      try { console.error('[coord] crash-loop breaker tripped: ' + why); } catch(_){}
      COORD.stopping = true;
      COORD.capReason = 'fatal';
      for (const job of COORD.jobs.values()) { job.nextRow = job.totalRows + 1; job.finished = true; }
      try { _send('pool-row-error', { workerId: workerId, jobId: null, row: '-', reason: 'fatal', error: 'POOL STOPPED: 3 workers in a row died instantly with zero rows done. Last fatal: ' + why }); } catch (e) {}
      if(!COORD._stopSweepFired){ COORD._stopSweepFired = true; setTimeout(() => coordRunLogoutSweep('fatal-loop'), 1500); }
    }
    // 3.x: do NOT respawn when the license cap is intentionally holding the pool at 0 (free
    // seats hit the buffer / saturation). The always-on eval timer re-checks licenses and
    // brings workers back the moment seats free up. Without this gate the stall-guard would
    // fight the license hard-stop and re-consume the buffer.
    const _licenseHold = Number.isFinite(COORD.licenseCap) && COORD.licenseCap < 1;
    if(COORD.active && !COORD.stopping && !_licenseHold && COORD.workers.size === 0 && coordPickJobForWorker()){
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
  w.lastActivity = Date.now(); // 3.x watchdog: any message = proof of life; silence => frozen
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
      if (ctx.mainWindow) _send('pool-pause', {
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
      if (ctx.mainWindow) _send('pool-pause', {
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
      if (ctx.mainWindow) _send('pool-dialog', {
        workerId: workerId,
        jobId: w.jobId,
        row: msg.row,
        message: msg.message,
        dialogType: msg.dialogType,
        ts: msg.ts,
      });
      break;
    case 'logging-out':
      w.status = 'logging-out';
      break;
    case 'logout-attempt':
      w.logoutAttempts = msg.attempt;
      break;
    case 'logged-out':
      w.loggedOut = !!msg.ok;
      w.logoutAttempts = msg.attempts || w.logoutAttempts || 0;
      if(!msg.ok && !COORD.possibleLeaks.includes(w.workerId)) COORD.possibleLeaks.push(w.workerId);
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
      // R1: pass the rich reason/error/duration through to the journal. Worker-side
      // classifier supplies errorCategory; user-stop rows map to reason 'manual'.
      coordJournalAppend(w.jobId, msg.row, msg.status, {
        reason: msg.errorCategory || (/Stopped by user/.test(msg.error||'') ? 'manual' : undefined),
        error: msg.error, durationMs: msg.durationMs,
        workerId: w.workerId, // v3.0.3: attribute every row to the worker that ran it
      });
      // R11: direct error feed to the renderer (errors only — the D3 lesson says no
      // per-row event floods; OK rows are visible through the counters).
      if(String(msg.status||'').indexOf('ok') !== 0 && ctx.mainWindow){
        try { _send('pool-row-error', { workerId: w.workerId, jobId: w.jobId, row: msg.row, error: msg.error || '', reason: msg.errorCategory || undefined, step: msg.phase || undefined }); } catch (e) {}
      }
      // v3.0.3: throughput signal. One timestamp per completed row — this is the ONLY
      // thing the scaler measures. Trimmed to the last 10 minutes so memory is bounded
      // on 25k-row runs.
      if(String(msg.status||'').indexOf('ok') === 0){
        if(!COORD._rowTimes) COORD._rowTimes = [];
        COORD._rowTimes.push(Date.now());
        if(COORD._rowTimes.length > 5000) COORD._rowTimes = COORD._rowTimes.slice(-3000);
      }
      if(job && job.completedRows) job.completedRows.add(msg.row);
      w.done++; if(msg.status==='ok'||msg.status==='ok (retry)') w.ok++; else w.err++;
      if(job){ job.done++; if(msg.status==='ok'||msg.status==='ok (retry)') job.ok++; else job.err++; }
      // R4: collect OK-row durations for PestPac-pressure sensing.
      if(String(msg.status||'').indexOf('ok')===0 && Number.isFinite(msg.durationMs)){
        // v3.0.3: duration baseline deleted - the scaler measures rows/min, never latency.
      }
      // v2.2.0: collect read-field values into a per-job buffer for the dedicated results workbook.
      if(job && msg.reads && typeof msg.reads === 'object'){
        if(!job.readResults) job.readResults = [];
        if(!job.readColumns) job.readColumns = [];
        for(const cn of Object.keys(msg.reads)){ if(!job.readColumns.includes(cn)) job.readColumns.push(cn); }
        job.readResults.push({ row: msg.row, reads: msg.reads });
      }
      // Scrape -> stream to the run CSV as results arrive (crash-safe append).
      // 3.1.2: ALWAYS WRITE. The old scrapeCsvEnabled "dry run" gate was a footgun on a
      // step whose only purpose IS the output (Matthew, 2026-07-23: it silently turned a
      // 2241-location Fieldwork scrape into no file). The write is unconditional now;
      // scrapeKind only routes to the right column writer. Fieldwork always emits at least
      // the per-location log record so 0-cancellation locations are still recorded.
      if(job && Array.isArray(msg.scrape)){
        if(msg.scrapeKind === 'fieldwork-cancellations'){
          coordAppendFieldwork(job, msg.scrape);
        } else if(msg.scrape.length){
          coordAppendScrape(job, msg.scrape);
        } else console.warn('[coord] Frankware scrape: row '+msg.row+' returned 0 orders');
      }
      break;
    }
    case 'fatal':
      // 3.0.4 (2b): a worker died before/outside row processing (spreadsheet ENOENT,
      // login failure, ...). This message was SILENTLY IGNORED for versions — the
      // worker exited, the stall-guard respawned the next, and the crash-loop ran
      // forever with nothing shown to the user (07-16). Record + surface it; the
      // close-handler breaker stops the pool after 3 consecutive instant deaths.
      w.status = 'error';
      w.lastError = msg.error || 'worker fatal (no detail)';
      COORD._lastFatal = { ts: Date.now(), workerId, error: w.lastError };
      try { _send('pool-row-error', { workerId, jobId: w.jobId, row: '-', error: 'WORKER FATAL: ' + w.lastError, reason: 'fatal' }); } catch (e) {}
      break;
    case 'retired':
      // v2.1.0: worker finished its shutdown sequence (teardown+logout). Mark shut-down;
      // the process 'close' handler removes it from the map (-> 'gone' in the UI).
      w.status = 'shut-down';
      if(msg.loggedOut!=null) w.loggedOut = !!msg.loggedOut;
      break;
  }
  coordEmitStatus();
}

// v3.0.3: lastGoodWorkers — the best MEASURED worker count auto-saves into the flow's
// OWN .json at run end (Matthew: "that flow knows whats best for it"). HARD RULES
// (TODO.md 3.0.3): read-modify-write of the on-disk file setting ONLY this one key —
// never rebuild poolSettings; never touch renderer state or mark the flow dirty; flow
// not on disk => skip silently. The renderer seeds the Start box from it on load, and
// main's save-flow handler carries it across a normal Save (renderer never holds it).
// Only written when the pool ran exactly ONE distinct flow — a multi-flow pool's
// optimum is a blend and would be wrong for each flow individually.
function coordSaveLastGoodW(){
  try{
    const best = COORD._tpBest;
    if(!best || !Number.isFinite(best.w) || best.w < 1) return; // no clean measurement (auto off / run too short)
    const names = new Set();
    for(const j of COORD.jobs.values()){ if(j.flowName) names.add(j.flowName); }
    if(names.size !== 1) return;
    if(typeof getFlowsDir !== 'function') return;
    const safe = String(Array.from(names)[0]).replace(/[\\/:*?"<>|]/g, '_');
    if(!safe) return;
    // Same search order as read-flow-by-name: flat root first (dev saves flat), then subdirs.
    for(const sub of ['', 'general', 'automation', 'once']){
      const fp = path.join(getFlowsDir(), sub, safe + '.json');
      if(!fs.existsSync(fp)) continue;
      const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if(obj.lastGoodWorkers === best.w) return; // unchanged — don't churn the file
      obj.lastGoodWorkers = best.w;
      fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
      console.log('[coord] lastGoodWorkers=' + best.w + ' -> ' + fp);
      return;
    }
  }catch(e){ console.warn('[coord] lastGoodWorkers save skipped:', e.message); }
}

// 3.0.4 (2a+2c): launch-time hygiene — called by pool-start BEFORE anything else.
// (2a) Purge jobs that FINISHED in a prior run: they used to survive staging, get
//      their counters reset by pool-start, and silently RE-RUN (07-16: a finished
//      job re-ran against a sheet that had been archived and crash-looped; 07-17:
//      each scheduled fire re-ran every prior copy). Completed = gone at launch.
// (2b reset) Clear the crash-loop breaker counters for the new run.
// (2c) Re-validate every remaining job's spreadsheet still exists on disk (Archive
//      moves files between runs): fail the LAUNCH loudly with the filename instead
//      of letting every worker die on ENOENT.
function coordPrepareLaunch(){
  for (const [id, j] of Array.from(COORD.jobs)) { if (j.finished) COORD.jobs.delete(id); }
  COORD._instantExits = 0; COORD._lastFatal = null;
  if (COORD.jobs.size === 0) return { ok: false, error: 'No jobs staged. (Jobs completed by the previous run are cleared automatically at launch — stage the flow again.)' };
  for (const j of COORD.jobs.values()) {
    if (j.spreadsheetPath && !fs.existsSync(j.spreadsheetPath)) {
      return { ok: false, error: 'Spreadsheet for job "' + j.label + '" no longer exists:\n' + j.spreadsheetPath + '\n(Archived or moved since it was staged?) Remove the job or restore the file.' };
    }
  }
  return { ok: true };
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
    coordSaveLastGoodW(); // v3.0.3: background one-key write into the flow's own .json
    if(ctx.mainWindow) _send('pool-complete', {
      possibleLeaks: COORD.possibleLeaks.slice(),
      jobs: Array.from(COORD.jobs.values()).map(j => ({ jobId:j.jobId, label:j.label, totalRows:j.totalRows, ok:j.ok, err:j.err })),
    });
    // v2.1.1 (#8): for per-job/global scope, run teardown ONCE now (coordinator-driven), THEN
    // sweep. v2.1.1 logout sweep is the authoritative backstop and runs regardless of scope.
    (async () => {
      // v2.2.0: write any read-field results to dedicated per-job workbooks first.
      try { coordWriteReadResults(); } catch(e){ console.error('[coord] read-results write failed:', e.message); }
      if(COORD.setupScope !== 'per-worker'){
        if(ctx.mainWindow) _send('pool-once-flow', { phase:'teardown', state:'phase-start', scope:COORD.setupScope });
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
      if(ctx.mainWindow) _send('pool-read-results', { path: outPath, rows: sorted.length, columns: cols });
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

// 3.1.0: Fieldwork cancellation scrape -> stream to two CSVs in the run's results\ folder.
// Records tagged __k==='fieldwork-log' go to the per-location LOG csv (one line per visited
// location, incl. zero-found); all other records are cancellations -> the CANCELLATIONS csv,
// deduped on data_id. Both crash-safe (append as results arrive). Input sheet never touched.
function coordAppendFieldwork(job, rows){
  if(!job || !Array.isArray(rows) || !rows.length) return;
  try{
    if(!job.fwScrapePaths){
      const RESULTS_DIR = path.join(path.dirname(job.spreadsheetPath || process.cwd()), 'results');
      try{ fs.mkdirSync(RESULTS_DIR, { recursive:true }); }catch(e){}
      const now = new Date();
      const mm = String(now.getMonth()+1).padStart(2,'0'), dd = String(now.getDate()).padStart(2,'0'), yyyy = now.getFullYear();
      const hh = String(now.getHours()).padStart(2,'0'), mi = String(now.getMinutes()).padStart(2,'0');
      const safeFlow = String(job.label || 'flow').replace(/[\\/:*?"<>|]/g,'_').replace(/\.xlsx?$/i,'').slice(0,60);
      const base = `${mm}${dd}${yyyy}_${hh}${mi}_${safeFlow}`;
      job.fwScrapePaths = { data: path.join(RESULTS_DIR, base+'_fieldwork-cancellations.csv'),
                            log:  path.join(RESULTS_DIR, base+'_fieldwork-scrapelog.csv') };
      job.fwSeen = new Set(); job.fwCount = 0; job.fwDupes = 0; job.fwLogCount = 0;
    }
    const esc = v => { const s = (v==null ? '' : String(v)); return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
    const DATA_COLS = ['account_number','location_number','service_type','frequency','status','reason','technician','cancel_date','cancelled_at','amount','data_id','data_reason','data_cancel_date','source_url'];
    const LOG_COLS  = ['account_number','location_number','groups_found','cancellations_found','status','source_url'];
    let dataOut = '', logOut = '';
    if(!fs.existsSync(job.fwScrapePaths.data)) dataOut += DATA_COLS.join(',') + '\r\n';
    if(!fs.existsSync(job.fwScrapePaths.log))  logOut  += LOG_COLS.join(',') + '\r\n';
    for(const o of rows){
      if(o.__k === 'fieldwork-log'){
        logOut += LOG_COLS.map(c => esc(o[c])).join(',') + '\r\n';
        job.fwLogCount++;
        continue;
      }
      const key = o.data_id || '';
      if(key && job.fwSeen.has(key)){ job.fwDupes++; console.warn('[coord] Fieldwork scrape: duplicate skipped data_id='+key); continue; }
      if(key) job.fwSeen.add(key);
      dataOut += DATA_COLS.map(c => esc(o[c])).join(',') + '\r\n';
      job.fwCount++;
    }
    if(dataOut) fs.appendFileSync(job.fwScrapePaths.data, dataOut, 'utf8');
    if(logOut)  fs.appendFileSync(job.fwScrapePaths.log,  logOut,  'utf8');
  }catch(e){ console.error('[coord] Fieldwork scrape CSV append failed for job', job && job.label, e.message); }
}

// v1.3.4 Phase 3: license-aware cap. Launches a headless browser with the given profile,
async function coordRunLogoutSweep(reason){
  if(COORD.sweepRunning) return;
  COORD.sweepRunning = true;
  try{
    const chromiumExe = getBundledChromiumPath();
    if(!chromiumExe){ if(ctx.mainWindow) _send('pool-sweep-result',{ok:false,error:'chromium not found'}); COORD.sweepRunning=false; return; }
    // Pick a profile used this run (fall back to any job's profile).
    let profileId = Array.from(COORD.usedProfileIds)[0];
    if(!profileId){ const firstJob = Array.from(COORD.jobs.values())[0]; profileId = firstJob && firstJob.profileId; }
    if(!profileId){ if(ctx.mainWindow) _send('pool-sweep-result',{ok:false,error:'no profile available for sweep'}); COORD.sweepRunning=false; return; }

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
    if(ctx.mainWindow) _send('pool-sweep-start', { reason });

    const proc = spawn(process.execPath, [runnerPath, credPath], { stdio:['ignore','pipe','pipe'], env });
    let lastResult = null;
    proc.stdout.on('data', d => {
      String(d).split('\n').filter(Boolean).forEach(line => {
        sweepLog.write(`[OUT] ${line}\n`);
        let msg; try{ msg = JSON.parse(line); }catch{ return; }
        if(msg.type === 'sweep-pass' || msg.type === 'sweep-done') lastResult = msg;
        if(ctx.mainWindow) _send('pool-sweep-progress', msg);
      });
    });
    proc.stderr.on('data', d => sweepLog.write(`[ERR] ${String(d)}\n`));
    proc.on('close', code => {
      sweepLog.write(`[${new Date().toISOString()}] sweep exited code=${code}\n`); sweepLog.end();
      try { fs.unlinkSync(runnerPath); } catch {}
      try { fs.unlinkSync(credPath); } catch {}
      COORD.sweepRunning = false;
      const remaining = lastResult && lastResult.remaining != null ? lastResult.remaining : (code===0?0:null);
      if(ctx.mainWindow) _send('pool-sweep-result', { ok: code===0, remaining, loggedOut: lastResult && lastResult.loggedOut });
    });
  }catch(e){
    COORD.sweepRunning = false;
    if(ctx.mainWindow) _send('pool-sweep-result',{ ok:false, error:e.message });
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
    // R4: strictly sequential ramp — each worker must log in and pull its first row
    // (status 'running') before the next spawns. 90s per-worker ramp budget; a worker
    // that dies or finishes during ramp releases the loop immediately.
    for (let i = 0; i < canSpawn; i++) {

      // v3.0.3: re-assert against the LIVE count every iteration. `live` above is a

      // snapshot and this loop awaits for up to 90s per worker — by now it can be stale,

      // and anything that re-entered must not be able to push us past the target.

      if (COORD.workers.size >= target) break;

      const _id = await coordSpawnWorker();
      if (!_id) break;
      const _t0 = Date.now();
      while (Date.now() - _t0 < 90000) {
        const _w = COORD.workers.get(_id);
        if (!_w) break;
        if (_w.status === 'running' || _w.status === 'shut-down' || _w.status === 'error' || _w.status === 'done') break;
        await new Promise(rs => setTimeout(rs, 500));
      }
    }
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
function _median(a){ if(!a || !a.length) return null; const s2=[...a].sort((x,y)=>x-y); const m=Math.floor(s2.length/2); return s2.length%2 ? s2[m] : (s2[m-1]+s2[m])/2; }

// R4: the ONE evaluation path — composes license cap (elastic), PestPac pressure, and
// the manual slider. Manual wins over auto: auto only ever reduces below the slider.
// Pressure = median(last 30 OK rows)/median(first 50): >1.4 sustained 2 checks → drop
// ~20% of live workers; 1.15–1.4 → hold; <1.15 → creep back +1 per tick (drop fast,
// recover slow). Changes apply at row boundaries (scale-down drains; ramp is sequential).
// v3.0.3: RE-ENTRANCY GUARD. This function awaits (license scrape, and a ramp that can
// run 90s per worker) while five callers can fire it — the eval timer and every slider
// move. Concurrent passes each read a stale worker count and spawn independently, which
// is how a manual cap of 4 produced 29 live workers. Coalesce rather than drop: a request
// arriving mid-pass sets _evalPending so the LAST intent still gets applied once.
let _evalInFlight = false;
let _evalPending = false;
// v3.0.3: THE CLIMB. Returns the worker count to aim for, based purely on measured
// rows/min. Never reads row latency — see the header note for why latency lies.
// Cadence is the caller's (the eval timer), so the "Eval every (min)" box is the single
// visible knob for how twitchy this is (Matthew: "set the time to whatever the auto
// time check is").
const TP_WINDOW_MS = 60000;   // sample window; 30 rows at 13 workers is only ~19s (too twitchy)
const TP_NOISE = 0.10;        // MEASURED: throughput at a fixed 13 workers wobbled 1.32-1.63 rows/sec
function coordThroughputNow(){
  const now = Date.now();
  const times = COORD._rowTimes || [];
  let n = 0;
  for (let i = times.length - 1; i >= 0; i--) { if (now - times[i] > TP_WINDOW_MS) break; n++; }
  return n / (TP_WINDOW_MS / 1000); // rows per second
}
function coordThroughputTarget(){
  const W = COORD.workers.size || 1;
  const now = Date.now();
  if (COORD._tpW !== W) { COORD._tpW = W; COORD._tpStableSince = now; } // W changed: restart the clock
  // A sample taken while the worker count was changing is a blend of two configurations
  // and means nothing. Wait for a clean window before believing anything.
  if (now - (COORD._tpStableSince || now) < TP_WINDOW_MS) { COORD.capReason = COORD.capReason || 'settling'; return W; }
  const T = coordThroughputNow();
  if (!COORD._tp) COORD._tp = {};
  const prevRec = COORD._tp[W];
  COORD._tp[W] = prevRec ? { t: (prevRec.t * prevRec.n + T) / (prevRec.n + 1), n: prevRec.n + 1 } : { t: T, n: 1 };
  // remember the best measured count — this is what gets written to the flow
  if (!COORD._tpBest || COORD._tp[W].t > COORD._tpBest.t) COORD._tpBest = { w: W, t: COORD._tp[W].t };
  const lastW = COORD._climbLastW;
  let dir = (COORD._climbDir === undefined) ? 1 : COORD._climbDir;
  if (lastW != null && lastW !== W && COORD._tp[lastW]) {
    const before = COORD._tp[lastW].t, after = COORD._tp[W].t;
    if (after > before * (1 + TP_NOISE))      { /* real gain: keep going */ }
    else if (after < before * (1 - TP_NOISE)) { dir = -dir; }   // real loss: turn around
    else                                      { dir = 0; }      // inside the noise: settle
  }
  COORD._climbLastW = W;
  COORD._climbDir = dir;
  COORD.throughput = Math.round(T * 600) / 10; // rows/min, for the readout
  return Math.max(1, W + dir);
}

async function coordEvalScale(){
  if(!COORD.active || COORD.stopping) return;
  if(_evalInFlight){ _evalPending = true; return; }
  _evalInFlight = true;
  try {
  if(COORD.elasticParams){
    try{ await coordLicenseScale(COORD.elasticParams.licenseProfileId, COORD.elasticParams.licenseBuffer, COORD.elasticParams.hwCap); }catch(e){}
  } else COORD.licenseCap = Infinity;
  // v3.0.3: HEURISTICS DECIDE, MAX CLAMPS. The old line was
  //   target = min(manualTarget, CEILING)  ... then only ever reduced
  // which made auto incapable of EVER adding a worker — all the scaling code could only
  // subtract from a number the user already set. That is why auto "never worked".
  let reason = 'held';
  let target;
  if (COORD.autoScale) { target = coordThroughputTarget(); reason = 'throughput'; }
  else {
    // Auto-scale off = HOLD THE USER'S NUMBER, which is Start - not `workers.size`.
    // `workers.size` would mean 'hold whatever we happen to have right now', so a
    // temporary license squeeze to 2 would become permanent even after seats freed up.
    target = Math.max(1, parseInt(COORD.startWorkers) || 1);
  }

  // Hardware heuristic: slider 1-5, 4 = 100% of the comfortable cap, 5 = 125% overdrive.
  const _hwSlider = Math.max(1, Math.min(5, parseInt(COORD.hwSlider) || 4));
  const _hwBase = COORD.hwCapAdvisory || MAX_WORKERS_HARD_CEILING;
  const _hwEff = Math.max(1, Math.round(_hwBase * (_hwSlider / 4)));
  if (_hwEff < target) { target = _hwEff; reason = 'hardware'; }

  // License cap: UNCONDITIONAL. Already computed above; never gated on a checkbox.
  if (Number.isFinite(COORD.licenseCap) && COORD.licenseCap < target) { target = COORD.licenseCap; reason = 'license'; }

  // Max: the user's LIVE lid. Lower it below the live count mid-run and workers drain.
  // It is a clamp, never the target — that distinction is the whole point of this rewrite.
  const _max = Math.max(1, Math.min(parseInt(COORD.maxWorkers) || MAX_WORKERS_HARD_CEILING, MAX_WORKERS_HARD_CEILING));
  if (_max < target) { target = _max; reason = 'max'; }

  // 3.x: the license cap is an ABSOLUTE floor protecting the free-seat buffer for people —
  // it MAY drive the target to 0 (a true hard-stop / pause) when free seats hit the buffer or
  // PestPac is saturated. Only the license cap may push below 1; every other path (throughput,
  // hardware, max, manual) always keeps at least one worker. The old Math.max(1,...) here was
  // the bug that let the pool always keep one more login and never honor a hard limit.
  target = (reason === 'license') ? Math.max(0, target) : Math.max(1, target);
  COORD.capReason = reason;
    COORD.desiredWorkers = target;
    await coordScaleTo(target);
    coordEmitStatus();
  } finally {
    _evalInFlight = false;
    // a request that arrived mid-pass runs now, so the last slider move is never lost
    if(_evalPending){ _evalPending = false; setTimeout(() => { coordEvalScale().catch(()=>{}); }, 0); }
  }
}

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
  // 3.x: the checker is a REAL logged-in PestPac session for its whole lifetime — mark it
  // ACTIVE so it is COUNTED and shown as a card (coordEmitStatus). Never an invisible seat.
  COORD.licenseChecker = { active: true, status: 'logging-in', startedAt: Date.now() };
  coordEmitStatus();
  let browser, loginOk = false;
  try {
    const { chromium } = require('playwright-core');
    browser = await chromium.launch({ headless: true, executablePath: chromiumExe, args: ['--disable-gpu','--disable-dev-shm-usage'] });
    const page = await (await browser.newContext()).newPage();
    try {
      // Login via the shared canonical helper (drift-proof; platform-aware). NOTE: this
      // helper is now wired through ctx — before 3.x it was undefined here and this whole
      // function threw, so the license cap never applied.
      await loginToPestPacInPage(page, { loginUrl: prof.loginUrl, companyKey: prof.companyKey, username: prof.username, password: prof.password, platform: prof.platform });
      loginOk = true;
      COORD.licenseChecker.status = 'reading'; coordEmitStatus();
      await page.goto('https://app.pestpac.com/license.asp?Mode=View', { waitUntil: 'load', timeout: 30000 });
      // v2.2.1: read the PestPac FREE value from the #div_PestPac panel with an EXACT label match
      // (avoids the old startsWith bug that could read used/total or a Mobile/RouteOp table).
      // 3.x: read all three PestPac numbers from the #div_PestPac panel — TOTAL, USED (in use),
      // and FREE (available) — so the UI can show "in use / available / total", not just free.
      const lic = await page.evaluate(() => {
        const scope = document.querySelector('#div_PestPac') || document;
        const tds = Array.from(scope.querySelectorAll('td'));
        const read = (labels) => { for (const td of tds){ const l=(td.textContent||'').trim().toLowerCase().replace(/\s+/g,' '); if(labels.indexOf(l)>=0){ const s=td.nextElementSibling; if(s) return (s.textContent||'').trim(); } } return null; };
        return {
          free:  read(['number of free licenses:','number of free licenses']),
          used:  read(['number of used licenses:','number of used licenses']),
          total: read(['number of licenses:','number of licenses']),
        };
      });
      const _num = (t) => { if (t == null) return NaN; const n = parseInt(String(t).replace(/[^0-9]/g,'')); return isNaN(n) ? NaN : n; };
      const free  = _num(lic && lic.free);
      const used  = _num(lic && lic.used);
      const total = _num(lic && lic.total);
      COORD._lastUsedLicenses  = isNaN(used)  ? null : used;
      COORD._lastTotalLicenses = isNaN(total) ? null : total;
      if (!isNaN(free)) {
        COORD._lastFreeLicenses = free;
        // `free` is measured WHILE all our sessions (workers + THIS checker) are logged in, so
        // it already reflects our usage. Additional workers we may safely hold = free - buffer.
        // The cap MAY be <= 0: when free seats are at/under the buffer the pool must hard-stop
        // (coordEvalScale floors a license-bound target at 0). The buffer is an ABSOLUTE reserve
        // for people and is never bypassed.
        const newTarget = COORD.workers.size + (free - BUF);
        COORD.licenseCap = newTarget;
        if (ctx.mainWindow) _send('pool-license-update', { freeLicenses: free, usedLicenses: (isNaN(used)?null:used), totalLicenses: (isNaN(total)?null:total), buffer: BUF, newTarget: Math.max(0, newTarget), liveWorkers: COORD.workers.size });
      }
    } finally {
      // GUARANTEED verified logout — runs even if the read threw. THIS is the leak fix: the
      // old catch-path did browser.close() WITHOUT logging out, leaking a seat every time the
      // read errored after a successful login. licenseReaderLogout delegates to the ONE
      // canonical verified logout (engine/login.js).
      if (loginOk) {
        COORD.licenseChecker.status = 'logging-out'; coordEmitStatus();
        try { await licenseReaderLogout(page); } catch(_){}
      }
    }
  } catch (e) {
    // Launch or LOGIN failed. If LOGIN was refused, treat it as SATURATION (PestPac would not
    // grant a seat) and SHED: force the cap below our live worker count so coordEvalScale drains
    // a worker and hands a seat back toward the buffer. Retries next interval. Only ever reduces,
    // so a transient blip self-corrects; erring toward protecting people's seats is intentional.
    if (!loginOk) {
      COORD.licenseCap = Math.max(0, COORD.workers.size - 1);
      if (ctx.mainWindow) _send('pool-license-update', { error: 'could not get a license seat (saturated) — shedding to protect the buffer', saturated: true, liveWorkers: COORD.workers.size });
    } else if (ctx.mainWindow) {
      _send('pool-license-update', { error: e.message });
    }
  } finally {
    try { if (browser) await browser.close(); } catch(_){}
    COORD.licenseChecker = { active: false };
    coordEmitStatus();
  }
}



// 3.x WORKER WATCHDOG. A hung worker (frozen on a dialog, a wedged page, a lost child) used to
// hang the ENTIRE pool forever, because the coordinator only completes once every worker exits —
// one frozen worker on row 288 kept a 1219-row run "running" for 13.5h overnight. This single
// module-level timer force-kills any worker that has emitted ZERO output for WATCHDOG_MS; killing
// the process fires the normal 'close' handler, which reclaims its unfinished rows (lossless
// reclaim) and lets the pool respawn/complete. It runs every 30s and no-ops whenever no pool is
// active, so it needs no per-run start/stop wiring. Threshold is deliberately generous — far
// longer than any legitimate single step (nav / selector timeouts are ~30s) — so it never kills a
// worker that is merely on a slow row.
const WATCHDOG_MS = 240000; // 4 minutes of total silence = frozen
setInterval(() => {
  try {
    if(!COORD.active || COORD.stopping) return;
    const now = Date.now();
    for(const w of COORD.workers.values()){
      if(['running','starting','logging-in','shutting-down','draining'].indexOf(w.status) < 0) continue;
      const idle = now - (w.lastActivity || w.startedAt || now);
      if(idle >= WATCHDOG_MS){
        try{ console.error('[coord] watchdog: worker '+w.workerId+' silent '+Math.round(idle/1000)+'s (status '+w.status+') — force-killing so the pool can proceed'); }catch(_){}
        try{ _send('pool-row-error', { workerId:w.workerId, jobId:w.jobId, row:(w.currentRow||'-'), reason:'watchdog', error:'Worker frozen ('+Math.round(idle/1000)+'s with no activity, likely a stuck browser dialog) — force-killed by the watchdog; its unfinished rows were returned to the queue.' }); }catch(_){}
        w.status = 'error';
        w._killedByWatchdog = true;
        try{ w.process.kill(); }catch(_){}
      }
    }
  } catch(_){}
}, 30000);

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
          runContext: { runId: onceId, phase, runStartTs: parseInt(String(COORD.poolId||'').replace(/^pool/,''), 10) || Date.now() /* R6: {{RUNDATE}} base - pool start */, profileUsername: prof.username || '' },
        }));
        const env = { ...process.env };
        const nodeModulesPath = app.isPackaged
          ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
          : path.join(__dirname, '..', 'node_modules');
        env.NODE_PATH = nodeModulesPath; env.BUU_NODE_MODULES = nodeModulesPath; env.ELECTRON_RUN_AS_NODE = '1';
        const logPath = path.join(getLogsDir(), `buu2-once-${onceId}.log`);
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        logStream.write(`[${new Date().toISOString()}] ${phase} once-flow start (job=${job.label})\n`);
        if(ctx.mainWindow) _send('pool-once-flow', { phase, job: job.label, state: 'start' });
        const proc = spawn(process.execPath, [runnerPath, credPath], { stdio:['ignore','pipe','pipe'], env });
        proc.stdout.on('data', d => logStream.write(`[OUT] ${String(d)}`));
        proc.stderr.on('data', d => logStream.write(`[ERR] ${String(d)}`));
        proc.on('close', code => {
          logStream.write(`[${new Date().toISOString()}] ${phase} once-flow exit code=${code}\n`); logStream.end();
          try { fs.unlinkSync(runnerPath); } catch {}
          try { fs.unlinkSync(credPath); } catch {}
          if(ctx.mainWindow) _send('pool-once-flow', { phase, job: job.label, state: 'done', ok: code===0 });
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

return { COORD, coordJournalPath, coordJournalMetaPath, coordOpenJournal, coordMarkPhaseProgress, coordJournalAppend, coordJournalAppendDialog, coordCloseJournal, coordJournalDonePath, coordMarkJournalDone, coordFindOrphanPools, coordNextBatch, coordAllDrained, coordEmitStatus, coordPickJobForWorker, coordSpawnWorker, coordHandleWorkerMessage, coordCheckComplete, coordWriteReadResults, coordAppendScrape, coordAppendFieldwork, coordRunLogoutSweep, coordMostRecentJournalPoolId, coordScaleTo, coordLicenseScale, coordRunOnceFlow, coordRunOnceFlows, coordEvalScale, coordSaveLastGoodW, coordPrepareLaunch };
};
