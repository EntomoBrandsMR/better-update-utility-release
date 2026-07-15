// _dirty-discover.js — why is flowDirty true on a fresh boot with no flow? (read-only)
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const lineOf = (i) => h.slice(0, i).split('\n').length;
console.log('=== markFlowDirty / clearFlowDirty bodies ===');
for (const n of ['function markFlowDirty', 'function clearFlowDirty']) {
  const k = h.indexOf(n);
  console.log(h.slice(k, k + 320) + '\n');
}
console.log('=== every markFlowDirty() caller ===');
let p = -1;
while ((p = h.indexOf('markFlowDirty()', p + 1)) >= 0) {
  const ls = h.lastIndexOf('\n', p) + 1;
  console.log('L' + lineOf(p) + ': ' + h.slice(ls, h.indexOf('\n', p)).trim().slice(0, 130));
}
console.log('\n=== initial steps / login step seeding ===');
for (const n of ['let steps = ', 'steps = [', 'ensureLoginStep', 'seedLogin', 'locked: true', 'locked:true']) {
  let q = -1, c = 0;
  while ((q = h.indexOf(n, q + 1)) >= 0 && c < 3) {
    const ls = h.lastIndexOf('\n', q) + 1;
    console.log('L' + lineOf(q) + ' [' + n + ']: ' + h.slice(ls, h.indexOf('\n', q)).trim().slice(0, 140));
    c++; }
}
console.log('\n=== boot init sequence ===');
const b = h.indexOf('renderColChips(); renderPreview(); renderSteps();');
console.log(h.slice(Math.max(0, b - 700), b + 120));
