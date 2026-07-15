// _bugs2-discover.js — verify the staged fixes + hunt the Save flow bug (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const m = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
let out = '';

// ── A) main.js positional __inj array: does slot 5 = reauth? ──
out += '########## A. __inj array ##########\n';
{
  const k = m.indexOf('__inj');
  const region = m.slice(Math.max(0, k - 200), k + 1600);
  out += region + '\n';
}

// ── B) click step "after" field: options + fallback ──
out += '\n########## B. click after field ##########\n';
{
  let p = -1, c = 0;
  while ((p = h.indexOf("'after'", p + 1)) >= 0 && c < 8) {
    const ls = h.lastIndexOf('\n', p) + 1, le = h.indexOf('\n', p);
    out += h.slice(ls, le < 0 ? p + 200 : le).trim().slice(0, 220) + '\n---\n';
    c++;
  }
  const q = h.indexOf('s.after');
  if (q >= 0) { out += '\n[s.after context]\n' + h.slice(Math.max(0, q - 400), q + 500) + '\n'; }
}

// ── C) saveFlow: full body + every call site + the IPC it uses ──
out += '\n########## C. saveFlow ##########\n';
{
  const k = h.indexOf('async function saveFlow');
  out += h.slice(k, k + 2600) + '\n';
  out += '\n[save-flow IPC in main.js]\n';
  let p = -1;
  while ((p = m.indexOf('save-flow', p + 1)) >= 0) {
    const line = m.slice(0, p).split('\n').length;
    const ls = m.lastIndexOf('\n', p) + 1, le = m.indexOf('\n', p);
    out += 'main.js:' + line + ': ' + m.slice(ls, le).trim().slice(0, 160) + '\n';
  }
  out += '\n[preload saveFlow]\n';
  const pl = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
  let q = -1;
  while ((q = pl.indexOf('aveFlow', q + 1)) >= 0) {
    const ls = pl.lastIndexOf('\n', q) + 1, le = pl.indexOf('\n', q);
    out += pl.slice(ls, le).trim().slice(0, 160) + '\n';
  }
}
fs.writeFileSync(path.join(__dirname, '_bugs2-dump.txt'), out, 'utf8');
console.log('written ' + out.length);
