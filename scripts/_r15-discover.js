// _r15-discover.js — spreadsheet seams (read-only).
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
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
seg('poolStageCurrent head', h, 'async function poolStageCurrent', 0, 1200);
seg('poolRunClick guards', h, 'async function poolRunClick', 0, 900);
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
seg('pool-submit-job totalRows', m, "ipcMain.handle('pool-submit-job'", 0, 1500);
const w = fs.readFileSync(path.join(root, 'src', 'pool', 'worker.js'), 'utf8');
seg('worker rows load', w, 'ALL_ROWS', 400, 400);
const c = fs.readFileSync(path.join(root, 'src', 'pool', 'coordinator.js'), 'utf8');
seg('spawn argv', c, 'spawn(process.execPath, [runnerPath', 100, 250);
fs.writeFileSync(path.join(__dirname, '_r15-dump.txt'), out, 'utf8');
console.log('written', out.length);
