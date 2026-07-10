// journal.js — the ONE pool journal writer + reader precedence rules (R1 rework lands
// here). Moved VERBATIM from pool/coordinator.js — Phase 2 refactor, 2026-07-10.
// State stays on COORD (injected); fs/path/app are module-local.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

module.exports = function initJournal({ COORD }) {

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
      // v2.2.3 Session 3C (A1): persist diagnostic-capture config so resume preserves it.
      diagnosticCapture: COORD.diagnosticCapture,
      captureBucketCap: COORD.captureBucketCap,
      // v2.2.3 Session 3D (A2): persist verify-after-action toggle for resume.
      verifyAfterAction: COORD.verifyAfterAction,
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

return { coordJournalPath, coordJournalMetaPath, coordJournalDonePath, coordOpenJournal, coordMarkPhaseProgress, coordJournalAppend, coordJournalAppendDialog, coordCloseJournal, coordMarkJournalDone, coordMostRecentJournalPoolId };
};
