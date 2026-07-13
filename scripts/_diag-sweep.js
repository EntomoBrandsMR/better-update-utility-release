// _diag-sweep.js — dry-run each sweep cut and report line deltas; writes nothing.
'use strict';
const fs = require('fs');
const path = require('path');
let h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const lc = s => s.split(/\r?\n/).length;
console.log('start:', lc(h));

let i = h.indexOf('<div class="setup-overlay" id="resumeOverlay">');
let ls = h.lastIndexOf('\n', i) + 1;
let k = h.indexOf('<!-- TOPBAR -->', i);
h = h.slice(0, ls) + h.slice(h.lastIndexOf('\n', k) + 1);
console.log('after overlay:', lc(h));

i = h.indexOf('// Resume-on-launch: scan for orphaned checkpoints');
ls = h.lastIndexOf('\n', i) + 1;
k = h.indexOf("catch(e) { console.error('Orphan checkpoint scan failed:', e); }", i);
let le = h.indexOf('\n', k); le = le < 0 ? h.length : le + 1;
console.log('scan cut: start line', lc(h.slice(0, ls)), 'end line', lc(h.slice(0, le)));
h = h.slice(0, ls) + h.slice(le);
console.log('after scan:', lc(h));

i = h.indexOf('function fmtRelativeTime(iso){');
k = h.indexOf('function handleRunEvent(evt){', i + 10);
console.log('fmt at line', lc(h.slice(0, i)), '| handleRunEvent at line', lc(h.slice(0, k)));

const mark = h.indexOf('v1.3.4 Phase 3');
const stop = h.indexOf('function poolToggleAutoScale(){', mark);
console.log('v1.3.4 banner at line', lc(h.slice(0, mark)), '| poolToggleAutoScale at line', lc(h.slice(0, stop)));
