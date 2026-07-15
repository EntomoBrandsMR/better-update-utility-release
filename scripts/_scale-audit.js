// _scale-audit.js — what the pool controls ACTUALLY do vs what R4 specified. (read-only)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const c = fs.readFileSync(path.join(root, 'src', 'pool', 'coordinator.js'), 'utf8');
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
let out = '';

// ── 1) the sidebar controls, verbatim ──
out += '########## SIDEBAR POOL CONTROLS ##########\n';
for (const id of ['poolWorkerCount', 'poolScaleMult', 'poolLicBuffer', 'poolElastic', 'poolLicInterval', 'poolLicProfile', 'poolDiagCapture']) {
  let p = -1;
  while ((p = h.indexOf('id="' + id + '"', p + 1)) >= 0) {
    const ls = h.lastIndexOf('\n', p) + 1, le = h.indexOf('\n', p);
    out += id + ' -> ' + h.slice(ls, le < 0 ? p + 150 : le).trim().slice(0, 190) + '\n';
  }
  if (!h.includes('id="' + id + '"')) out += id + ' -> *** NOT PRESENT IN UI ***\n';
}

// ── 2) what does poolStart send? ──
out += '\n########## poolStart payload (renderer) ##########\n';
const ps = h.indexOf('await API.poolStart(');
out += h.slice(Math.max(0, ps - 900), ps + 500) + '\n';

// ── 3) licenseProfileId: where does it come from? ──
out += '\n########## licenseProfileId in renderer ##########\n';
let q = -1, n = 0;
while ((q = h.indexOf('licenseProfileId', q + 1)) >= 0 && n < 6) {
  const ls = h.lastIndexOf('\n', q) + 1;
  out += 'html: ' + h.slice(ls, h.indexOf('\n', q)).trim().slice(0, 160) + '\n'; n++;
}
if (!n) out += '*** licenseProfileId NEVER APPEARS IN THE RENDERER ***\n';

// ── 4) the actual scaling brain ──
out += '\n########## coordEvalScale ##########\n';
const k = c.indexOf('function coordEvalScale');
out += (k >= 0 ? c.slice(k, k + 2600) : '(not found)') + '\n';

// ── 5) hardware cap ──
out += '\n########## computeHardwareCap ##########\n';
const hc = m.indexOf('function computeHardwareCap');
out += (hc >= 0 ? m.slice(hc, hc + 700) : '(not in main.js)') + '\n';
fs.writeFileSync(path.join(__dirname, '_scale-dump.txt'), out, 'utf8');
console.log('written ' + out.length);
