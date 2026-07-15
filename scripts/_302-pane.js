// _302-pane.js — panel-run internals: find the flex wrapper / pausePane geometry.
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const a = h.indexOf('id="panel-run"');
const b = h.indexOf('id="panel-', a + 10);
const seg = h.slice(a, b);
console.log('panel-run block length: ' + seg.length + '\n');
// every element in panel-run that sets a flex/width/display style
for (const line of seg.split(/\r?\n/)) {
  const t = line.trim();
  if (/display\s*:\s*flex|flex\s*:\s*1|width\s*:|grid-template|position\s*:\s*(fixed|absolute)/.test(t)) {
    console.log('  ' + t.slice(0, 170));
  }
}
console.log('\n===== pausePane markup =====');
const p = seg.indexOf('pausePane');
console.log(seg.slice(Math.max(0, p - 500), p + 400));
console.log('\n===== .pausePane / #pausePane CSS =====');
const css = h.slice(h.indexOf('<style'), h.indexOf('</style>'));
for (const line of css.split(/\r?\n/)) {
  const t = line.trim();
  if (/pause|pane|stepPane/i.test(t)) console.log('  ' + t.slice(0, 170));
}
