// _p4-r1-journal.js — Phase 4 R1: journal rework.
// Writer: flush-per-row (appendFileSync, no stream/finalize), line shape {j,r,s,rs,e,ms,ts,sup?},
// statuses normalized ok|error with rich reason; duplicate rule ok-wins with sup marks;
// crash-requeued rows get a terminal 'error/requeued' line (silence impossible).
// Reader: ONE precedence implementation (journal.js readJournalRowStates) used by resume +
// orphan scan; requeued rows are NOT completions and surface as in-flight in the prompt.
// Also fixes the mergeSpillFiles double 'pool' prefix bug.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function rep(s, from, to, label) {
  const i = s.indexOf(from);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(from, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  return s.slice(0, i) + to + s.slice(i + from.length);
}
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}
function cutLine(s, needle, label) {
  const i = s.indexOf(needle);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(needle, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let le = s.indexOf('\n', i); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}

// ── journal.js ──
const jp = path.join(root, 'src', 'journal.js');
let j = fs.readFileSync(jp, 'utf8');
if (!j.includes('_rowState')) {
  j = rep(j, "    COORD.journalStream = fs.createWriteStream(coordJournalPath(COORD.poolId), { flags: 'a' });",
    '    COORD._rowState = new Map(); // R1: per-row terminal-state tracker for the ok-wins duplicate rule', 'open stream');
  j = repRx(j, /\}catch\(e\)\{ console\.error\('\[coord\] could not open journal:', e\.message\); COORD\.journalStream = null; \}/,
    "}catch(e){ console.error('[coord] could not open journal:', e.message); }", 'open catch');
  j = cutLine(j, 'batchSize: COORD.batchSize,', 'meta batchSize');
  j = cutLine(j, 'verifyAfterAction: COORD.verifyAfterAction,', 'meta verify');
  j = cutLine(j, "// v2.2.3 Session 3D (A2): persist verify-after-action toggle for resume.", 'meta verify comment');
  j = rep(j, 'retryCount: j.retryCount, breakerThreshold: j.breakerThreshold,', 'retryCount: j.retryCount,', 'meta breaker');
  j = rep(j, '(retryCount, breakerThreshold, retryRowIndexes, reauthIntervalMin)', '(retryCount, retryRowIndexes, reauthIntervalMin)', 'meta comment');
  j = repRx(j, /\/\/ Append one completed-row record\.[\s\S]*?function coordJournalAppend\(jobId, row, status\)\{\r?\n[\s\S]*?\r?\n\}/, [
    '// R1: append one row record — FLUSH PER ROW (fs.appendFileSync; no stream, no finalize',
    '// step, the journal is always complete to the last row even through a hard crash).',
    "// Line shape: { j, r, s, rs?, e?, ms?, ts, sup? }. s is ok|error ONLY (normalized here);",
    "// rs is the rich reason (timeout | dialog-blocked | session-dropped | manual | requeued |",
    "// after-retry | network | selector | unknown | ...). Duplicate rule: append-only, ok-wins —",
    '// a line arriving after the row already has an ok is written with sup:1 (superseded).',
    'function coordJournalAppend(jobId, row, status, extra){',
    '  if(!COORD.poolId) return;',
    '  extra = extra || {};',
    "  const raw = String(status || 'error');",
    "  const s = raw.indexOf('ok') === 0 ? 'ok' : 'error';",
    "  let rs = extra.reason || (raw.indexOf('retry') >= 0 ? 'after-retry' : undefined);",
    "  const key = String(jobId) + '|' + row;",
    '  if(!COORD._rowState) COORD._rowState = new Map();',
    '  const prev = COORD._rowState.get(key);',
    '  const line = { j: jobId, r: row, s: s };',
    '  if(rs) line.rs = rs;',
    '  if(extra.error) line.e = String(extra.error).slice(0, 500);',
    '  if(extra.durationMs != null) line.ms = extra.durationMs;',
    '  line.ts = new Date().toISOString();',
    "  if(prev === 'ok') line.sup = 1;",
    "  if(s === 'ok' || prev === 'ok') COORD._rowState.set(key, 'ok');",
    "  else if(rs !== 'requeued') COORD._rowState.set(key, 'error');",
    "  try{ fs.appendFileSync(coordJournalPath(COORD.poolId), JSON.stringify(line) + '\\n'); }catch(e){}",
    '}'
  ].join('\n'), 'append rewrite');
  fs.writeFileSync(jp, j, 'utf8');
  console.log('journal part 1 done');
} else console.log('journal already done');

