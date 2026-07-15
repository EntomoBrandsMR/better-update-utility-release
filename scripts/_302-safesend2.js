// _302-safesend2.js — same destroyed-window bug in main.js (7 sites).
// scheduler.js:129 already wraps its send in try/catch, so it degrades quietly — leaving
// that one alone. main.js:1669 is likewise wrapped. The rest either use the same bogus
// `if (mainWindow)` truthiness guard or have no guard at all (the checkForUpdates status
// sends, including the one inside the catch block — which would throw out of a catch).
'use strict';
const fs = require('fs');
const path = require('path');
const mp = path.join(__dirname, '..', 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (m.includes('function _send(')) { console.log('already done'); process.exit(0); }

const anchor = 'let flowDirtyMain = false;';
const i = m.indexOf(anchor);
if (i < 0) throw new Error('anchor missing');
const helper = [
  '// v3.0.2: see coordinator.js — `if (mainWindow)` is not a guard, because a destroyed',
  '// BrowserWindow stays truthy. Anything that fires during/after shutdown (worker exits,',
  '// in-flight update fetches) crashed the main process with "Object has been destroyed".',
  'function _send(channel, payload) {',
  "  const w = mainWindow;",
  "  if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed())) return false;",
  '  try {',
  '    const wc = w.webContents;',
  '    if (!wc || wc.isDestroyed()) return false;',
  '    wc.send(channel, payload);',
  '    return true;',
  '  } catch (e) { return false; }',
  '}',
  '',
  anchor,
].join('\n');
m = m.slice(0, i) + helper + m.slice(i + anchor.length);

const before = (m.match(/mainWindow\.webContents\.send\(/g) || []).length;
m = m.replace(/mainWindow\.webContents\.send\(/g, '_send(');
const after = (m.match(/mainWindow\.webContents\.send\(/g) || []).length;
console.log('rewrote ' + before + ' site(s); remaining raw: ' + after);
if (after !== 0) throw new Error('raw sends remain');
fs.writeFileSync(mp, m, 'utf8');
console.log('done');
