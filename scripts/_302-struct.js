// _302-struct.js — exact nesting around mainContent / panels / my misplaced panel.
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const L = h.split(/\r?\n/);
const show = (a, b, label) => {
  console.log('===== ' + label + ' (lines ' + a + '-' + b + ') =====');
  for (let i = a; i <= b && i <= L.length; i++) {
    const t = L[i - 1];
    if (t.trim()) console.log(i + ': ' + t.slice(0, 150));
  }
  console.log('');
};
show(755, 768, 'mainContent open');
show(1098, 1120, 'end of panel-run .. panel-schedules start');
show(1135, 1145, 'panel-schedules end .. pasteModal');
console.log('===== layout CSS =====');
for (const sel of ['#mainContent', 'body', '.app', '.sidebar', '.wrap']) {
  let p = -1;
  while ((p = h.indexOf(sel, p + 1)) >= 0 && p < h.indexOf('</style>')) {
    const ls = h.lastIndexOf('\n', p) + 1;
    const line = h.slice(ls, h.indexOf('\n', p)).trim();
    if (line.startsWith(sel)) { console.log('  ' + line.slice(0, 150)); break; }
  }
}
