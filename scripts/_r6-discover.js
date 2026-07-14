// _r6-discover.js — token resolver + chips + column check shapes (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let out = '';
function seg(label, src, needle, before, after) {
  const i = src.indexOf(needle);
  out += '=== ' + label + ' (idx ' + i + ') ===\n';
  out += (i >= 0 ? src.slice(Math.max(0, i - before), i + after) : '(NOT FOUND)') + '\n\n';
}
const s = fs.readFileSync(path.join(root, 'src', 'engine', 'steps.js'), 'utf8');
seg('steps.js runStep head + r()', s, 'async function runStep', 0, 1100);
const w = fs.readFileSync(path.join(root, 'src', 'pool', 'worker.js'), 'utf8');
seg('worker resolvePreview r()', w, 'function resolvePreview', 0, 1100);
seg('worker RUN_CONTEXT cfg', w, 'RUN_CONTEXT', 100, 300);
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
seg('checkFlowColumnsAgainstSheet', h, 'function checkFlowColumnsAgainstSheet', 0, 1300);
seg('token extraction / scan', h, 'scan(s.containerSel)', 700, 300);
// chips: find where column chips render
const k = h.indexOf('chip');
out += '=== chip mentions (first 25 lines) ===\n';
const HL = h.split(/\r?\n/);
let n = 0;
for (let i = 0; i < HL.length && n < 25; i++) if (/chip/i.test(HL[i])) { out += (i + 1) + ': ' + HL[i].trim().slice(0, 130) + '\n'; n++; }
const c = fs.readFileSync(path.join(root, 'src', 'pool', 'coordinator.js'), 'utf8');
seg('coordinator runContext line', c, 'runContext: {', 100, 300);
fs.writeFileSync(path.join(__dirname, '_r6-dump.txt'), out, 'utf8');
console.log('written', out.length);
