// _hdr-discover2.js — full cluster extent + all JS refs to its ids/handlers (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
let out = '';
// 1) full top bar region
const a = h.indexOf('<span class="tb-sp"></span>');
out += '=== cluster from tb-sp (800 chars past runBtn) ===\n';
out += h.slice(a, h.indexOf('Run automation') + 900) + '\n\n';
// 2) all refs
for (const needle of ["getElementById('runBtn')", "getElementById('runBtnLbl')", "getElementById('runBtnIcon')", "getElementById('stopBtn')", 'function runBtnClick', 'function stopRun', 'function refreshRunBtn', 'function checkUpdates', 'refreshRunBtn(']) {
  let p = -1, hits = [];
  while ((p = h.indexOf(needle, p + 1)) >= 0) hits.push(p);
  out += needle + ' -> ' + hits.length + ' hits\n';
}
// 3) sidebar Save flow region (insertion anchor for Load flow/Flows)
const sb = h.indexOf('>Save flow</button>');
const sb2 = h.lastIndexOf('\n', h.lastIndexOf('\n', sb) - 1);
out += '\n=== sidebar save flow region ===\n' + h.slice(sb - 400, sb + 120) + '\n';
// 4) log out stuck sessions (anchor for Updates)
const lo = h.indexOf('Log out stuck sessions');
out += '\n=== logout sweep region ===\n' + h.slice(lo - 350, lo + 150) + '\n';
fs.writeFileSync(path.join(__dirname, '_hdr-dump2.txt'), out, 'utf8');
console.log('written ' + out.length);