// journal part 2: dialog append, close, spill fix, static reader
j = fs.readFileSync(jp, 'utf8');
if (!j.includes('readJournalRowStates')) {
  j = repRx(j, /function coordJournalAppendDialog\(jobId, rowNum, message, dialogType, ts\)\{\r?\n  if\(!COORD\.journalStream\) return;\r?\n  try\{ COORD\.journalStream\.write\(JSON\.stringify\(\{ t:'dlg', j:jobId, r:rowNum, m:message, k:dialogType, ts:ts \}\) \+ '\\n'\); \}catch\(e\)\{\}\r?\n\}/, [
    'function coordJournalAppendDialog(jobId, rowNum, message, dialogType, ts){',
    '  if(!COORD.poolId) return;',
    "  try{ fs.appendFileSync(coordJournalPath(COORD.poolId), JSON.stringify({ t:'dlg', j:jobId, r:rowNum, m:message, k:dialogType, ts:ts }) + '\\n'); }catch(e){}",
    '}'
  ].join('\n'), 'dialog append');
  j = repRx(j, /  try\{ if\(COORD\.journalStream\)\{ COORD\.journalStream\.end\(\); COORD\.journalStream = null; \} \}catch\(e\)\{\}\r?\n/,
    '  // R1: no stream to close — every row was flushed on append.\n', 'close stream');
  j = rep(j, "const jp2 = path.join(dir, 'pool-journal-pool' + poolId + '.jsonl');",
    "const jp2 = path.join(dir, 'pool-journal-' + poolId + '.jsonl'); // (fixed: poolId already carries the 'pool' prefix)", 'spill path fix');
  j = rep(j, "(byPool[o.poolId] = byPool[o.poolId] || []).push(JSON.stringify({ j: o.j || null, r: o.r, s: o.s }));",
    "(byPool[o.poolId] = byPool[o.poolId] || []).push(JSON.stringify({ j: o.j || null, r: o.r, s: (String(o.s||'error').indexOf('ok')===0?'ok':'error'), rs: 'spill-merged', e: o.error || '', ts: o.ts || '' }));", 'spill line shape');
  j = j.replace(/\s*$/, '\n') + [
    '',
    '// R1 READER PRECEDENCE — the one implementation, used by resume and the orphan scan.',
    '// ok-wins (nothing supersedes an ok; sup-marked lines are ignored by construction);',
    "// rs:'requeued' is NOT a completion — the row was handed back when its worker died.",
    '// Rows whose final state is requeued are returned as inFlight so the resume prompt can',
    '// name possible double-action rows (Matthew: my eyes decide).',
    'module.exports.readJournalRowStates = function readJournalRowStates(poolId){',
    "  const jpath = path.join(app.getPath('userData'), 'pool-journal-' + poolId + '.jsonl');",
    '  const completedByJob = {}; const last = new Map();',
    '  try{',
    "    const lines = fs.readFileSync(jpath, 'utf8').split('\\n');",
    '    for(const line of lines){',
    '      if(!line) continue;',
    '      let rec; try{ rec = JSON.parse(line); }catch(e){ continue; }',
    "      if(rec.t === 'dlg') continue;",
    "      const key = rec.j + '|' + rec.r;",
    '      const prev = last.get(key);',
    "      if(prev && prev.st === 'ok') continue;",
    "      if(rec.s === 'ok') last.set(key, { j:rec.j, r:rec.r, st:'ok' });",
    "      else if(rec.rs === 'requeued') last.set(key, { j:rec.j, r:rec.r, st:'requeued' });",
    "      else last.set(key, { j:rec.j, r:rec.r, st:'error' }); // legacy skip/'ok (retry)' land here — still completions",
    '    }',
    '  }catch(e){}',
    '  const inFlight = [];',
    '  for(const v of last.values()){',
    "    if(v.st === 'requeued'){ inFlight.push({ j:v.j, r:v.r }); continue; }",
    '    (completedByJob[v.j] = completedByJob[v.j] || new Set()).add(v.r);',
    '  }',
    '  return { completedByJob, inFlight };',
    '};',
    ''
  ].join('\n');
  fs.writeFileSync(jp, j, 'utf8');
  console.log('journal part 2 done');
} else console.log('journal part 2 already done');

