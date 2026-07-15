// _302-css.js — layout CSS + panel-run head, to explain the empty left half.
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const css = h.slice(h.indexOf('<style'), h.indexOf('</style>'));
console.log('===== layout rules =====');
for (const line of css.split(/\r?\n/)) {
  const t = line.trim();
  if (/^(body|html|\.shell|\.content|\.panel|\.sidebar|#mainContent|\.page-header|\.dbg|\.debug|\.pane)\b/.test(t)) console.log('  ' + t.slice(0, 160));
}
console.log('\n===== panel-run first 900 chars =====');
const k = h.indexOf('id="panel-run"');
console.log(h.slice(Math.max(0, k - 120), k + 900));
console.log('\n===== does a debugger pane live inside panel-run? =====');
const seg = h.slice(k, h.indexOf('id="panel-', k + 10));
for (const n of ['stepPane', 'dbgPane', 'debugPane', 'pausePane']) {
  if (seg.includes(n)) console.log('  FOUND ' + n + ' inside panel-run');
}
