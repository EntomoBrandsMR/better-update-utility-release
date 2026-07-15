// _hdr-ws2.js — exact code at the three sites that need to agree. (read-only)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const w = fs.readFileSync(path.join(root, 'src', 'pool', 'worker.js'), 'utf8');
let out = '';

out += '########## main.js openSpreadsheet (headers -> renderer) ##########\n';
let k = m.indexOf("ipcMain.handle('open-spreadsheet'");
if (k < 0) k = m.indexOf('open-spreadsheet');
out += m.slice(k, k + 1800) + '\n';

out += '\n########## main.js countRowsSync / header reads elsewhere ##########\n';
for (const n of ['headers', 'sheet_to_json']) {
  let p = -1, c = 0;
  while ((p = m.indexOf(n, p + 1)) >= 0 && c < 5) {
    const line = m.slice(0, p).split('\n').length;
    const ls = m.lastIndexOf('\n', p) + 1, le = m.indexOf('\n', p);
    out += 'main.js:' + line + ': ' + m.slice(ls, le).trim().slice(0, 150) + '\n';
    c++;
  }
}

out += '\n########## worker.js loadAllRows FULL ##########\n';
k = w.indexOf('function loadAllRows');
out += w.slice(k, k + 1100) + '\n';

out += '\n########## worker.js token resolver FULL ##########\n';
k = w.indexOf('.replace(/{{CRED:companyKey}}/g');
out += w.slice(Math.max(0, k - 700), k + 900) + '\n';

fs.writeFileSync(path.join(__dirname, '_hdr-ws2-dump.txt'), out, 'utf8');
console.log('written ' + out.length);
