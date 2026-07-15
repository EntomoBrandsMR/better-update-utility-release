// _302-discover.js — (1) where does panel-schedules actually live in the DOM, (2) how are
// panels shown/hidden, (3) why does Load flow claim an empty flow is unsaved. (read-only)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
let out = '';
const lineOf = (i) => h.slice(0, i).split('\n').length;

// ── 1) structural landmarks in document order ──
out += '########## DOM landmarks (document order) ##########\n';
const marks = [
  ['mainContent open', 'id="mainContent"'],
  ['panel-run', 'id="panel-run"'],
  ['panel-schedules', 'id="panel-schedules"'],
  ['pasteModal', 'id="pasteModal"'],
];
const found = marks.map(([n, s]) => [n, h.indexOf(s)]).filter(x => x[1] >= 0).sort((a, b) => a[1] - b[1]);
for (const [n, i] of found) out += '  line ' + lineOf(i) + '  ' + n + '\n';

// ── 2) is panel-schedules nested inside a modal? walk tags between mainContent and it ──
const mc = h.indexOf('id="mainContent"');
const ps = h.indexOf('id="panel-schedules"');
const pm = h.indexOf('id="pasteModal"');
out += '\npanel-schedules is ' + (ps > pm ? 'AFTER' : 'BEFORE') + ' pasteModal\n';
out += 'panel-schedules is ' + (ps > mc ? 'AFTER' : 'BEFORE') + ' mainContent open\n';

// depth: count unclosed <div> between mainContent and panel-schedules
const between = h.slice(mc, ps);
const opens = (between.match(/<div\b/g) || []).length;
const closes = (between.match(/<\/div>/g) || []).length;
out += 'unclosed <div> depth from mainContent to panel-schedules: ' + (opens - closes) + '  (0 = sibling of the other panels)\n';

// same measure for a KNOWN-GOOD panel, as the control
const pr = h.indexOf('id="panel-run"');
if (pr > 0) {
  const b2 = h.slice(mc, pr);
  out += 'same depth measure for panel-run (the control):            ' + (((b2.match(/<div\b/g) || []).length) - ((b2.match(/<\/div>/g) || []).length)) + '\n';
}

// ── 3) how panels are shown/hidden ──
out += '\n########## go() / panel visibility ##########\n';
const g = h.indexOf('function go(');
out += h.slice(g, g + 620) + '\n';
out += '\n[.panel CSS]\n';
let p = -1;
while ((p = h.indexOf('.panel', p + 1)) >= 0 && p < h.indexOf('</style>')) {
  const le = h.indexOf('\n', p);
  const ls = h.lastIndexOf('\n', p) + 1;
  const line = h.slice(ls, le).trim();
  if (line.startsWith('.panel')) out += '  ' + line.slice(0, 120) + '\n';
}

// ── 4) dirty tracking: why does an untouched flow prompt? ──
out += '\n########## dirty tracking ##########\n';
for (const n of ['function markFlowDirty', 'function clearFlowDirty', 'function confirmUnsaved', 'flowDirty']) {
  let q = -1, c = 0;
  while ((q = h.indexOf(n, q + 1)) >= 0 && c < 4) {
    const ls = h.lastIndexOf('\n', q) + 1, le = h.indexOf('\n', q);
    out += 'L' + lineOf(q) + ': ' + h.slice(ls, le).trim().slice(0, 165) + '\n';
    c++;
  }
}
out += '\n[loadFlow head]\n';
const lf = h.indexOf('async function loadFlow');
out += h.slice(lf, lf + 700) + '\n';
fs.writeFileSync(path.join(__dirname, '_302-dump.txt'), out, 'utf8');
console.log('written ' + out.length);
