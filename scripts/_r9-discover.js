// _r9-discover.js — flow-type card + flow file handlers (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let out = '';
function seg(label, src, needle, before, after) {
  const i = src.indexOf(needle);
  out += '=== ' + label + ' (idx ' + i + ') ===\n';
  out += (i >= 0 ? src.slice(Math.max(0, i - before), i + after) : '(NOT FOUND)') + '\n\n';
}
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
seg('runMode UI (radios)', h, 'runMode', 300, 900);
seg('Flow type card html', h, 'Flow type', 200, 1200);
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
seg('save-flow handler full', m, "ipcMain.handle('save-flow'", 0, 1700);
seg('list-once-flows full', m, "ipcMain.handle('list-once-flows'", 0, 1300);
seg('read-flow-by-name (R5b)', m, "ipcMain.handle('read-flow-by-name'", 0, 700);
seg('migrateLegacyFlowsOnce', m, 'function migrateLegacyFlowsOnce', 0, 700);
fs.writeFileSync(path.join(__dirname, '_r9-dump.txt'), out, 'utf8');
console.log('written', out.length);
