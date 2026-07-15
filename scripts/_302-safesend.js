// _302-safesend.js — "TypeError: Object has been destroyed" on close.
// Every send site guarded with `if (ctx.mainWindow)`, which is a TRUTHINESS check — but a
// destroyed BrowserWindow is still a perfectly truthy object. mainWindow is never nulled,
// so on app close the guards all pass and .webContents.send() throws. Any worker exiting
// after the window closed (i.e. always, since closing kills the workers) crashed the main
// process. Route every send through one helper that asks isDestroyed() — the only thing
// that actually answers the question — and swallows the race.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (c.includes('function _send(')) { console.log('already done'); process.exit(0); }

const anchor = 'let _emitTimer = null;';
const i = c.indexOf(anchor);
if (i < 0) throw new Error('anchor missing');
const helper = [
  '// v3.0.2: the ONLY safe way to talk to the renderer. `if (ctx.mainWindow)` was never a',
  '// real guard — a destroyed BrowserWindow stays truthy, so every send site threw',
  '// "Object has been destroyed" once the window went away while workers were still',
  '// exiting. isDestroyed() is the real check; the try/catch covers the teardown race',
  '// where the window dies between the check and the send.',
  'function _send(channel, payload) {',
  '  const w = ctx.mainWindow;',
  '  if (!w || (typeof w.isDestroyed === \'function\' && w.isDestroyed())) return false;',
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
c = c.slice(0, i) + helper + c.slice(i + anchor.length);

// route every send through it
const before = (c.match(/ctx\.mainWindow\.webContents\.send\(/g) || []).length;
c = c.replace(/ctx\.mainWindow\.webContents\.send\(/g, '_send(');
const after = (c.match(/ctx\.mainWindow\.webContents\.send\(/g) || []).length;
console.log('rewrote ' + before + ' send site(s); remaining raw sends: ' + after);
if (after !== 0) throw new Error('raw sends remain');
fs.writeFileSync(cp, c, 'utf8');
console.log('done');
