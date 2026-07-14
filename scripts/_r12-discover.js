// _r12-discover.js — row-result fields + worker grid element (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const w = fs.readFileSync(path.join(root, 'src', 'pool', 'worker.js'), 'utf8');
const k = w.indexOf("emit({type:'row-result', row:rowNum, status:res.status");
console.log('=== row-result emit ===');
console.log(k >= 0 ? w.slice(k - 60, k + 520) : '(main emit not found — searching any)');
if (k < 0) { const k2 = w.indexOf("type:'row-result'"); console.log(w.slice(k2 - 200, k2 + 500)); }
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
for (const id of ['poolWorkersGrid', 'workerGrid', 'poolWorkerCards', 'workersGrid']) {
  const g = h.indexOf(id);
  if (g >= 0) { console.log('=== ' + id + ' ==='); console.log(h.slice(Math.max(0, g - 250), g + 120)); break; }
}
const g2 = h.indexOf('.map(function(w){') >= 0 ? h.indexOf('.map(function(w){') : h.indexOf('(st.workers||[]).map');
console.log('=== worker cards render target ===');
console.log(h.slice(Math.max(0, g2 - 400), g2 + 100));