// ── coordinator.js: rich append call + crash-requeue terminal line + shared reader ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('readJournalRowStates')) {
  c = rep(c, 'coordJournalAppend(w.jobId, msg.row, msg.status);', [
    '// R1: pass the rich reason/error/duration through to the journal. Worker-side',
    "      // classifier supplies errorCategory; user-stop rows map to reason 'manual'.",
    '      coordJournalAppend(w.jobId, msg.row, msg.status, {',
    "        reason: msg.errorCategory || (/Stopped by user/.test(msg.error||'') ? 'manual' : undefined),",
    '        error: msg.error, durationMs: msg.durationMs,',
    '      });'
  ].join('\n'), 'rich append');
  c = rep(c, '          cjob.requeue.push(r);', [
    '          cjob.requeue.push(r);',
    "          // R1: every row is guaranteed a terminal journal line — a crash can no longer",
    "          // leave silence. When the row re-runs, its later line wins (requeued is not a",
    '          // completion for the reader).',
    "          coordJournalAppend(w.jobId, r, 'error', { reason: 'requeued', error: 'worker died mid-row; row returned to the queue' });"
  ].join('\n'), 'requeue line');
  c = repRx(c, /      \/\/ Count completed rows per job from the journal\.\r?\n      const completedByJob = \{\};\r?\n      const jp = coordJournalPath\(poolId\);\r?\n      if\(fs\.existsSync\(jp\)\)\{\r?\n[\s\S]*?\r?\n      \}\r?\n/, [
    '      // R1: one reader, one precedence rule (journal.js). Requeued rows are in-flight,',
    '      // not completions — surfaced so the resume prompt can name them.',
    "      const st = require('../journal').readJournalRowStates(poolId);",
    '      const completedByJob = st.completedByJob;',
    '      const jp = coordJournalPath(poolId);',
    ''
  ].join('\n'), 'orphan reader');
  c = rep(c, 'if(totalRemaining > 0) out.push({ poolId, startedAt: meta.startedAt, jobs, totalRemaining });',
    'if(totalRemaining > 0) out.push({ poolId, startedAt: meta.startedAt, jobs, totalRemaining, inFlightRows: st.inFlight.map(x => x.r).sort((a,b)=>a-b).slice(0, 50) });', 'orphan payload');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator done');
} else console.log('coordinator already done');

// ── main.js resume reader + index.html prompt naming ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('readJournalRowStates')) {
  m = repRx(m, /  \/\/ Load completed rows per job from the journal\.\r?\n  \/\/ v2\.2\.3 Session 3A \(A3\): journal now mixes[\s\S]*?  const completedByJob = \{\};\r?\n  if \(fs\.existsSync\(jp\)\) \{\r?\n[\s\S]*?\r?\n  \}\r?\n/, [
    '  // R1: completed rows come from the ONE journal reader (ok-wins; requeued lines are',
    '  // in-flight, not completions — those rows re-run on resume, which is the safe default).',
    "  const completedByJob = require('./journal').readJournalRowStates(poolId).completedByJob;",
    ''
  ].join('\n'), 'resume reader');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');

const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('inFlightRows')) {
  h = rep(h, "  const msg = 'Unfinished worker pool found (started '+when+').\\n\\n'", [
    '  // R1: name rows that were in-flight when the run died — they may have partially run',
    '  // in PestPac before the crash, so resuming re-runs them (possible double-action).',
    '  const inflight = (p.inFlightRows && p.inFlightRows.length)',
    "    ? '\\n\\n⚠ In-flight at crash — these rows may have PARTIALLY run and WILL RE-RUN on resume (verify by eye after): '+p.inFlightRows.join(', ')",
    "    : '';",
    "  const msg = 'Unfinished worker pool found (started '+when+').\\n\\n'"
  ].join('\n'), 'prompt inflight calc');
  h = rep(h, "+ '\\n\\nResume it now? (Cancel lets you discard or ignore it.)';",
    "+ inflight + '\\n\\nResume it now? (Cancel lets you discard or ignore it.)';", 'prompt inflight append');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done');
} else console.log('index already done');
