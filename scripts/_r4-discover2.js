// _r4-discover2.js — exact anchors for the main.js/preload sections of R4.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
let out = '';
function seg(label, needle, before, after) {
  const i = m.indexOf(needle);
  out += '=== ' + label + ' (idx ' + i + ') ===\n';
  if (i >= 0) out += m.slice(Math.max(0, i - before), i + after) + '\n\n';
  else out += '(NOT FOUND)\n\n';
}
seg('computeHardwareCap', 'function computeHardwareCap', 0, 900);
// all callers
out += '=== computeHardwareCap callers ===\n';
let k = -1; while ((k = m.indexOf('computeHardwareCap(', k + 1)) >= 0) {
  const ls = m.lastIndexOf('\n', k) + 1; const le = m.indexOf('\n', k);
  out += m.slice(ls, le).trim().slice(0, 150) + '\n';
}
out += '\n';
seg('elastic timer block (P3 D4)', 'COORD.elasticParams = (elastic && licenseProfileId)', 300, 700);
seg('release timer start', 'Phase 3 (D4): start the elastic license timer', 100, 700);
seg('manual clamp pool-start', 'MAX_WORKERS_HARD_CEILING, hwCap', 400, 200);
out += '=== all hwCap mentions ===\n';
const L = m.split(/\r?\n/);
for (let i = 0; i < L.length; i++) if (/hwCap/.test(L[i])) out += (i + 1) + ': ' + L[i].trim().slice(0, 150) + '\n';
out += '\n';
seg('wiring destructure', 'const { COORD, coordJournalPath', 0, 500);
seg('pool-start params', "ipcMain.handle('pool-start'", 0, 900);
const p = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
out += '=== preload pool fns ===\n';
const PL = p.split(/\r?\n/);
for (let i = 0; i < PL.length; i++) if (/pool/i.test(PL[i])) out += (i + 1) + ': ' + PL[i].trim().slice(0, 140) + '\n';
fs.writeFileSync(path.join(__dirname, '_r4-dump2.txt'), out, 'utf8');
console.log('written', out.length);
