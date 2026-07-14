// pool/worker.js — pool worker child-process shell. NOT run in place: buildPoolWorker
// (src/main.js) reads this file at spawn, splices engine sources at the __BUU_INLINE
// markers, and replaces each /*__BUU_CFG_n__*/null with the run-config expression listed
// (in order) in buildPoolWorker. The null defaults keep this file node --check valid.
// Phase 2 refactor, 2026-07-10 — emitted text proven equivalent to the v2.2.9 template.

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// v2.2.2 Session 2D: net is required for the TCP probe used by network-aware retry.
const net = require('net');
const _nm = process.env.NODE_PATH || path.join(__dirname);

/*__BUU_INLINE REQUIRE_FN_SRC__*/

if(process.env.NODE_PATH){ try{require('module').Module._initPaths();}catch(e){} }
const { chromium } = _require('playwright-core');
const XLSX = _require('xlsx');

const SPREADSHEET = process.argv[2];
const CRED_PATH = process.argv[3];
const LOG_PATH = /*__BUU_CFG_0__*/null;
const ERR_HANDLE = /*__BUU_CFG_1__*/null;
const SELECTOR_TIMEOUT = /*__BUU_CFG_2__*/null;
const PAGE_LOAD_MODE = /*__BUU_CFG_3__*/null;
// v2.0.2: navigation timeout for the navigate step. PestPac lead pages can be very slow on a
// large account, so this is 90s (vs the old hardcoded 30s) to cut false skips on slow loads.
const NAV_TIMEOUT = 90000;
const RETRY_COUNT = /*__BUU_CFG_4__*/null;
// v2.2.2 Session 2E: per-job knobs.
const CHROMIUM_EXE = /*__BUU_CFG_6__*/null;
const FLOW_STEPS = /*__BUU_CFG_7__*/null;
const SETUP_STEPS = /*__BUU_CFG_8__*/null;
const TEARDOWN_STEPS = /*__BUU_CFG_9__*/null;
const RUN_CONTEXT = /*__BUU_CFG_10__*/null;
// v2.2.2 Session 2C: step-by-step mode. Coordinator passes 'run-all' / 'step' / 'step-row'
// when spawning. Pool forces workers=1 batch=1 when startMode is 'step' or 'step-row',
// then scales up when the user clicks Run-All (coordinator handles that scaling).
const START_MODE = /*__BUU_CFG_11__*/null;
// v2.2.3 Session 3C (A1): diagnostic capture constants. CAPTURE_DIR is null when disabled.
// CAPTURE_BUCKET_CAP limits per-(status,errorCategory) folders so high-volume failure modes
// don't fill the disk. zlib is required here so the gzip call below doesn't reach for a
// missing module under packaging.
const DIAGNOSTIC_CAPTURE = /*__BUU_CFG_12__*/null;
const CAPTURE_DIR = /*__BUU_CFG_13__*/null;
const CAPTURE_BUCKET_CAP = /*__BUU_CFG_14__*/null;
const zlib = require('zlib');
const LOGIN_STEPS = FLOW_STEPS.filter(s => s.locked && s.type !== 'pestpac-logout');
const DATA_STEPS  = FLOW_STEPS.filter(s => !s.locked && s.type !== 'pestpac-logout');
const LOGOUT_STEP = FLOW_STEPS.find(s => s.type === 'pestpac-logout') || {type:'pestpac-logout'};

const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\n');}

