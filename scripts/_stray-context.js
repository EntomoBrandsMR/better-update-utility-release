// _stray-context.js — the exact lines where .content gets closed early.
'use strict';
const fs = require('fs');
const path = require('path');
const L = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8').split(/\r?\n/);
let out = '';
for (let n = 958; n <= 980; n++) out += String(n).padStart(5) + ': ' + (L[n - 1] || '') + '\n';
fs.writeFileSync(path.join(__dirname, '_stray-context.txt'), out, 'utf8');
console.log(out);
