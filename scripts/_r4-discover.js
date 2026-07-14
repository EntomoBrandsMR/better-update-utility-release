// _r4-discover.js — dump sidebar pool section + autoscale fn to a file (console truncates).
'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'index.html');
const s = fs.readFileSync(p, 'utf8');
const L = s.split(/\r?\n/);
let out = '=== sidebar 700-780 ===\n';
for (let i = 699; i < 780; i++) out += (i + 1) + ': ' + L[i] + '\n';
const k = s.indexOf('poolToggleAutoScale');
out += '\n=== poolToggleAutoScale region ===\n' + (k >= 0 ? s.slice(Math.max(0, k - 200), k + 800) : '(not found)');
const k2 = s.indexOf("id=\"poolWorkerCount\"");
out += '\n\n=== poolWorkerCount reads ===\n';
for (let i = 0; i < L.length; i++) if (/poolWorkerCount|poolAutoScale|poolLicBuffer|poolLicInterval|poolElastic/.test(L[i])) out += (i + 1) + ': ' + L[i].trim().slice(0, 160) + '\n';
fs.writeFileSync(path.join(__dirname, '_r4-dump.txt'), out, 'utf8');
console.log('written', out.length, 'chars');
