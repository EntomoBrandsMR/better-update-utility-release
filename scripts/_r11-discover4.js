// _r11-discover4.js — deletion extents + button wiring (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const L = h.split(/\r?\n/);
let out = '';
function fnExtent(name) {
  const i = h.indexOf('function ' + name);
  if (i < 0) { out += name + ': NOT FOUND\n'; return; }
  const startLine = h.slice(0, i).split('\n').length;
  // find next top-level 'function ' or 'async function ' at column 0 after it
  let j = i + 10;
  while (true) {
    j = h.indexOf('\nfunction ', j + 1);
    const j2 = h.indexOf('\nasync function ', i + 10);
    let cand = j;
    if (j2 >= 0 && (j < 0 || j2 < j) && j2 > i + 10) cand = j2;
    if (cand < 0) break;
    if (cand > i) { j = cand; break; }
  }
  const endLine = j >= 0 ? h.slice(0, j).split('\n').length : -1;
  out += name + ': lines ' + startLine + ' .. next top-level fn at ' + endLine + '\n';
  out += '  head: ' + L[startLine - 1].trim().slice(0, 100) + '\n';
  if (endLine > 0) out += '  next: ' + L[endLine].trim().slice(0, 100) + '\n';
}
for (const n of ['startRun', 'retryFailed', 'handleRunEvent', 'runStopped', 'requestStop', 'forceStopNow']) fnExtent(n);
out += '\n=== runBtn / retryFailedBtn wiring ===\n';
for (let i = 0; i < L.length; i++) if (/runBtn|retryFailedBtn|startRun\(|retryFailed\(|forceStopBtn/.test(L[i]) && /onclick|addEventListener|getElementById/.test(L[i])) out += (i + 1) + ': ' + L[i].trim().slice(0, 140) + '\n';
out += '\n=== _failedRowIndexesThisRun refs ===\n';
for (let i = 0; i < L.length; i++) if (/_failedRowIndexesThisRun/.test(L[i])) out += (i + 1) + ': ' + L[i].trim().slice(0, 110) + '\n';
out += '\n=== runStopped callers ===\n';
for (let i = 0; i < L.length; i++) if (/runStopped\(\)/.test(L[i])) out += (i + 1) + ': ' + L[i].trim().slice(0, 110) + '\n';
out += '\n=== coordinator row-result forward region ===\n';
const c = fs.readFileSync(path.join(__dirname, '..', 'src', 'pool', 'coordinator.js'), 'utf8');
const k = c.indexOf('coordJournalAppend(w.jobId, msg.row, msg.status,');
out += c.slice(Math.max(0, k - 500), k + 400) + '\n';
fs.writeFileSync(path.join(__dirname, '_r11-dump4.txt'), out, 'utf8');
console.log('written', out.length);
