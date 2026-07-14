// _r16-discover2.js — renderer anchors for the schedules panel (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
let out = '';
function seg(label, needle, before, after) {
  const i = h.indexOf(needle);
  out += '=== ' + label + ' (idx ' + i + ') ===\n';
  out += (i >= 0 ? h.slice(Math.max(0, i - before), i + after) : '(NOT FOUND)') + '\n\n';
}
seg('go() fn', 'function go(', 0, 700);
seg('nav-run block + following', 'id="nav-run"', 100, 600);
seg('profiles decl', 'let profiles', 50, 200);
seg('listOnceFlows usage sample', 'listOnceFlows', 200, 500);
fs.writeFileSync(path.join(__dirname, '_r16-dump2.txt'), out, 'utf8');
console.log('written', out.length);
