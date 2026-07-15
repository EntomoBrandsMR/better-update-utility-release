// _hdr-discover.js — the top-bar button cluster: markup + handlers (read-only).
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
seg('Updates button', '>Updates<', 600, 200);
seg('Run automation button', 'Run automation', 700, 300);
seg('Load flow button', '>Load flow<', 300, 100);
fs.writeFileSync(path.join(__dirname, '_hdr-dump.txt'), out, 'utf8');
console.log(out.slice(0, 3800));
