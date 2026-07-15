// _fix-flowsubs.js — BUG 3 (Save flow does nothing). Same root cause as the forceClosing
// close-crash: declared inside the single-instance `else` block, used from module scope.
// FLOW_SUBS is a const, so unlike a function declaration it gets NO Annex B hoisting —
// ipcMain.handle('save-flow') threw "FLOW_SUBS is not defined" at line 1344, the invoke
// rejected, and the renderer's await died before the save dialog ever opened. The button
// looked inert. Fix: FLOW_SUBS lives at module scope (its only consumers are the
// module-scope save-flow / list-flows handlers and ensureFlowSubdirs, which closes over
// it either way).
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
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (m.includes("// R9/v3.0.1: MODULE scope on purpose")) { console.log('already done'); process.exit(0); }

// 1) remove the in-block declaration (keep the comment block with the functions)
m = rep(m, "const FLOW_SUBS = ['automation', 'once', 'general'];\nfunction ensureFlowSubdirs(dir) {",
  "// (FLOW_SUBS moved to module scope — see the declaration near mainWindow. It is read by\n// the module-scope save-flow / list-flows handlers, which a block-scoped const broke.)\nfunction ensureFlowSubdirs(dir) {", 'remove in-block');

// 2) add at module scope, beside the R10 close-prompt state fixed for the same reason
m = rep(m, 'let flowDirtyMain = false;\nlet forceClosing = false;', [
  'let flowDirtyMain = false;',
  'let forceClosing = false;',
  '// R9/v3.0.1: MODULE scope on purpose. Same bug as forceClosing above — this was declared',
  "// inside the single-instance `else` block, and a const gets no Annex B hoisting, so the",
  '// module-scope save-flow handler threw "FLOW_SUBS is not defined" and Save flow silently',
  '// did nothing (the dialog never opened). Never move these back inside a block.',
  "const FLOW_SUBS = ['automation', 'once', 'general'];"
].join('\n'), 'add module scope');
fs.writeFileSync(mp, m, 'utf8');
console.log('done');
