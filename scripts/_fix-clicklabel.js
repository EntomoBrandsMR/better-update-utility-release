// _fix-clicklabel.js — the After-click "none" option still says "(default)", but new
// click steps now default to Wait-for-element. Relabel so the UI stops lying. The render
// fallback (s.after||(s.waitFor?'element':'none')) is deliberately UNCHANGED: existing
// saved click steps keep resolving to 'none', because retroactively flipping them would
// make every old flow wait for an afterSelector that was never set.
'use strict';
const fs = require('fs');
const path = require('path');
const hp = path.join(__dirname, '..', 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
const from = 'value="none">Nothing (default)</option>';
const to = 'value="none">Nothing</option>';
const i = h.indexOf(from);
if (i < 0) { console.log(h.includes(to) ? 'already done' : 'ANCHOR MISSING'); process.exit(h.includes(to) ? 0 : 1); }
if (h.indexOf(from, i + 1) >= 0) { console.log('NOT UNIQUE'); process.exit(1); }
fs.writeFileSync(hp, h.slice(0, i) + to + h.slice(i + from.length), 'utf8');
console.log('done');
