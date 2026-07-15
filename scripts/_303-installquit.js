// _303-installquit.js — the update path could never complete.
// install-update does shell.openPath(installer) then app.quit() 2s later, but never sets
// forceClosing. app.quit() fires the R10 close gate, which preventDefault()s whenever the
// flow is dirty — so the app stayed open, the freshly-launched installer found BUU still
// running and bailed. On 3.0.1 boot marked the flow dirty before the user touched
// anything, so this fired EVERY time: the updater was unreachable by construction.
// 3.0.2 fixes boot-dirty, but real unsaved work would still block an update quit, so the
// gate itself has to know the difference between a user closing the app and an update
// restarting it. Also: ask about unsaved work BEFORE downloading 200MB, not after.
// (CRLF-tolerant anchors — src is CRLF; plain \n needles never match.)
'use strict';
const fs = require('fs');
const path = require('path');
const mp = path.join(__dirname, '..', 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
function repRx(rx, to, label) {
  const hits = m.match(new RegExp(rx.source, rx.flags.replace('g', '') + 'g'));
  if (!hits) throw new Error('anchor missing: ' + label);
  if (hits.length > 1) throw new Error('anchor NOT UNIQUE (' + hits.length + '): ' + label);
  m = m.replace(rx, to);
}
if (m.includes('// v3.0.3: an update quit is not a user close')) { console.log('already done'); process.exit(0); }

repRx(/(ipcMain\.handle\('install-update', async \(_, \{ downloadUrl \}\) => \{\r?\n)/, [
  '$1',
  '  // v3.0.3: an update quit is not a user close. Deal with unsaved work UP FRONT —',
  '  // before spending a 200MB download — then tell the close gate to stand down, or the',
  '  // installer launches, finds BUU still alive behind an unsaved-changes prompt, and',
  '  // quietly does nothing.',
  '  if (flowDirtyMain) {',
  '    const _r = await dialog.showMessageBox(mainWindow, {',
  "      type: 'warning', buttons: ['Save', \"Don't Save\", 'Cancel'], defaultId: 0, cancelId: 2,",
  "      title: 'Unsaved changes',",
  "      message: 'Save your flow before updating?',",
  "      detail: 'Installing the update restarts BUU. Unsaved changes to your flow would be lost.',",
  '    });',
  '    if (_r.response === 2) return { ok: false, cancelled: true };',
  '    if (_r.response === 0) {',
  "      _send('save-flow-then-close');",
  '      return { ok: false, savingFirst: true };',
  '    }',
  "    flowDirtyMain = false; // \"Don't Save\" — discard, and stop the gate re-asking at quit",
  '  }',
  ''
].join('\n'), 'preflight');

repRx(/(\r?\n)(\s*)shell\.openPath\(tmp\);(\r?\n\s*)setTimeout\(\(\) => app\.quit\(\), 2000\);/, [
  '$1$2// v3.0.3: forceClosing MUST be set before quitting, or the R10 close gate blocks',
  '$2// the update restart. This one missing line made the in-app updater unusable.',
  '$2forceClosing = true;',
  '$2shell.openPath(tmp);',
  '$2setTimeout(() => app.quit(), 2000);'
].join('\n'), 'forceClosing');
fs.writeFileSync(mp, m, 'utf8');
console.log('done');