// ── stdin command channel ──
// Pre-2.2.2: only batch/drain messages flowed here.
// v2.2.2 Session 2C: also demuxes step-by-step commands sent by the coordinator on behalf
// of the renderer (mode / next-step / next-row / run-all / stop). A separate readline
// would have collided with this one (both consume each \n-delimited message), so one
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
// v2.2.3 Session 3C (A1): ring buffers for per-row console + response capture. Reset to
// empty arrays at the top of each row in the batch loop. Bounded to avoid runaway memory
// during a long-running step (e.g. a PestPac page that spams console messages).
const _CONSOLE_BUFFER_MAX = 200;
const _RESPONSE_BUFFER_MAX = 50;
let _consoleBuffer = [];
let _responseBuffer = [];
// Per-(status, errorCategory) capture counter so we cap at CAPTURE_BUCKET_CAP per bucket.
// Keys are 'status|errorCategory' strings. Tracked locally to this worker; the cap is
// per-worker, not pool-wide (an N-worker pool gets up to N*CAPTURE_BUCKET_CAP captures
// per bucket — acceptable for v2.2.3 since exact pool-wide capping would need an IPC).
const _captureBucketCount = {};
const _readline = require('readline');
const _rl = _readline.createInterface({ input: process.stdin, terminal: false });
// Phase 3 CRASH SAFETY: stdout to a dead parent raises EPIPE as a stream 'error' —
// swallow it so a dying coordinator cannot crash the worker mid-row.
process.stdout.on('error', function(){});
// If the coordinator dies our stdin closes. Finish the current row, SPILL its result
// to disk (nobody is journaling anymore), log out, exit. Launch recovery merges
// journal-spill-*.jsonl into the pool journal before offering Resume.
let _coordinatorDead = false;
const SPILL_PATH = (function(){
  // R8: logs moved out of userData (C:\BUU\logs) so the old dirname(dirname(LOG_PATH))
  // derivation no longer lands where mergeSpillFiles scans. The coordinator now passes
  // userData explicitly; the derivation stays as the fallback for old runContexts.
  try { return path.join(RUN_CONTEXT.userDataDir || path.dirname(path.dirname(LOG_PATH)), 'journal-spill-' + (RUN_CONTEXT.runId || ('w'+process.pid)) + '.jsonl'); }
  catch(e){ return null; }
})();
function spillResult(row, status, error){
  if(!SPILL_PATH) return;
  try { fs.appendFileSync(SPILL_PATH, JSON.stringify({ poolId: RUN_CONTEXT.poolId||null, j: RUN_CONTEXT.jobId||null, r: row, s: status, error: error||'', ts: new Date().toISOString() }) + '\n'); } catch(e){}
}
let _pendingCursor = null; // R5b: set by flow-update with a cursor; consumed at the pause loop
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
    case 'flow-update':
      // R5b: live flow reload at a pause boundary. Replaces the DATA steps with the
      // renderer's current editor state (same locked/logout filter as boot); optional
      // cursor repositions (0-based data-step index). Without a cursor the pending
      // pause stays pending — edits apply from the current step forward via the
      // rebind in the step loop.
      if(Array.isArray(msg.steps)){
        DATA_STEPS.length = 0;
        for(const _st of msg.steps){ if(!_st.locked && _st.type !== 'pestpac-logout') DATA_STEPS.push(_st); }
      }
      if(msg.cursor != null && _pendingPauseResolve){
        _pendingCursor = Math.max(0, parseInt(msg.cursor) || 0);
        const r = _pendingPauseResolve; _pendingPauseResolve = null; r('reposition');
      }
      break;
    // R5 debugger cursor commands — all just release the pending pause with their name;
    // the step loop interprets them.
    case 'redo-step':
    case 'last-step':
    case 'skip-step':
    case 'restart-row':
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
_rl.on('close', function(){
  _coordinatorDead = true;
  _draining = true;
  if(_pendingBatchResolve){ const r=_pendingBatchResolve; _pendingBatchResolve=null; r({cmd:'drain'}); }
  if(_pendingPauseResolve){ const r=_pendingPauseResolve; _pendingPauseResolve=null; r('auto'); }
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
              const _sys = buuSystemToken(ref, RUN_CONTEXT); if(_sys !== null) return _sys; // R6 (hoisted decl from the inlined steps source)
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
  else if(step.type === 'ifclick') value = '(click if present within ' + (step.presenceSec || 1) + 's, else continue)';
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
    const summary=[{Metric:'Worker',Value:/*__BUU_CFG_15__*/null},{Metric:'Processed',Value:logEntries.filter(e=>e.row).length},{Metric:'Last updated',Value:new Date().toLocaleString()}];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');
    if(logEntries.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logEntries), 'Rows');
    XLSX.writeFile(wb, LOG_PATH);
  }catch(e){ emit({type:'log-error', message:e.message}); }
}

// ── load all rows into memory once (workers index into this by 1-based row number) ──
function loadAllRows(fp){
  const ext=path.extname(fp).toLowerCase();
  if(ext==='.csv'){
    const lines=fs.readFileSync(fp,'utf8').split('\n').filter(Boolean);
    const headers=lines[0].split(',').map(h=>h.trim().replace(/^"|"$/g,''));
    const out=[];
    for(let i=1;i<lines.length;i++){ const vals=lines[i].split(',').map(v=>v.trim().replace(/^"|"$/g,'')); const row={}; headers.forEach((h,j)=>row[h]=vals[j]||''); out.push(row); }
    return out;
  }
  const wb=XLSX.readFile(fp);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
}

