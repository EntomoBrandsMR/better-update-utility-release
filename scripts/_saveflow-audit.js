// _saveflow-audit.js — does every element/global saveFlow touches actually exist?
// A single missing id makes .value throw and the whole save dies. (read-only)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const k = h.indexOf('async function saveFlow');
// brace-scan the function
const open = h.indexOf('{', k);
let d = 0, j = open;
for (; j < h.length; j++) { if (h[j] === '{') d++; else if (h[j] === '}') { d--; if (!d) break; } }
const fn = h.slice(k, j + 1);
console.log('=== saveFlow body length: ' + fn.length + ' ===');
console.log(fn.slice(1400));
console.log('\n=== element id audit ===');
const ids = [...new Set([...fn.matchAll(/getElementById\('([^']+)'\)/g)].map(x => x[1]))];
for (const id of ids) {
  const present = h.includes('id="' + id + '"') || h.includes("id='" + id + "'");
  const guarded = fn.includes("getElementById('" + id + "')||{}");
  console.log((present ? 'OK   ' : 'MISSING ') + id + (present ? '' : (guarded ? '  (guarded — safe)' : '  <<< THROWS')));
}
console.log('\n=== global audit ===');
for (const g of ['flowName', 'runMode', 'flowAutomation', 'setupFlowId', 'teardownFlowId', 'headless', 'ssHeaders', 'steps']) {
  const declared = new RegExp('(let|var|const)\\s+' + g + '\\b').test(h);
  console.log((declared ? 'OK   ' : 'UNDECLARED <<< ') + g);
}
