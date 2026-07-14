// _p4-r9b-devgate.js — R9 hotfix: dev mode shares userData with the INSTALLED app.
// The boot smoke just re-sorted Matthew's live flat flows into subfolders, which the
// installed 2.2.9 pickers can't see (restored by hand immediately). Folder migration
// and the save-dialog subfolder default are now PACKAGED-ONLY; the read paths already
// fall back to the flat root, so dev keeps working flat until R8+ actually ships.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function rep(s, from, to, label) {
  const i = s.indexOf(from);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(from, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  return s.slice(0, i) + to + s.slice(i + from.length);
}
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('never re-sort its live flat flows')) {
  m = repRx(m, /function migrateFlowsIntoFolders\(\) \{\r?\n  try \{\r?\n    const dir = getFlowsDir\(\);/,
    'function migrateFlowsIntoFolders() {\n  try {\n    // PACKAGED ONLY: dev shares userData with the installed app — never re-sort its live flat flows.\n    if (!app.isPackaged) return;\n    const dir = getFlowsDir();', 'gate');
  m = rep(m, "    defaultPath: path.join(getFlowsDir(), _sub, defaultName),",
    "    defaultPath: path.join(getFlowsDir(), app.isPackaged ? _sub : '', defaultName), // dev saves flat (shared with installed app)", 'save gate');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('gated');
} else console.log('already gated');
