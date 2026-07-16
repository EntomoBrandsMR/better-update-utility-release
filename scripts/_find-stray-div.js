// _find-stray-div.js — locate the extra </div>.
// The live DOM (CDP) shows panel-run/profiles/schedules as children of .shell, but the
// SOURCE has them inside .content. Only one thing does that: malformed HTML. The browser
// hits a surplus </div>, closes .content early, and reparents everything after it.
// The "-1 div balance baseline" I have been treating as normal all session IS that surplus.
// Walk the source from .content's opening tag and report exactly where depth goes negative.
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const start = h.indexOf('<div class="content" id="mainContent">');
if (start < 0) throw new Error('content open not found');
const lineOf = (i) => h.slice(0, i).split(/\r?\n/).length;

const rx = /<div\b|<\/div>/g;
rx.lastIndex = start;
let depth = 0, m, first = null;
const marks = [];
while ((m = rx.exec(h))) {
  const tag = m[0];
  const before = depth;
  depth += (tag === '</div>') ? -1 : 1;
  // note where each panel sits, at what depth
  const seg = h.slice(m.index, m.index + 90);
  const pid = seg.match(/id="(panel-[^"]+)"/);
  if (pid) marks.push('    depth ' + depth + '  L' + lineOf(m.index) + '  ' + pid[1] + (depth === 1 ? '   <- inside .content (correct)' : '   <- WRONG depth'));
  if (depth < 0 && !first) {
    first = m.index;
    const ls = h.lastIndexOf('\n', m.index) + 1;
    const le = h.indexOf('\n', m.index);
    console.log('*** SURPLUS </div> at line ' + lineOf(m.index) + ' — this closes .content early ***');
    console.log('    [' + h.slice(ls, le < 0 ? m.index + 60 : le) + ']');
    console.log('\n    context:');
    for (let n = lineOf(m.index) - 4; n <= lineOf(m.index) + 2; n++) {
      const L = h.split(/\r?\n/)[n - 1];
      if (L !== undefined) console.log('    ' + (n === lineOf(m.index) ? '>>' : '  ') + ' ' + n + ': ' + L.slice(0, 110));
    }
    break;
  }
}
console.log('\n=== panel depths (1 = correct, inside .content) ===');
console.log(marks.join('\n'));
if (!first) console.log('\nno surplus </div> found before the panels');
