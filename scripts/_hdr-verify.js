// _hdr-verify.js — precise leftover audit with line context (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
for (const n of ["'runBtn'", '"runBtn"', "'runBtnLbl'", "'stopBtn'", '"stopBtn"', 'runBtnClick', 'refreshRunBtn', 'forceStopBtn', 'stopRun(', 'forceStopNow']) {
  let p = -1;
  while ((p = h.indexOf(n, p + 1)) >= 0) {
    const ls = h.lastIndexOf('\n', p) + 1;
    const le = h.indexOf('\n', p);
    console.log(n + ' -> ' + h.slice(ls, le < 0 ? p + 100 : le).trim().slice(0, 130));
  }
}
console.log('scan complete');
