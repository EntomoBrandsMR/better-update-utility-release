// _r10-discover.js — dirty-tracking hook points + window close (read-only).
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
seg('u() mutator', h, 'function u(', 0, 400);
seg('addStep', h, 'function addStep(', 0, 500);
seg('delete step fn', h, 'function delStep', 0, 300);
seg('removeStep alt', h, 'function removeStep', 0, 300);
seg('builder page title', h, '<div class="page-title">Build steps</div>', 200, 200);
seg('saveFlow tail (after API.saveFlow)', h, 'const p = await API.saveFlow', 0, 700);
seg('New flow button?', h, 'newFlow', 100, 300);
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
seg('mainWindow creation', m, 'mainWindow = new BrowserWindow', 100, 700);
seg('window close handlers', m, "mainWindow.on('close", 200, 500);
fs.writeFileSync(path.join(__dirname, '_r10-dump.txt'), out, 'utf8');
console.log('written', out.length);
