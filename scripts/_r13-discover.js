// _r13-discover.js — step card header markup + drag/drop init (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const k = h.indexOf("'<div class=\"step-hd\"");
console.log('=== card header build ===');
console.log(h.slice(k, k + 1500));
const d = h.indexOf('function initDragDrop');
console.log('=== initDragDrop ===');
console.log(d >= 0 ? h.slice(d, d + 1400) : '(not found)');
