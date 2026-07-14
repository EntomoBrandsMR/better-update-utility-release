// _r5-discover2.js — pausePanel HTML, onPoolPause subscriber, run-control tail.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let out = '';
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
function seg(label, src, needle, before, after) {
  const i = src.indexOf(needle);
  out += '=== ' + label + ' (idx ' + i + ') ===\n';
  out += (i >= 0 ? src.slice(Math.max(0, i - before), i + after) : '(NOT FOUND)') + '\n\n';
}
seg('pausePanel HTML', h, 'id="pausePanel"', 400, 1400);
seg('onPoolPause subscriber', h, 'API.onPoolPause', 200, 1200);
seg('showPause fn', h, 'function showPause', 0, 900);
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const i = m.indexOf("ipcMain.handle('pool-run-control'");
seg('run-control tail', m, "ipcMain.handle('pool-run-control'", -1, 0);
out += m.slice(i + 1600, i + 2600) + '\n';
fs.writeFileSync(path.join(__dirname, '_r5-dump2.txt'), out, 'utf8');
console.log('written', out.length);
