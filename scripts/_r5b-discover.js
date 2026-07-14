// _r5b-discover.js — submit path + flow file APIs (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let out = '';
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
function seg(label, src, needle, before, after) {
  const i = src.indexOf(needle);
  out += '=== ' + label + ' (idx ' + i + ') ===\n';
  out += (i >= 0 ? src.slice(Math.max(0, i - before), i + after) : '(NOT FOUND)') + '\n\n';
}
seg('renderer poolAddJob', h, 'async function poolAddJob', 0, 1700);
seg('renderer saveFlow', h, 'async function saveFlow(){', 0, 1500);
seg('renderer loadFlow', h, 'async function loadFlow(){', 0, 1100);
seg('main save-flow handler', m, "'save-flow'", 200, 900);
seg('main load-flow handler', m, "'load-flow'", 200, 900);
seg('renderer poolRunClick head', h, 'async function poolRunClick', 0, 1200);
fs.writeFileSync(path.join(__dirname, '_r5b-dump.txt'), out, 'utf8');
console.log('written', out.length);
