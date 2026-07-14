// _r7-discover.js — type case + type editor (read-only; PowerShell mangles inline quotes).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const s = fs.readFileSync(path.join(root, 'src', 'engine', 'steps.js'), 'utf8');
let i = s.indexOf("case 'type'");
console.log('=== engine type case ===');
console.log(s.slice(i, i + 520));
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
i = h.indexOf("if(s.type==='type') return");
console.log('=== type editor ===');
console.log(h.slice(i, i + 750));
