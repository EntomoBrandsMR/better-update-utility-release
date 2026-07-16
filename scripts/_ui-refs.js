// _ui-refs.js — exact remaining references to the removed ids, with true indentation.
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const L = h.split(/\r?\n/);
for (let i = 0; i < L.length; i++) {
  if (/poolWorkerCount|poolScaleMult|poolWorkersVal|poolLicIntervalVal/.test(L[i])) {
    console.log((i + 1) + ': [' + L[i] + ']');
  }
}
