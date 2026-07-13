// _r3-discover2.js — find the blanket journaling dialog listener in the worker.
'use strict';
const fs = require('fs');
const path = require('path');
const w = fs.readFileSync(path.join(__dirname, '..', 'src', 'pool', 'worker.js'), 'utf8');
const L = w.split(/\r?\n/);
for (let i = 0; i < L.length; i++) {
  if (/page\.on\('dialog'|dialogType|__dialogs/.test(L[i])) console.log((i + 1) + ': ' + L[i].trim().slice(0, 130));
}
