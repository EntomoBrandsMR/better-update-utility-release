// _r16-discover.js — pool-submit-job / pool-start extraction anchors (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
let k = m.indexOf("ipcMain.handle('pool-submit-job'");
let seg = m.slice(k, k + 4500);
const rj = seg.indexOf('return { ok: true, jobId');
console.log('=== submit tail ===');
console.log(seg.slice(Math.max(0, rj - 120), rj + 260));
k = m.indexOf("ipcMain.handle('pool-start'");
seg = m.slice(k, k + 7000);
const rs = seg.lastIndexOf('return { ok: true };');
console.log('=== start tail ===');
console.log(seg.slice(Math.max(0, rs - 300), rs + 80));
console.log('=== profiles access (for schedule profileId -> creds path) ===');
const kp = m.indexOf("ipcMain.handle('pool-submit-job'");
// how does submit-job resolve profileId -> creds? show the body head
console.log(m.slice(kp, kp + 500));
