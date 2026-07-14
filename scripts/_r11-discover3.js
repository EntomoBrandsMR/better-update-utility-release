// _r11-discover3.js — exact cut boundaries (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const L = h.split(/\r?\n/);
let out = '';
function dump(label, a, b) { out += '=== ' + label + ' (' + a + '-' + b + ') ===\n'; for (let i = a - 1; i < b; i++) out += (i + 1) + ': ' + L[i] + '\n'; out += '\n'; }
dump('legacy start fn 1 region', 2090, 2145);
dump('legacy start fn 2 region', 2195, 2240);
dump('requestStop region', 2270, 2330);
dump('pool stats block', 2995, 3045);
dump('handleRunEvent tail', 2440, 2480);
fs.writeFileSync(path.join(__dirname, '_r11-dump3.txt'), out, 'utf8');
console.log('written', out.length);
