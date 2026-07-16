// _303-journal-workerid.js — the journal cannot answer "which worker did this row".
// Schema is {j,r,s,ms,ts} — no worker field, even though BOTH call sites already have the
// worker object in scope. R1 made the journal more reliable and LESS informative; tonight
// that meant reconstructing worker counts from log-file mtimes to analyse a live run.
// Matthew: "if the log does not have a worker id MAKE IT HAVE ONE".
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function patch(file, edits) {
  const p = path.join(root, file);
  let s = fs.readFileSync(p, 'utf8');
  for (const [from, to, label] of edits) {
    const i = s.indexOf(from);
    if (i < 0) throw new Error(file + ': anchor missing: ' + label);
    if (s.indexOf(from, i + 1) >= 0) throw new Error(file + ': anchor NOT UNIQUE: ' + label);
    s = s.slice(0, i) + to + s.slice(i + from.length);
  }
  fs.writeFileSync(p, s, 'utf8');
  console.log(file + ' patched');
}

// ── journal.js: carry the worker id onto the line ──
patch('src/journal.js', [[
  "  const line = { j: jobId, r: row, s: s };\n  if(rs) line.rs = rs;",
  "  const line = { j: jobId, r: row, s: s };\n" +
  "  // v3.0.3: WHICH WORKER did this row. Both callers always had the worker in scope; the\n" +
  "  // field was simply never written, so the journal could not attribute a row to a worker\n" +
  "  // and live runs had to be reconstructed from log-file mtimes. Never infer it — if a\n" +
  "  // caller cannot supply it, the line is honestly worker-less rather than guessed.\n" +
  "  if(extra.workerId) line.w = extra.workerId;\n" +
  "  if(rs) line.rs = rs;",
  'journal line',
]]);

// ── coordinator.js: pass it at both call sites ──
patch('src/pool/coordinator.js', [
  [
    "coordJournalAppend(w.jobId, r, 'error', { reason: 'requeued', error: 'worker died mid-row; row returned to the queue' });",
    "coordJournalAppend(w.jobId, r, 'error', { reason: 'requeued', error: 'worker died mid-row; row returned to the queue', workerId: w.workerId });",
    'requeue site',
  ],
  [
    "      coordJournalAppend(w.jobId, msg.row, msg.status, {\n        reason: msg.errorCategory || (/Stopped by user/.test(msg.error||'') ? 'manual' : undefined),\n        error: msg.error, durationMs: msg.durationMs,\n      });",
    "      coordJournalAppend(w.jobId, msg.row, msg.status, {\n        reason: msg.errorCategory || (/Stopped by user/.test(msg.error||'') ? 'manual' : undefined),\n        error: msg.error, durationMs: msg.durationMs,\n        workerId: w.workerId, // v3.0.3: attribute every row to the worker that ran it\n      });",
    'row-result site',
  ],
]);
