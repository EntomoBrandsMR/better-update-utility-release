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
    // per-job retry knobs (retryCount, retryRowIndexes, reauthIntervalMin)
    // so a resume restores the SAME runtime parameters the original run used. Also adds
    // phaseProgress so resume knows whether coordinator-driven setup already completed.
    const meta = {
      poolId: COORD.poolId,
      startedAt: new Date().toISOString(),
      setupScope: COORD.setupScope,
      startMode: COORD.startMode,
      startModeTarget: COORD.startModeTarget,
      // v2.2.3 Session 3C (A1): persist diagnostic-capture config so resume preserves it.
      diagnosticCapture: COORD.diagnosticCapture,
      captureBucketCap: COORD.captureBucketCap,
      // phaseProgress mirrors the single-runner v3 checkpoint shape. Only the coordinator
      // can write here; per-worker setup/teardown is repeated on each spawn so it doesn't
      // need persistence. Updated by coordMarkPhaseProgress() below.
      phaseProgress: { setupCompleted: false, teardownCompleted: false },
      jobs: Array.from(COORD.jobs.values()).map(j => ({
        jobId: j.jobId, label: j.label, spreadsheetPath: j.spreadsheetPath,
        profileId: j.profileId, setupFlowId: j.setupFlowId, teardownFlowId: j.teardownFlowId,
        errHandle: j.errHandle, totalRows: j.totalRows, flowSteps: j.flowSteps,
        // v2.2.2 Session 2E knobs (persisted for resume)
        retryCount: j.retryCount,
        retryRowIndexes: j.retryRowIndexes, reauthIntervalMin: j.reauthIntervalMin,
        startRow: j.startRow,
      })),
    };
    fs.writeFileSync(coordJournalMetaPath(COORD.poolId), JSON.stringify(meta));
    COORD._rowState = new Map(); // R1: per-row terminal-state tracker for the ok-wins duplicate rule
  }catch(e){ console.error('[coord] could not open journal:', e.message); }
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

// R1: append one row record — FLUSH PER ROW (fs.appendFileSync; no stream, no finalize
// step, the journal is always complete to the last row even through a hard crash).
// Line shape: { j, r, s, rs?, e?, ms?, ts, sup? }. s is ok|error ONLY (normalized here);
// rs is the rich reason (timeout | dialog-blocked | session-dropped | manual | requeued |
// after-retry | network | selector | unknown | ...). Duplicate rule: append-only, ok-wins —
// a line arriving after the row already has an ok is written with sup:1 (superseded).
function coordJournalAppend(jobId, row, status, extra){
  if(!COORD.poolId) return;
  extra = extra || {};
  const raw = String(status || 'error');
  const s = raw.indexOf('ok') === 0 ? 'ok' : 'error';
  let rs = extra.reason || (raw.indexOf('retry') >= 0 ? 'after-retry' : undefined);
  const key = String(jobId) + '|' + row;
  if(!COORD._rowState) COORD._rowState = new Map();
  const prev = COORD._rowState.get(key);
  const line = { j: jobId, r: row, s: s };
  if(rs) line.rs = rs;
  if(extra.error) line.e = String(extra.error).slice(0, 500);
  if(extra.durationMs != null) line.ms = extra.durationMs;
  line.ts = new Date().toISOString();
  if(prev === 'ok') line.sup = 1;
  if(s === 'ok' || prev === 'ok') COORD._rowState.set(key, 'ok');
  else if(rs !== 'requeued') COORD._rowState.set(key, 'error');
  try{ fs.appendFileSync(coordJournalPath(COORD.poolId), JSON.stringify(line) + '\n'); }catch(e){}
}

// v2.2.3 Session 3A (A3): append a dialog record to the journal. Separate from row records
// because dialogs can fire mid-step (multiple per row possible) and we want to keep the row
// record minimal. Discriminated by the `t` field; coordReadJournal needs to filter both.
function coordJournalAppendDialog(jobId, rowNum, message, dialogType, ts){
  if(!COORD.poolId) return;
  try{ fs.appendFileSync(coordJournalPath(COORD.poolId), JSON.stringify({ t:'dlg', j:jobId, r:rowNum, m:message, k:dialogType, ts:ts }) + '\n'); }catch(e){}
}

// Close + clean up the journal on clean pool completion (nothing to resume).
function coordCloseJournal(deleteFiles){
  // R1: no stream to close — every row was flushed on append.
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

// Phase 3 CRASH SAFETY: merge worker spill files (journal-spill-*.jsonl, written when a
// worker outlived a dead coordinator) into their pool journals, so Resume sees those rows
// as completed instead of re-running them. Standalone: needs no COORD. Idempotent-ish:
// each spill file is deleted after a successful merge.
module.exports.mergeSpillFiles = function mergeSpillFiles(){
  const dir = app.getPath('userData');
  let merged = 0;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^journal-spill-.*\.jsonl$/.test(f)); } catch(e){ return 0; }
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(Boolean);
      const byPool = {};
      for (const line of lines) {
        let o; try { o = JSON.parse(line); } catch(e){ continue; }
        if (!o || !o.poolId || o.r === undefined) continue;
        (byPool[o.poolId] = byPool[o.poolId] || []).push(JSON.stringify({ j: o.j || null, r: o.r, s: (String(o.s||'error').indexOf('ok')===0?'ok':'error'), rs: 'spill-merged', e: o.error || '', ts: o.ts || '' }));
      }
      for (const poolId of Object.keys(byPool)) {
        const jp2 = path.join(dir, 'pool-journal-' + poolId + '.jsonl'); // (fixed: poolId already carries the 'pool' prefix)
        if (!fs.existsSync(jp2)) continue; // no journal to merge into — leave the spill alone
        fs.appendFileSync(jp2, byPool[poolId].join('\n') + '\n');
        merged += byPool[poolId].length;
      }
      fs.unlinkSync(full);
    } catch(e){ /* leave the spill file for the next attempt */ }
  }
  return merged;
};

// R1 READER PRECEDENCE — the one implementation, used by resume and the orphan scan.
// ok-wins (nothing supersedes an ok; sup-marked lines are ignored by construction);
// rs:'requeued' is NOT a completion — the row was handed back when its worker died.
// Rows whose final state is requeued are returned as inFlight so the resume prompt can
// name possible double-action rows (Matthew: my eyes decide).
module.exports.readJournalRowStates = function readJournalRowStates(poolId){
  const jpath = path.join(app.getPath('userData'), 'pool-journal-' + poolId + '.jsonl');
  const completedByJob = {}; const last = new Map();
  try{
    const lines = fs.readFileSync(jpath, 'utf8').split('\n');
    for(const line of lines){
      if(!line) continue;
      let rec; try{ rec = JSON.parse(line); }catch(e){ continue; }
      if(rec.t === 'dlg') continue;
      const key = rec.j + '|' + rec.r;
      const prev = last.get(key);
      if(prev && prev.st === 'ok') continue;
      if(rec.s === 'ok') last.set(key, { j:rec.j, r:rec.r, st:'ok' });
      else if(rec.rs === 'requeued') last.set(key, { j:rec.j, r:rec.r, st:'requeued' });
      else last.set(key, { j:rec.j, r:rec.r, st:'error' }); // legacy skip/'ok (retry)' land here — still completions
    }
  }catch(e){}
  const inFlight = [];
  for(const v of last.values()){
    if(v.st === 'requeued'){ inFlight.push({ j:v.j, r:v.r }); continue; }
    (completedByJob[v.j] = completedByJob[v.j] || new Set()).add(v.r);
  }
  return { completedByJob, inFlight };
};
