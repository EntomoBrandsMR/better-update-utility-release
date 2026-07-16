// _check-sigs.js — do the pool handlers receive the new knobs? (read-only)
'use strict';
const fs = require('fs');
const path = require('path');
const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
for (const h of ['pool-start', 'pool-resume']) {
  const needle = "ipcMain.handle('" + h + "'";
  const i = m.indexOf(needle);
  if (i < 0) { console.log(h + ': handler not found'); continue; }
  const seg = m.slice(i, i + 500);
  const end = seg.indexOf('=> {');
  console.log('--- ' + h + ' ---');
  console.log(seg.slice(0, end > 0 ? end : 300).replace(/\s+/g, ' ').trim());
  for (const k of ['startWorkers', 'maxWorkers', 'hwSlider', 'ppSlider', 'elastic']) {
    const got = seg.slice(0, end > 0 ? end : 300).includes(k);
    console.log('   ' + (got ? 'OK  ' : 'MISSING  ') + k);
  }
  console.log('');
}
