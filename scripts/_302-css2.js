// _302-css2.js — FULL layout rules (previous pass only printed selector lines).
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const css = h.slice(h.indexOf('<style'), h.indexOf('</style>'));
const wanted = ['html, body', '.shell', '.sidebar', '.content', '.topbar', '.tb-sp', '.card', '.page-header'];
for (const sel of wanted) {
  const rx = new RegExp('(^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(rx);
  console.log('--- ' + sel + ' ---');
  console.log(m ? '  ' + m[2].trim().replace(/\s+/g, ' ').slice(0, 260) : '  (rule not found)');
}
// body-level children in document order
console.log('\n--- body-level structure ---');
const b = h.indexOf('<body');
const seg = h.slice(b, h.indexOf('<script', b));
let depth = 0;
for (const line of seg.split(/\r?\n/)) {
  const opens = (line.match(/<div\b/g) || []).length;
  const closes = (line.match(/<\/div>/g) || []).length;
  const idm = line.match(/<div[^>]*id="([^"]+)"/);
  const clsm = line.match(/<div[^>]*class="([^"]+)"/);
  if (depth === 0 && opens > 0) console.log('  BODY CHILD: ' + (idm ? '#' + idm[1] : '') + (clsm ? '.' + clsm[1].split(' ')[0] : '') + '   ' + line.trim().slice(0, 60));
  depth += opens - closes;
}
