// _303-fix-stray-div.js — THE RIGHT-SHIFT BUG. One surplus </div>.
// panel-builder was over-closed by one, which closed .content at L970 — 177 lines before
// the real </div><!-- /content --> at 1147. The browser reparented panel-run,
// panel-profiles and panel-schedules onto .shell (display:flex), so each rendered as a
// third flex COLUMN: the emptied .content kept flex:1 and ate the left half, shoving the
// panel right. That is exactly Matthew's screenshots. The CSS was innocent the whole time.
//
// This is the "div balance: -1" I reported as "baseline" in every validation this session.
// The bug printed itself on my screen for hours and I normalised it every time.
//
// Proven by _stray-solve.js: deleting 969 or 970 gives an IDENTICAL correct DOM (balance 0,
// .content closing at 1146, all five panels at depth 2 = inside .content). They are two
// consecutive </div>s, so removing either leaves the same structure. panel-builder opens at
// column 0, so 970 is its legitimate close and 969 is the surplus.
'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'index.html');
const src = fs.readFileSync(p, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';
const lines = src.split(/\r?\n/);

const TARGET = 969;
if (!/^\s*<\/div>\s*$/.test(lines[TARGET - 1])) throw new Error('L' + TARGET + ' is not a bare </div>: [' + lines[TARGET - 1] + ']');
if (!/panel-run/.test(lines[972] || '')) throw new Error('sanity: expected panel-run near L973, got [' + lines[972] + ']');

lines.splice(TARGET - 1, 1);
const out = lines.join(eol);
const bal = (out.match(/<div/g) || []).length - (out.match(/<\/div>/g) || []).length;
if (bal !== 0) throw new Error('refusing to write: balance would be ' + bal + ', must be 0');
fs.writeFileSync(p, out, 'utf8');
console.log('removed the surplus </div> at L' + TARGET);
console.log('div balance: ' + bal + '  (was -1 — the "baseline" that was actually the bug)');
