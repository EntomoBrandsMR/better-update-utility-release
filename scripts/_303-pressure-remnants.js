// _303-pressure-remnants.js — delete the dead pressure state. The scaler measures
// rows/min now; these fields fed the median-latency ratio that (a) used a baseline
// captured at 1 worker on unrelated accounts, (b) tripped at 1.4 when measured noise
// reaches 1.46, and (c) compounded 0.8x down to 1 worker. Leaving them would invite
// someone to wire them back up.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = path.join(__dirname, '..', 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
const edits = [
  ['  _durBaseline: [],      // first 50 OK-row durations (median = baseline)\n',
   '  // v3.0.3: _durBaseline/_durRolling/_pressureHigh DELETED. Scaling measures rows/min\n' +
   '  // (COORD._rowTimes / COORD._tp), never row latency. See TODO.md 3.0.3 for the data.\n'],
  ['  _durRolling: [],       // last 30 OK-row durations (ring)\n', ''],
  ['  _pressureHigh: 0,      // consecutive high-pressure evaluations\n', ''],
  ['        COORD._durRolling.push(msg.durationMs);\n', ''],
  ['        if(COORD._durRolling.length > 30) COORD._durRolling.shift();\n', ''],
];
for (const [from, to] of edits) {
  const i = c.indexOf(from);
  if (i < 0) { console.log('  (already gone) ' + JSON.stringify(from.trim().slice(0, 45))); continue; }
  c = c.slice(0, i) + to + c.slice(i + from.length);
}
fs.writeFileSync(cp, c, 'utf8');
// any stragglers that would now throw at runtime?
const left = [];
for (const n of ['_durBaseline', '_durRolling', '_pressureHigh']) {
  let p = -1;
  while ((p = c.indexOf(n, p + 1)) >= 0) {
    const ls = c.lastIndexOf('\n', p) + 1;
    const line = c.slice(ls, c.indexOf('\n', p));
    if (!line.trim().startsWith('//')) left.push(c.slice(0, p).split('\n').length + ': ' + line.trim().slice(0, 90));
  }
}
console.log(left.length ? 'LIVE REFERENCES REMAIN:\n  ' + left.join('\n  ') : 'clean — no live references remain');
