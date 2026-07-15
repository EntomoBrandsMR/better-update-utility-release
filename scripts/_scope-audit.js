// _scope-audit.js — THE forceClosing BUG CLASS, hunted systematically.
// main.js has `if (!gotLock) { app.quit() } else { ...lots... }`. Anything declared with
// let/const INSIDE that else block is block-scoped and INVISIBLE to module-scope code
// (ipcMain handlers, createWindow's closures). forceClosing was one instance and it threw
// on every app close. This finds every other one. (read-only)
'use strict';
const fs = require('fs');
const path = require('path');
const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

const gl = m.indexOf('const gotLock = app.requestSingleInstanceLock();');
const ifPos = m.indexOf('if (!gotLock)', gl);
const elsePos = m.indexOf('else', ifPos);
const open = m.indexOf('{', elsePos);
let d = 0, j = open;
for (; j < m.length; j++) { if (m[j] === '{') d++; else if (m[j] === '}') { d--; if (!d) break; } }
const lineOf = (i) => m.slice(0, i).split('\n').length;
console.log('else block: lines ' + lineOf(open) + ' - ' + lineOf(j));

const inside = m.slice(open, j + 1);
const outside = m.slice(0, open) + m.slice(j + 1);

// declarations directly inside the else block
const decls = new Map();
for (const r of [/(?:^|\n)\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g, /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g]) {
  let x; while ((x = r.exec(inside))) decls.set(x[1], lineOf(open + x.index));
}
console.log('\ndeclared inside else block: ' + [...decls.keys()].join(', ') + '\n');

let bad = 0;
for (const [name, line] of decls) {
  // is it referenced anywhere OUTSIDE the else block?
  const rx = new RegExp('(?:^|[^.\\w$])' + name.replace(/\$/g, '\\$') + '\\b');
  if (rx.test(outside)) {
    // where?
    const hits = [];
    const g = new RegExp('(?:^|[^.\\w$])(' + name.replace(/\$/g, '\\$') + ')\\b', 'g');
    let x;
    while ((x = g.exec(outside)) && hits.length < 3) {
      const realIdx = x.index < open ? x.index : x.index + (j + 1 - open);
      hits.push(lineOf(realIdx));
    }
    console.log('!! ' + name + '  (declared inside else @line ' + line + ') referenced OUTSIDE at line(s): ' + hits.join(', '));
    bad++;
  }
}
console.log(bad ? '\n' + bad + ' scope leak(s) — each throws ReferenceError at runtime' : '\nno scope leaks');
