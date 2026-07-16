// _stray-solve.js — READ-ONLY. Which </div> is the surplus?
// panel-builder is over-closed by one, closing .content at L970. Candidates: 969 or 970.
// Delete the wrong one and panel-builder never closes and panel-run nests inside it —
// broken in a new way. So: simulate BOTH deletions in memory and check which produces a
// document where (a) div balance is 0 and (b) EVERY panel sits at depth 1 inside .content.
// Nothing is written.
'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'index.html');
const orig = fs.readFileSync(p, 'utf8');
const lines = orig.split(/\r?\n/);

function analyse(src, label) {
  const start = src.indexOf('<div class="content" id="mainContent">');
  const rx = /<div\b|<\/div>/g;
  rx.lastIndex = start;
  let depth = 0, m, minDepth = 99, closedAt = null;
  const panels = [];
  while ((m = rx.exec(src))) {
    if (m[0] === '</div>') depth--; else depth++;
    if (depth < minDepth) minDepth = depth;
    if (depth === 0 && closedAt === null) closedAt = src.slice(0, m.index).split(/\r?\n/).length;
    if (m[0] !== '</div>') {
      const seg = src.slice(m.index, m.index + 80);
      const id = seg.match(/id="(panel-[^"]+)"/);
      if (id) panels.push({ id: id[1], depth, line: src.slice(0, m.index).split(/\r?\n/).length });
    }
    if (depth === 0 && closedAt !== null && src.slice(m.index, m.index + 40).includes('/shell')) break;
  }
  const bal = (src.match(/<div/g) || []).length - (src.match(/<\/div>/g) || []).length;
  const good = panels.filter(x => x.depth === 1).length;
  console.log('--- ' + label + ' ---');
  console.log('   div balance: ' + bal + (bal === 0 ? '  OK' : '  <-- must be 0'));
  console.log('   .content first closes at line: ' + closedAt);
  console.log('   panels at depth 1 (correct): ' + good + ' / ' + panels.length);
  panels.forEach(x => console.log('      ' + (x.depth === 1 ? 'OK  ' : 'BAD ') + x.id + '  depth ' + x.depth + '  L' + x.line));
  return { bal, good, total: panels.length };
}

analyse(orig, 'CURRENT (broken)');
for (const cand of [969, 970]) {
  const copy = lines.slice();
  if (!/^\s*<\/div>\s*$/.test(copy[cand - 1])) { console.log('\nL' + cand + ' is not a bare </div>: [' + copy[cand - 1] + '] — skipping'); continue; }
  copy.splice(cand - 1, 1);
  console.log('');
  analyse(copy.join('\r\n'), 'DELETE line ' + cand + '  [' + lines[cand - 1].trim() + ']');
}