// v2.2.2: shared canonical login (was a 4th copy here; see LOGIN_TO_PESTPAC_SRC at top of main.js).

/*__BUU_INLINE LOGIN_TO_PESTPAC_SRC__*/


// v2.2.2 (Session 2A): selector helpers via canonical constants (see main.js top).
// Phase 2: locator + find-by-text stack now lives in src/engine/locate.js

/*__BUU_INLINE LOCATE_STACK_SRC__*/


// v2.2.2 Session 2D: network-aware retry + error classification (was buildRunner-only).

/*__BUU_INLINE PROBE_NETWORK_FN_SRC__*/



/*__BUU_INLINE WAIT_FOR_NETWORK_FN_SRC__*/



/*__BUU_INLINE CLASSIFY_ERROR_FN_SRC__*/



/*__BUU_INLINE CLASSIFY_PHASE_FN_SRC__*/


// Phase 2: step handlers (runStep) now live in src/engine/steps.js

/*__BUU_INLINE STEPS_SRC__*/


// Run a once-flow (setup/teardown) — no row context.
async function runOnceFlow(page, steps, creds){
  for(let i=0;i<steps.length;i++){ try{ await runStep(page, steps[i], {}, creds); }catch(e){ return {ok:false, error:e.message, stepIndex:i}; } }
  return {ok:true};
}

