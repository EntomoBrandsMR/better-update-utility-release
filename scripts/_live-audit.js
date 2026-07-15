// _live-audit.js — READ-ONLY. How many workers actually exist right now, and what is the
// coordinator's target? Reads the live pool journal + worker logs. Touches nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const ud = path.join(process.env.APPDATA, 'buu-2');

// newest pool journal
const js = fs.readdirSync(ud).filter(f => /^pool-journal-pool.*\.jsonl$/.test(f))
  .map(f => ({ f, p: path.join(ud, f), m: fs.statSync(path.join(ud, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
if (!js.length) { console.log('no pool journal'); process.exit(0); }
const jr = js[0];
console.log('journal: ' + jr.f);
console.log('last write: ' + new Date(jr.m).toLocaleTimeString());

const lines = fs.readFileSync(jr.p, 'utf8').split(/\r?\n/).filter(Boolean);
console.log('journal lines: ' + lines.length);
const workers = new Set();
let rows = 0, ok = 0, err = 0;
for (const L of lines) {
  try {
    const o = JSON.parse(L);
    if (o.w != null) workers.add(o.w);
    if (o.s) { rows++; if (o.s === 'ok') ok++; else if (o.s === 'error') err++; }
  } catch (e) {}
}
console.log('DISTINCT WORKER IDS IN JOURNAL: ' + workers.size + '  -> ' + [...workers].sort((a, b) => a - b).join(','));
console.log('row records: ' + rows + '  ok: ' + ok + '  err: ' + err);

// worker logs touched in the last 3 minutes = currently live
const ld = path.join(ud, 'logs');
const now = Date.now();
if (fs.existsSync(ld)) {
  const wl = fs.readdirSync(ld).filter(f => /^buu2-worker-w\d+\.log$/.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(ld, f)).mtimeMs }))
    .filter(x => now - x.m < 180000)
    .sort((a, b) => a.f.localeCompare(b.f));
  console.log('\nworker logs written in the last 3 min (i.e. LIVE): ' + wl.length);
  console.log('  ' + wl.map(x => x.f.replace('buu2-worker-w', 'w').replace('.log', '')).join(' '));
}
// pidfile: what does the coordinator think it owns?
const pf = path.join(ud, 'pool-workers.pid');
if (fs.existsSync(pf)) {
  const t = fs.readFileSync(pf, 'utf8').trim();
  console.log('\npidfile entries: ' + t.split(/\r?\n/).filter(Boolean).length);
}
