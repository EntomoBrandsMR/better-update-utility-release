// _dangling-audit.js — find functions that are CALLED (from onclick= or from inside the
// inline script) but never DEFINED. This is the class of bug that left runBtnClick wired
// to a deleted function; hunting the rest of the family. (read-only)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const h = fs.readFileSync(path.join(root, 'src', 'index.html, ').trim().replace(/,$/, '') || path.join(root, 'src', 'index.html'), 'utf8');

// isolate the inline script block(s)
let js = '';
const rx = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m;
while ((m = rx.exec(h))) js += m[1] + '\n';

// defined names
const defined = new Set();
for (const r of [/function\s+([A-Za-z_$][\w$]*)\s*\(/g, /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g]) {
  let x; while ((x = r.exec(js))) defined.add(x[1]);
}
// window.foo = ...
let x; const wr = /window\.([A-Za-z_$][\w$]*)\s*=/g;
while ((x = wr.exec(js))) defined.add(x[1]);

const builtins = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'do', 'else', 'try', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Set', 'Map', 'Promise', 'RegExp', 'Error', 'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'require', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'fetch', 'console', 'document', 'window', 'Intl', 'Symbol']);

// 1) onclick / onchange / oninput handlers in HTML
const missingHandlers = new Map();
const hr = /\bon(?:click|change|input|submit|keyup|keydown)\s*=\s*"([^"]*)"/g;
while ((x = hr.exec(h))) {
  const body = x[1];
  let c; const cr = /([A-Za-z_$][\w$]*)\s*\(/g;
  while ((c = cr.exec(body))) {
    const n = c[1];
    if (builtins.has(n) || defined.has(n)) continue;
    if (!missingHandlers.has(n)) missingHandlers.set(n, body.slice(0, 70));
  }
}
console.log('=== HTML handlers calling UNDEFINED functions ===');
if (!missingHandlers.size) console.log('(none)');
for (const [n, ctx] of missingHandlers) console.log('  ' + n + '()   <- ' + ctx);

// 2) calls from inside the script to undefined names
const stripped = js.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
const missingCalls = new Set();
const cr2 = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
while ((x = cr2.exec(stripped))) {
  const n = x[1];
  if (builtins.has(n) || defined.has(n)) continue;
  missingCalls.add(n);
}
console.log('\n=== script calls to names with no local definition (API.* excluded) ===');
console.log([...missingCalls].sort().join(', ') || '(none)');
