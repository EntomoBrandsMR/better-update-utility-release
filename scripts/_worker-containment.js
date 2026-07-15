// _worker-containment.js — READ-ONLY. Did the pool actually exceed the manual target, or
// does the grid just never drop dead workers? Two different bugs; find out which.
'use strict';
const fs = require('fs');
const path = require('path');
const c = fs.readFileSync(path.join(__dirname, '..', 'src', 'pool', 'coordinator.js'), 'utf8');
const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const lineOf = (s, i) => s.slice(0, i).split('\n').length;
let out = '';

out += '########## every coordSpawnWorker() CALL SITE ##########\n';
let p = -1;
while ((p = c.indexOf('coordSpawnWorker(', p + 1)) >= 0) {
  const ls = c.lastIndexOf('\n', p) + 1;
  out += 'coordinator L' + lineOf(c, p) + ': ' + c.slice(ls, c.indexOf('\n', p)).trim().slice(0, 130) + '\n';
}
p = -1;
while ((p = m.indexOf('coordSpawnWorker(', p + 1)) >= 0) {
  const ls = m.lastIndexOf('\n', p) + 1;
  out += 'main L' + lineOf(m, p) + ': ' + m.slice(ls, m.indexOf('\n', p)).trim().slice(0, 130) + '\n';
}

out += '\n########## coordScaleTo ##########\n';
const k = c.indexOf('async function coordScaleTo');
out += (k >= 0 ? c.slice(k, k + 1200) : '(not found)') + '\n';

out += '\n########## does COORD.workers ever get DELETED on exit? ##########\n';
p = -1;
while ((p = c.indexOf('COORD.workers.delete', p + 1)) >= 0) {
  const ls = c.lastIndexOf('\n', p) + 1;
  out += 'coordinator L' + lineOf(c, p) + ': ' + c.slice(ls, c.indexOf('\n', p)).trim().slice(0, 140) + '\n';
}
if (!c.includes('COORD.workers.delete')) out += '*** COORD.workers IS NEVER DELETED FROM — the grid would grow forever ***\n';

out += '\n########## the child close handler (crash trace pointed at ~323) ##########\n';
const cc = c.indexOf("child.on('close'");
out += (cc >= 0 ? c.slice(Math.max(0, cc - 200), cc + 1100) : '(not found)') + '\n';

out += '\n########## poolSetScaling: does moving the slider update manualTarget live? ##########\n';
const psk = m.indexOf("'pool-set-scaling'");
out += (psk >= 0 ? m.slice(Math.max(0, psk - 60), psk + 800) : '(not found)') + '\n';
fs.writeFileSync(path.join(__dirname, '_containment-dump.txt'), out, 'utf8');
console.log('written ' + out.length);
