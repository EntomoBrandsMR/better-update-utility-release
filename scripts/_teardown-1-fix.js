// _teardown-1-fix.js — remove the second addLogTableEntry caller + stale textedit comment.
'use strict';
const fs = require('fs');
const path = require('path');
const hp = path.join(__dirname, '..', 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
let cut = 0;
while (true) {
  const i = h.indexOf('addLogTableEntry(');
  if (i < 0) break;
  const ls = h.lastIndexOf('\n', i) + 1;
  let le = h.indexOf('\n', i); if (le < 0) le = h.length; else le++;
  h = h.slice(0, ls) + h.slice(le);
  cut++;
}
h = h.replace(/^.*well-formed-token regex silently skips\. textedit.*\r?\n/m, '');
fs.writeFileSync(hp, h, 'utf8');
console.log('removed ' + cut + ' addLogTableEntry caller line(s) + stale comment');
