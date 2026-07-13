// _r3-discover.js — read the dialog machinery precisely (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const s = fs.readFileSync(path.join(root, 'src', 'engine', 'steps.js'), 'utf8');
const i = s.indexOf("case 'dialog'");
console.log('=== steps.js dialog case ===');
console.log(s.slice(Math.max(0, i - 300), i + 1100));
const w = fs.readFileSync(path.join(root, 'src', 'pool', 'worker.js'), 'utf8');
const k = w.indexOf("page.on('dialog'");
console.log('=== worker blanket listener ===');
console.log(w.slice(Math.max(0, k - 900), k + 1400));