async function processRow(page, row, creds, rowNum){
  const done=[];
  // v2.2.3 Session 3C (A1): step trail with timestamps lives on the row so the diagnostic
  // dump (written outside processRow) can include the full timeline. Reset on every attempt
  // so a retry shows the retry's trail, not the failed first attempt + retry concatenated.
  row.__stepTrail = [];
  // v2.2.2 Session 2C: __STOP__ / __NEXT_ROW__ sentinels for step-mode control flow.
  // - 'next-step' / 'auto' / 'run-all': falls through to execute the step normally.
  // - 'next-row': throws __NEXT_ROW__ so the row is recorded as an error (manual skip) and the loop moves on.
  // - 'stop': throws __STOP__ so the outer loop bails out and we proceed to shutdown.
  const attempt=async()=>{
    done.length=0;
    row.__stepTrail = []; // reset on retry too
    let _autoOnce = false; // R5: redo-step executes the repositioned step without pausing first
    for(let si=0;si<DATA_STEPS.length;si++){
      let s=DATA_STEPS[si];
      emit({type:'step', row:rowNum, step:si+1, totalSteps:DATA_STEPS.length});
      // Pause BEFORE each step in step mode. Dialog steps skip the pause — they register an
      // invisible page.on('dialog') listener; pausing here makes the user click Next on a no-op,
      // then immediately again on the real action. Same rationale as buildRunner (v1.3.0 Item 5).
      // Phase 3 (D2): honor Stop at EVERY step boundary in every mode — abandon the row
      // instead of grinding remaining steps/waits/retries for minutes after Stop.
      if(currentMode === 'stop') throw new Error('__STOP__');
      const _skipPause = _autoOnce; _autoOnce = false;
      if(currentMode === 'step' && s.type !== 'dialog' && !_skipPause){
        const _preview = resolvePreview(s, row, creds);
        emit({type:'pause-step', row:rowNum, stepIndex:si, totalSteps:DATA_STEPS.length, step:_preview, mode:currentMode});
        const cmd = await waitForCommand();
        if(currentMode === 'stop') throw new Error('__STOP__');
        if(cmd === 'next-row') throw new Error('__NEXT_ROW__');
        // R5 debugger cursor commands (we are paused BEFORE executing step si):
        //   skip-step: do not execute si; pause at si+1
        //   last-step: cursor back one, NO execution (no undo of page state); pause at si-1
        //   restart-row: cursor to step 1, trail cleared; pause there (page state untouched)
        //   redo-step: re-execute the previously executed step (si-1), then pause here again
        if(cmd === 'skip-step'){
          row.__stepTrail.push({ index: si, label: s._label || s.type, type: s.type, ok: true, note: 'skipped by user', ms: 0, ts: new Date().toISOString() });
          emit({type:'log', message:'Step '+(si+1)+' skipped by user'});
          continue;
        }
        if(cmd === 'last-step'){ si = Math.max(-1, si - 2); continue; }
        if(cmd === 'restart-row'){ done.length = 0; row.__stepTrail = []; si = -1; emit({type:'log', message:'Row '+rowNum+' restarted from step 1 by user'}); continue; }
        if(cmd === 'redo-step'){ si = Math.max(-1, si - 2); _autoOnce = true; continue; }
        if(cmd === 'reposition'){ si = (_pendingCursor != null ? _pendingCursor : si + 1) - 1; _pendingCursor = null; continue; }
        // 'next-step' / 'run-all' / 'auto' fall through.
        s = DATA_STEPS[si]; // R5b: rebind — a live flow update may have replaced the steps
        if(!s) break; // flow shrank below the cursor — the row is done
      }
      const _stepStart = Date.now();
      // v2.2.9: steps may leave a branch note on the row (ifclick: 'clicked' / 'not present').
      // Captured into the trail + the done label so the branch taken is visible per row.
      let _note;
      try {
        await runStep(page, s, row, creds);
        _note = row.__stepNote; delete row.__stepNote;
        row.__stepTrail.push({ index: si, label: s._label || s.type, type: s.type, ok: true, note: _note || undefined, ms: Date.now() - _stepStart, ts: new Date().toISOString() });
      } catch (stepErr) {
        delete row.__stepNote;
        row.__stepTrail.push({ index: si, label: s._label || s.type, type: s.type, ok: false, error: stepErr.message, ms: Date.now() - _stepStart, ts: new Date().toISOString() });
        throw stepErr;
      }
      done.push((s._label||s.type) + (_note ? ' ['+_note+']' : ''));
    }
  };
  try{ await attempt(); return {status:'ok', fieldsWritten:done.join(' | ')}; }
  catch(e){
    // v2.2.2 Session 2C: step-mode sentinels short-circuit retry — they're user actions,
    // not errors. STOP propagates to the caller; NEXT_ROW records the row as a manual-skip error.
    if(e && e.message === '__STOP__') throw e;
    if(e && e.message === '__NEXT_ROW__') return {status:'error', error:'Skipped via Next-row during step-through', failedStep:'(user skipped)'};
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
          if(e2 && e2.message === '__NEXT_ROW__') return {status:'error', error:'Skipped via Next-row during step-through', failedStep:'(user skipped)'};
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

// v2.2.3 Session 3C (A1): per-row diagnostic capture. Writes a folder under CAPTURE_DIR
// named 'row-<N>-<status>-<errorCategory>/' containing screenshot.png, dom.html.gz, url.txt,
// steps.json (step trail with timestamps), console.log (browser console buffer for this row),
// responses.log (non-OK HTTP responses + every non-GET), dialogs.json (captured dialogs).
// Capped per (status,errorCategory) bucket to CAPTURE_BUCKET_CAP so high-volume failure
// modes don't fill the disk. Best-effort: any capture step that fails is silently skipped
// so a slow page or read-only disk never breaks the run.
async function captureRowDiagnostic(page, row, rowNum, res, durationMs){
  if (!DIAGNOSTIC_CAPTURE || !CAPTURE_DIR) return;
  try {
    const status = res.status || 'unknown';
    const cat = res.errorCategory || (status === 'ok' || status === 'ok (retry)' ? 'success' : 'general');
    const bucketKey = status + '|' + cat;
    if ((_captureBucketCount[bucketKey] || 0) >= CAPTURE_BUCKET_CAP) return;
    _captureBucketCount[bucketKey] = (_captureBucketCount[bucketKey] || 0) + 1;
    // Sanitize the folder name so Windows is happy.
    const safeStatus = String(status).replace(/[^a-zA-Z0-9-]/g, '_');
    const safeCat = String(cat).replace(/[^a-zA-Z0-9-]/g, '_');
    const dir = path.join(CAPTURE_DIR, 'row-' + rowNum + '-' + safeStatus + '-' + safeCat);
    try { fs.mkdirSync(dir, { recursive: true }); } catch(e) { return; }
    // 1. Screenshot first (most likely to fail on a closed page; do it before slow work).
    try {
      await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: false, timeout: 5000 });
    } catch(e) { fs.writeFileSync(path.join(dir, 'screenshot.error.txt'), String(e.message)); }
    // 2. URL.
    try { fs.writeFileSync(path.join(dir, 'url.txt'), page.url()); } catch(e) {}
    // 3. Step trail with timestamps.
    try {
      const trail = (row.__stepTrail || []).map(t => Object.assign({}, t));
      const meta = { row: rowNum, status: status, error: res.error || '', errorCategory: cat, phase: res.phase || '', failedStep: res.failedStep || '', durationMs: durationMs, fieldsWritten: res.fieldsWritten || '' };
      fs.writeFileSync(path.join(dir, 'steps.json'), JSON.stringify({ meta: meta, trail: trail }, null, 2));
    } catch(e) {}
    // 4. Console buffer (last N entries).
    try {
      const txt = _consoleBuffer.map(e => '[' + e.ts + '] ' + e.level + ': ' + e.text).join('\n');
      fs.writeFileSync(path.join(dir, 'console.log'), txt);
    } catch(e) {}
    // 5. Response buffer (non-OK + non-GET).
    try {
      const txt = _responseBuffer.map(e => '[' + e.ts + '] ' + e.method + ' ' + e.status + ' ' + e.url).join('\n');
      fs.writeFileSync(path.join(dir, 'responses.log'), txt);
    } catch(e) {}
    // 6. Dialogs.
    try {
      const dl = row.__dialogs || [];
      fs.writeFileSync(path.join(dir, 'dialogs.json'), JSON.stringify(dl, null, 2));
    } catch(e) {}
    // 7. DOM snapshot last (potentially largest + slowest).
    try {
      const html = await page.content();
      const gz = zlib.gzipSync(Buffer.from(html, 'utf8'));
      fs.writeFileSync(path.join(dir, 'dom.html.gz'), gz);
    } catch(e) { fs.writeFileSync(path.join(dir, 'dom.error.txt'), String(e.message)); }
  } catch(_outer) { /* outer catch: capture is never allowed to break the run */ }
}

