// _r5-discover.js — exact shapes for the step debugger build (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let out = '';
const w = fs.readFileSync(path.join(root, 'src', 'pool', 'worker.js'), 'utf8');
function seg(label, src, needle, before, after) {
  const i = src.indexOf(needle);
  out += '=== ' + label + ' (idx ' + i + ') ===\n';
  out += (i >= 0 ? src.slice(Math.max(0, i - before), i + after) : '(NOT FOUND)') + '\n\n';
}
seg('worker line handler', w, "_rl.on('line'", 0, 1600);
seg('worker waitForCommand', w, 'function waitForCommand', 0, 500);
seg('worker NEXT_ROW catch', w, '__NEXT_ROW__', 0, 100);
const k = w.indexOf('__NEXT_ROW__', w.indexOf('__NEXT_ROW__') + 5);
out += '=== all NEXT_ROW mentions ===\n';
let p2 = -1; while ((p2 = w.indexOf('__NEXT_ROW__', p2 + 1)) >= 0) { const ls = w.lastIndexOf('\n', p2) + 1; out += w.slice(ls, w.indexOf('\n', p2)).trim().slice(0, 140) + '\n'; }
out += '\n';
seg('worker step loop', w, 'for(let si=0;si<DATA_STEPS.length;si++)', 200, 2600);
seg('worker DATA_STEPS filter', w, 'DATA_STEPS', 200, 500);
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
seg('pool-run-control handler', m, "ipcMain.handle('pool-run-control'", 0, 1600);
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
seg('onPoolPause renderer', h, 'onPoolPause', 300, 1800);
out += '=== flow save/load API mentions ===\n';
const HL = h.split(/\r?\n/);
for (let i = 0; i < HL.length; i++) if (/saveFlow|loadFlow|flowsList|listFlows|API\.flow/i.test(HL[i])) out += (i + 1) + ': ' + HL[i].trim().slice(0, 130) + '\n';
fs.writeFileSync(path.join(__dirname, '_r5-dump.txt'), out, 'utf8');
console.log('written', out.length);
