// _ui-discover.js — the worker-pool sidebar block, verbatim, so the rewrite anchors are real.
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const lineOf = (i) => h.slice(0, i).split(/\r?\n/).length;
const a = h.indexOf('id="poolWorkerCount"');
const b = h.indexOf('id="poolRunBtn"');
if (a < 0 || b < 0) { console.log('anchors missing: poolWorkerCount=' + a + ' poolRunBtn=' + b); process.exit(1); }
// widen to the enclosing section
const start = h.lastIndexOf('<div class="sb-sec"', a);
console.log('=== sidebar pool block: lines ' + lineOf(start) + ' - ' + lineOf(b) + ' ===\n');
console.log(h.slice(start, b + 120));
console.log('\n=== the live-scaling sender ===');
const k = h.indexOf('function poolScalingLive');
console.log(k >= 0 ? h.slice(k, k + 800) : '(not found)');
