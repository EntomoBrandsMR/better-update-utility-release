// _fix-eol.js — I injected LF lines into CRLF files with fs.writeFileSync, leaving
// main.js / coordinator.js / index.html with MIXED line endings. That broke my own
// anchors twice tonight — the exact trap the conventions warn about.
// git core.autocrlf means the repo stores LF and a fresh checkout produces CRLF, so
// normalising the working tree to CRLF makes it match what a clean clone would give and
// should produce ZERO real diff. Idempotent: \r?\n -> \r\n.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = [
  'src/main.js', 'src/preload.js', 'src/index.html', 'src/journal.js', 'src/scheduler.js',
  'src/pool/coordinator.js', 'src/pool/worker.js',
  'src/engine/login.js', 'src/engine/locate.js', 'src/engine/steps.js',
];
let changed = 0;
for (const f of files) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { console.log('  (absent) ' + f); continue; }
  const before = fs.readFileSync(p, 'utf8');
  const crlfBefore = (before.match(/\r\n/g) || []).length;
  const lfBefore = (before.match(/(?<!\r)\n/g) || []).length;
  const after = before.replace(/\r?\n/g, '\r\n');
  if (after === before) { console.log('  OK       ' + f.padEnd(28) + ' already all CRLF (' + crlfBefore + ')'); continue; }
  fs.writeFileSync(p, after, 'utf8');
  const crlfAfter = (after.match(/\r\n/g) || []).length;
  console.log('  FIXED    ' + f.padEnd(28) + ' was CRLF ' + crlfBefore + ' / LF ' + lfBefore + '  -> CRLF ' + crlfAfter);
  changed++;
}
console.log('\n' + changed + ' file(s) normalised to CRLF');
