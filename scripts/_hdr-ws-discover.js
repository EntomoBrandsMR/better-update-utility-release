// _hdr-ws-discover.js — where do sheet headers become token keys? Renderer AND worker
// must agree or trimming one side creates mismatches. (read-only)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let out = '';
function scan(label, file, needles, before, after) {
  const s = fs.readFileSync(path.join(root, file), 'utf8');
  out += '\n########## ' + label + ' (' + file + ') ##########\n';
  for (const n of needles) {
    let p = -1, c = 0;
    while ((p = s.indexOf(n, p + 1)) >= 0 && c < 4) {
      const line = s.slice(0, p).split('\n').length;
      out += '--- ' + n + ' @line ' + line + ' ---\n';
      out += s.slice(Math.max(0, p - before), p + after) + '\n';
      c++;
    }
    if (!c) out += '(no hit: ' + n + ')\n';
  }
}
// renderer: header parse + chips + validation + R15 collector
scan('RENDERER header parse', 'src/index.html', ['ssHeaders =', 'ssHeaders='], 200, 400);
scan('RENDERER col validation', 'src/index.html', ['function checkFlowColumnsAgainstSheet'], 0, 700);
// worker: row load + token resolution
scan('WORKER rows', 'src/pool/worker.js', ['function loadAllRows', 'BUU_INLINE'], 0, 500);
// token substitution — find it wherever it lives
for (const f of ['src/main.js', 'src/pool/worker.js', 'src/engine/steps.js']) {
  try {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    let p = -1, c = 0;
    out += '\n########## TOKEN SUBSTITUTION in ' + f + ' ##########\n';
    while ((p = s.indexOf('{{', p + 1)) >= 0 && c < 6) {
      const line = s.slice(0, p).split('\n').length;
      const ls = s.lastIndexOf('\n', p) + 1, le = s.indexOf('\n', p);
      out += line + ': ' + s.slice(ls, le < 0 ? p + 120 : le).trim().slice(0, 170) + '\n';
      c++;
    }
  } catch (e) { out += '\n(' + f + ': ' + e.message + ')\n'; }
}
fs.writeFileSync(path.join(__dirname, '_hdr-ws-dump.txt'), out, 'utf8');
console.log('written ' + out.length);
