// _r6-chipfind.js — locate the build-page chip strip generator.
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
let k = -1, n = 0;
while ((k = h.indexOf('chip', k + 1)) >= 0 && n < 200) {
  const seg = h.slice(Math.max(0, k - 60), k + 100);
  if (/chips|chip["'\s]/.test(seg) && /innerHTML|map\(|join\(|<span|class=/.test(seg)) {
    const ls = h.lastIndexOf('\n', k) + 1;
    const line = h.slice(ls, h.indexOf('\n', k));
    const lineNo = h.slice(0, k).split('\n').length;
    console.log(lineNo + ': ' + line.trim().slice(0, 170));
    n++;
    k = h.indexOf('\n', k); // one hit per line
  }
}
