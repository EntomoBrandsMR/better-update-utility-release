// _hdr-discover3.js — handler refs + sidebar anchors (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
let out = '';
for (const needle of ['stopRun(', 'forceStopNow(', 'requestStop(', 'runBtnClick(', 'saveFlow()', 'loadFlow()', 'openFlowsFolder()', 'checkUpdates(']) {
  let p = -1; const hits = [];
  while ((p = h.indexOf(needle, p + 1)) >= 0) {
    const ls = h.lastIndexOf('\n', p) + 1;
    hits.push(h.slice(ls, Math.min(ls + 120, h.indexOf('\n', p) < 0 ? p + 120 : h.indexOf('\n', p))).trim());
  }
  out += '### ' + needle + ' (' + hits.length + ')\n' + hits.map(x => '  ' + x).join('\n') + '\n';
}
// sidebar FLOW section markup
const k = h.indexOf('class="sb-sec">Flow<');
const k2 = k >= 0 ? k : h.indexOf('>Flow</div>');
out += '\n=== sidebar FLOW section ===\n' + (k2 >= 0 ? h.slice(k2 - 100, k2 + 800) : '(anchor not found — searching Building)') + '\n';
if (k2 < 0) { const b = h.indexOf('Building'); out += h.slice(b - 300, b + 700) + '\n'; }
fs.writeFileSync(path.join(__dirname, '_hdr-dump3.txt'), out, 'utf8');
console.log('written ' + out.length);
