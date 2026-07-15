// _302-ctxmenu.js — right-click never worked because Electron ships NO default context
// menu and nothing here ever built one (Menu was not even imported). Adds a real
// Cut/Copy/Paste/Select-all menu driven by Chromium's own editFlags, so entries are
// enabled exactly when the action is actually possible.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function rep(s, from, to, label) {
  const i = s.indexOf(from);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(from, i + 1) >= 0) throw new Error('anchor NOT UNIQUE: ' + label);
  return s.slice(0, i) + to + s.slice(i + from.length);
}
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (m.includes("'context-menu'")) { console.log('already done'); process.exit(0); }

// 1) import Menu
m = rep(m, "const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');",
  "const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu } = require('electron');", 'import');

// 2) attach the handler right after the window loads its page
m = rep(m, "  mainWindow.loadFile(path.join(__dirname, 'index.html'));", [
  "  mainWindow.loadFile(path.join(__dirname, 'index.html'));",
  '  // v3.0.2: right-click menu. Electron ships NO default context menu — without this,',
  '  // right-click does nothing anywhere in the app (which is exactly what it did).',
  "  // editFlags come from Chromium, so each item is enabled only when it's genuinely",
  '  // available (canPaste is false when the clipboard has nothing pasteable, etc.).',
  "  mainWindow.webContents.on('context-menu', (_e, params) => {",
  '    const ef = params.editFlags || {};',
  "    const selected = (params.selectionText || '').trim().length > 0;",
  '    if (!params.isEditable && !selected) return; // nothing sensible to offer',
  '    const template = [',
  "      { role: 'cut', enabled: !!ef.canCut },",
  "      { role: 'copy', enabled: !!ef.canCopy },",
  "      { role: 'paste', enabled: !!(params.isEditable && ef.canPaste) },",
  "      { type: 'separator' },",
  "      { role: 'selectAll', enabled: !!ef.canSelectAll },",
  '    ];',
  '    try { Menu.buildFromTemplate(template).popup({ window: mainWindow }); } catch (e) {}',
  '  });'
].join('\n'), 'handler');
fs.writeFileSync(mp, m, 'utf8');
console.log('done');
