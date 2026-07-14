// _r11-discover.js — sidebar, shim, dispatcher, D6 (read-only).
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
seg('left sidebar / nav', h, 'class="sidebar"', 100, 1800);
seg('dispatcher', h, 'onAutomationEvent', 300, 1400);
seg('updateRunStats', h, 'function updateRunStats', 0, 700);
const p = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
seg('preload shim', p, 'shim', 400, 1800);
const d = fs.readFileSync(path.join(root, 'docs', 'DIAGNOSIS-2026-07.md'), 'utf8');
seg('D6 diagnosis', d, 'D6', 0, 900);
fs.writeFileSync(path.join(__dirname, '_r11-dump.txt'), out, 'utf8');
console.log('written', out.length);