async function main(){
  const creds=dec(fs.readFileSync(CRED_PATH,'utf8'))[0]||{};
  const ALL_ROWS = loadAllRows(SPREADSHEET);
  // v2.2.4: regression fix from v2.2.2 — when the single-runner was killed and step-by-step
  // was routed through the pool worker, the worker kept its headless:true setting. That made
  // step-by-step useless because the user can't watch what's happening. Now we honor
  // START_MODE: 'step' and 'step-row' launch headed so the user can see the browser; 'run-all'
  // stays headless for performance (a normal pool run with 10 workers can't open 10 windows).
  const _isStepMode = (START_MODE === 'step' || START_MODE === 'step-row');
  const browser = await chromium.launch({ headless: !_isStepMode, executablePath:CHROMIUM_EXE, args:['--disable-gpu','--disable-dev-shm-usage','--disable-background-timer-throttling'] });
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

  // v2.2.3 Session 3C (A1): per-row console + HTTP-response capture for diagnostic dumps.
  // Bounded ring buffers so a chatty page can't grow memory unbounded mid-row. Reset to empty
  // at the top of each row in the batch loop. Captures every console message (log/warn/error)
  // and every non-OK HTTP response status; the diagnostic dump uses both to explain why a row
  // looked successful but PestPac didn't persist (the void-flow false-ok pattern that motivated
  // v2.2.3 — a 200 response with the wrong body is invisible without this trail).
  page.on('console', msg => {
    try {
      const t = msg.type();
      const text = msg.text();
      if (_consoleBuffer.length >= _CONSOLE_BUFFER_MAX) _consoleBuffer.shift();
      _consoleBuffer.push({ ts: new Date().toISOString(), level: t, text: text });
    } catch(e) { /* never throws */ }
  });
  page.on('response', async resp => {
    try {
      const status = resp.status();
      const url = resp.url();
      const method = resp.request().method();
      // Filter: skip GETs of static assets to keep the buffer signal-to-noise high. Any
      // non-GET (POST/PUT/DELETE/PATCH) is interesting (form submissions). GETs are captured
      // only when status >= 400 (errors are diagnostic gold).
      if (method === 'GET' && status < 400) return;
      if (_responseBuffer.length >= _RESPONSE_BUFFER_MAX) _responseBuffer.shift();
      _responseBuffer.push({ ts: new Date().toISOString(), method: method, status: status, url: url });
    } catch(e) { /* never throws */ }
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
  // v2.2.2 Session 2E: re-auth timer scoped to main(). nextReauthAt=0 disables proactive re-auth.
  let nextReauthAt = REAUTH_INTERVAL_MS > 0 ? Date.now() + REAUTH_INTERVAL_MS : 0;
  while(!_draining){
    const msg = await requestBatch();
    if(!msg || msg.cmd==='drain' || _draining){ break; }
    if(msg.cmd!=='batch' || !Array.isArray(msg.rows) || msg.rows.length===0){ continue; }
    { // one row per pull (Phase 2 teardown: batching removed)
      const rowNum = msg.rows[0];
      // v2.2.1 LOSSLESS RECLAIM (worker side): a drain can arrive mid-batch (happens constantly
      // during elastic scale-down). We stop at this ROW boundary (current row already finished),
      // but the UNSTARTED tail of this batch was already handed out by the coordinator (removed
      // from the queue) and is NOT yet in completedRows. Hand it back so another worker picks it
      // up — otherwise these rows vanish silently. Capture the tail and break; the emit happens
      // after the loop, before the shutdown/logout sequence.
      const row = ALL_ROWS[rowNum-1];
      if(!row){ emit({type:'row-result', row:rowNum, status:'error', error:'row index out of range'}); continue; }
      // Phase 3 (D7 spec): TIMER REFRESH = full logout THEN login at the row boundary.
      // Purpose is beating PestPac's inactivity auto-logout with a genuinely fresh
      // session — a refresh, not a probe. Failure recovery below is the safety net.
      if (nextReauthAt > 0 && Date.now() >= nextReauthAt) {
        emit({type:'log', message:'Session refresh (timer) before row '+rowNum+': logout then login'});
        try {
          if((creds.platform||'pestpac')!=='frankware'){ try{ await logoutFromPestPac(page); }catch(e){} }
          await loginToPestPac(page, creds);
          nextReauthAt = Date.now() + REAUTH_INTERVAL_MS;
          emit({type:'log', message:'Session refresh complete. Continuing.'});
        } catch (e) {
          emit({type:'log', message:'Session refresh failed: '+e.message+' — continuing; failure recovery will catch a dead session.'});
        }
      }
      // batchPos/batchSize = e.g. 3/10 (which row of this batch); totalSteps for the step counter.
      emit({type:'row-start', row:rowNum});
      const t0=Date.now();
      // v2.2.3 Session 3A (A3): set the row-attribution globals so the blanket dialog
      // listener can tag captured dialogs with this row. Cleared after row-result emit.
      _currentRowNum = rowNum;
      _currentRow = row;
      // v2.2.3 Session 3C (A1): reset per-row capture buffers. console.on and response.on
      // listeners are installed once at page setup and push to these arrays continuously;
      // resetting here scopes captured signal to this row only.
      _consoleBuffer = [];
      _responseBuffer = [];
      // v2.2.2 Session 2C: processRow throws __STOP__ when user clicked Stop mid-step.
      // Catch it here so the batch loop can drain cleanly (with the rest of the batch
      // released to the coordinator via _reclaimRows).
      let res;
      try{ res = await processRow(page, row, creds, rowNum); }
      catch(e){
        if(e && e.message === '__STOP__'){
          _draining = true;
          emit({type:'row-result', row:rowNum, status:'error', error:'Stopped by user at a step boundary', durationMs:Date.now()-t0});
          _currentRowNum = null; _currentRow = null;
          break;
        }
        _currentRowNum = null; _currentRow = null;
        throw e;
      }
      // Phase 3 FAILURE RECOVERY (D7): a dead session makes every row fail identically —
      // per-row retries re-run steps against the login page and can never succeed (the
      // 3,557-row fail-through). On any row error, probe for the login screen WITHOUT
      // navigating (current URL + login-field presence). If logged out: re-login and
      // retry this row ONCE.
      if(res && res.status==='error'){
        let _authDead=false;
        try{
          const _u=page.url();
          if(/login\.pestpac\.com/i.test(_u)) _authDead=true;
          else if((creds.platform||'pestpac')==='frankware' && /\/login/i.test(_u)) _authDead=true;
          else if(await page.$('input[name="uid"]')) _authDead=true;
          else if(await page.$('input[name="username"]')) _authDead=true;
        }catch(e){}
        if(_authDead){
          emit({type:'log', message:'Row '+rowNum+' failed on a dead session (login screen detected). Re-logging in and retrying the row once.'});
          try{
            await loginToPestPac(page, creds);
            if (REAUTH_INTERVAL_MS > 0) nextReauthAt = Date.now() + REAUTH_INTERVAL_MS;
            const _res2 = await processRow(page, row, creds, rowNum);
            if(_res2){ if(_res2.status==='error') _res2.error = (_res2.error||'')+' (after session-recovery re-login)'; res = _res2; }
          }catch(e){
            if(e && e.message === '__STOP__'){
              _draining = true;
              emit({type:'row-result', row:rowNum, status:'error', error:'Stopped by user at a step boundary', durationMs:Date.now()-t0});
              _currentRowNum = null; _currentRow = null;
              break;
            }
            emit({type:'log', message:'Session-recovery re-login failed: '+e.message+' — keeping the original row error.'});
          }
        }
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
        scrape: row.__scrape||null,
        errorCategory: res.errorCategory || '', phase: res.phase || '',
        dialogs: row.__dialogs || null});
      // Phase 3 CRASH SAFETY: the emit above went nowhere if the coordinator is dead.
      if(_coordinatorDead) spillResult(rowNum, res.status, res.error||'');
      // v2.2.3 Session 3C (A1): diagnostic capture. Awaited inline so the next row's listeners
      // don't overwrite buffers mid-serialization. Bucket-capped + best-effort: a slow capture
      // can add ~1-3s per captured row, but is bounded by CAPTURE_BUCKET_CAP per bucket. The
      // helper itself swallows all errors so a capture failure never breaks the run.
      try { await captureRowDiagnostic(page, row, rowNum, res, Date.now()-t0); } catch(_) {}
      _currentRowNum = null; _currentRow = null;
      // v2.2.2 Session 2C: pause AFTER row in step-row mode. Same gating as buildRunner
      // (step-row pauses on the boundary so the user can verify the row's outcome in PestPac
      // before continuing). Skipped on the last row of the batch only if a drain has arrived;
      // otherwise the row-pause still fires because the next row may come from a future batch.
      if(currentMode === 'step-row' && !_draining){
        emit({type:'pause-row', row:rowNum, mode:currentMode});
        await waitForCommand();
        if(currentMode === 'stop'){
          _draining = true;
          break;
        }
      }
    }
  }


  // v2.1.0: shutdown sequence on drain. Report each phase so the UI can show
// 'shutting down' -> 'logging out' -> gone. Logout MUST happen (frees the PestPac license),
// so it gets its own try with a hard time budget and we report whether it succeeded.
  emit({type:'shutting-down'});
  if(TEARDOWN_STEPS.length){ try{ await runOnceFlow(page,TEARDOWN_STEPS,creds); }catch(e){} }
  emit({type:'logging-out'});
  // Phase 3 NEW LOGOUT — one URL (Mode=Logout), verify login page, 5s total budget,
  // every URL touched is logged. Replaces the 4-step dance + 150s budget (KB item 34;
  // the 28-stuck-sessions incident). Frankware has no Mode=Logout: single flow-step
  // attempt with a 5s cap, then a URL probe.
  let _loggedOut=false, _attempt=0;
  if((creds.platform||'pestpac')==='frankware'){
    try{
      await Promise.race([
        runStep(page, LOGOUT_STEP, {}, creds),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('logout step timeout')), 5000)),
      ]);
    }catch(e){}
    _attempt=1;
    let _u=''; try{ _u=page.url(); }catch(e){}
    _loggedOut = /\/login/i.test(_u);
    emit({type:'logout-attempt', attempt:1, ok:_loggedOut, url:_u});
  } else {
    const _r = await logoutFromPestPac(page);
    _loggedOut=_r.ok; _attempt=_r.attempts;
    for(let _i=0;_i<_r.urls.length;_i++){
      emit({type:'logout-attempt', attempt:_i+1, ok:(_i===_r.urls.length-1)&&_r.ok, url:_r.urls[_i]});
    }
  }
  emit({type:'logged-out', ok:_loggedOut, attempts:_attempt});
  flush();
  try{ await browser.close(); }catch(e){}
  emit({type:'retired', loggedOut:_loggedOut});
  process.exit(0);
}
main().catch(e=>{ emit({type:'fatal',error:e.message}); try{flush();}catch{} process.exit(1); });
