// _throughput-math.js — READ-ONLY. Answer the scaling-threshold question with Matthew's
// REAL run data instead of my opinion.
// Journal has no worker id (the bug), but worker LOG files do: each log's CreationTime =
// spawn, LastWriteTime = death. Overlay that against journal row timestamps to
// reconstruct live-worker-count vs throughput per minute — i.e. did adding workers
// actually produce more rows?
'use strict';
const fs = require('fs');
const path = require('path');

// ── rows from the newest journal ──
const ud = path.join(process.env.APPDATA, 'buu-2');
const jf = fs.readdirSync(ud).filter(f => /^pool-journal-pool.*\.jsonl$/.test(f))
  .map(f => ({ f, p: path.join(ud, f), m: fs.statSync(path.join(ud, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];
const rows = [];
for (const L of fs.readFileSync(jf.p, 'utf8').split(/\r?\n/)) {
  if (!L.trim()) continue;
  try { const o = JSON.parse(L); if (o.s === 'ok' && o.ms && o.ts) rows.push({ t: Date.parse(o.ts), ms: o.ms }); } catch (e) {}
}
rows.sort((a, b) => a.t - b.t);
console.log('journal: ' + jf.f);
console.log('OK rows with durations: ' + rows.length);
if (!rows.length) process.exit(0);

const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const all = rows.map(r => r.ms);
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
console.log('\n=== ROW DURATION DISTRIBUTION (ms) ===');
console.log('  min ' + Math.min(...all) + '   p10 ' + pct(all, .10) + '   p25 ' + pct(all, .25) + '   MEDIAN ' + med(all) +
            '   p75 ' + pct(all, .75) + '   p90 ' + pct(all, .90) + '   p99 ' + pct(all, .99) + '   max ' + Math.max(...all));

// ── worker lifespans ──
const ld = 'C:\\BUU\\logs';
const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
const lives = [];
if (fs.existsSync(ld)) {
  for (const f of fs.readdirSync(ld).filter(x => /^buu2-worker-.*\.log$/.test(x))) {
    const st = fs.statSync(path.join(ld, f));
    if (st.mtimeMs < t0 - 60000 || st.birthtimeMs > t1 + 60000) continue;
    lives.push({ a: st.birthtimeMs, b: st.mtimeMs });
  }
}
console.log('\nworker lifespans overlapping this run: ' + lives.length);

// ── per-minute: live workers vs rows completed ==
console.log('\n=== THROUGHPUT vs LIVE WORKERS (per minute) ===');
console.log('  time      live  rows/min  medRow(s)  rows/sec  per-worker rows/sec');
const buckets = new Map();
for (const r of rows) { const k = Math.floor(r.t / 60000); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(r.ms); }
const stat = [];
for (const k of [...buckets.keys()].sort()) {
  const ms = buckets.get(k);
  const mid = k * 60000 + 30000;
  const live = lives.filter(L => L.a <= mid && L.b >= mid).length;
  const mrow = med(ms) / 1000;
  const rps = ms.length / 60;
  stat.push({ k, live, n: ms.length, mrow, rps });
  console.log('  ' + new Date(k * 60000).toLocaleTimeString() + '   ' + String(live).padStart(3) +
              '   ' + String(ms.length).padStart(6) + '   ' + mrow.toFixed(1).padStart(7) +
              '   ' + rps.toFixed(2).padStart(6) + '   ' + (live ? (rps / live).toFixed(3) : '-').padStart(8));
}

// ── the money question: does throughput improve with more workers? ──
console.log('\n=== AGGREGATE BY LIVE WORKER COUNT ===');
console.log('  live  minutes  medRowDur(s)  avg rows/sec  per-worker rows/sec');
const byLive = new Map();
for (const s of stat) { if (!byLive.has(s.live)) byLive.set(s.live, []); byLive.get(s.live).push(s); }
for (const k of [...byLive.keys()].sort((a, b) => a - b)) {
  const g = byLive.get(k);
  const mr = med(g.map(x => x.mrow));
  const rp = g.reduce((a, x) => a + x.rps, 0) / g.length;
  console.log('  ' + String(k).padStart(4) + '  ' + String(g.length).padStart(7) + '  ' + mr.toFixed(1).padStart(12) +
              '  ' + rp.toFixed(2).padStart(12) + '  ' + (k ? (rp / k).toFixed(3) : '-').padStart(19));
}

// ── noise floor: how much does the median swing WITHOUT any worker change? ──
console.log('\n=== NOISE FLOOR (consecutive 30-row medians, stable periods) ===');
const win = [];
for (let i = 0; i + 30 <= rows.length; i += 30) win.push(med(rows.slice(i, i + 30).map(r => r.ms)));
const ratios = [];
for (let i = 1; i < win.length; i++) ratios.push(win[i] / win[i - 1]);
if (ratios.length) {
  console.log('  30-row median windows: ' + win.length);
  console.log('  window-to-window ratio: p50 ' + med(ratios).toFixed(2) + '  p90 ' + pct(ratios, .90).toFixed(2) +
              '  p95 ' + pct(ratios, .95).toFixed(2) + '  max ' + Math.max(...ratios).toFixed(2));
  console.log('  -> a threshold at or below the p95 ratio would fire on NOISE alone.');
}
