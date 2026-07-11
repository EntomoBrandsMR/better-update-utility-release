// _teardown-3b2-skip.js — skip status dies on the POOL path: statuses become ok|error.
// (Old single-runner skip refs are dead code handled by the remnant sweep, not here.)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function rep(s, from, to, label) {
  const i = s.indexOf(from);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(from, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  return s.slice(0, i) + to + s.slice(i + from.length);
}
function repAll(s, from, to, expect, label) {
  let n = 0;
  while (s.includes(from)) { s = s.replace(from, to); n++; if (n > 50) break; }
  if (n !== expect) throw new Error(label + ': expected ' + expect + ', got ' + n);
  return s;
}
function cutLine(s, needle, label) {
  const i = s.indexOf(needle);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(needle, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let le = s.indexOf('\n', i); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}
function cutAllLines(s, needle, expect, label) {
  let n = 0;
  while (true) {
    const i = s.indexOf(needle);
    if (i < 0) break;
    const ls = s.lastIndexOf('\n', i) + 1;
    let le = s.indexOf('\n', i); if (le < 0) le = s.length; else le++;
    s = s.slice(0, ls) + s.slice(le); n++;
  }
  if (n !== expect) throw new Error(label + ': expected ' + expect + ' lines, cut ' + n);
  return s;
}

// ── worker.js ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (w.includes("{status:'skip'")) {
  w = repAll(w, "return {status:'skip', error:'Skipped via Next-row", "return {status:'error', error:'Skipped via Next-row", 2, 'next-row status');
  w = rep(w, "status:'skip', error:'row index out of range'", "status:'error', error:'row index out of range'", 'out-of-range');
  w = w.replace("recorded as skip and the loop moves on", "recorded as an error (manual skip) and the loop moves on");
  w = w.replace("NEXT_ROW becomes a clean skip.", "NEXT_ROW records the row as a manual-skip error.");
  const wCode = w.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
  if (/'skip'/.test(wCode)) throw new Error('worker skip leftovers');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker cut');
} else console.log('worker already cut');

// ── coordinator.js ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (c.includes("msg.status==='skip'")) {
  c = rep(c, "w.done++; if(msg.status==='ok'||msg.status==='ok (retry)') w.ok++; else if(msg.status==='skip') w.skip++; else if(msg.status==='error') w.err++;",
           "w.done++; if(msg.status==='ok'||msg.status==='ok (retry)') w.ok++; else w.err++;", 'worker counters');
  c = rep(c, "if(job){ job.done++; if(msg.status==='ok'||msg.status==='ok (retry)') job.ok++; else if(msg.status==='skip') job.skip++; else if(msg.status==='error') job.err++; }",
           "if(job){ job.done++; if(msg.status==='ok'||msg.status==='ok (retry)') job.ok++; else job.err++; }", 'job counters');
  c = rep(c, ', skip: j.skip,', ',', 'job payload');
  c = rep(c, ', skip: w.skip,', ',', 'worker payload');
  c = rep(c, ', err:j.err, skip:j.skip }))', ', err:j.err }))', 'meta jobs skip');
  c = c.replace(/,\s*skip:\s*0/, '');
  const cCode = c.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
  if (/\bskip\b\s*[:+=]|'skip'/.test(cCode)) throw new Error('coordinator skip leftovers');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator cut');
} else console.log('coordinator already cut');

// ── main.js ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (m.includes("ipcMain.handle('pool-read-journal'")) {
  { // delete the dead pool-read-journal handler FIRST (its only caller died with the Run Log
    // tab, and it contains a skip-count literal that would confuse the repAll below)
    const start = m.indexOf("ipcMain.handle('pool-read-journal'");
    const ls = m.lastIndexOf('\n', start) + 1;
    const retIdx = m.indexOf('return { ok: true, poolId,', start);
    if (retIdx < 0) throw new Error('read-journal return missing');
    const close = m.indexOf('\n});', retIdx);
    if (close < 0) throw new Error('read-journal close missing');
    m = m.slice(0, ls) + m.slice(close + 4);
  }
  m = repAll(m, ', skip: 0,', ',', 2, 'job skip init');
  m = m.replace(/ job\.skip = 0;/, '');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main cut');
} else console.log('main already cut');

// ── index.html (pool path only; old-runner refs go with the remnant sweep) ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (h.includes('id="rs-skip"')) {
  h = cutLine(h, 'id="rs-skip"', 'skip stat div');
  h = rep(h, "<span style=\"color:var(--amber)\">'+(w.skip||0).toLocaleString()+' skip</span>", '', 'pool worker card span');
  h = rep(h, 'let distinctDone=0,doneTotal=0,ok=0,err=0,skip=0,total=0;', 'let distinctDone=0,doneTotal=0,ok=0,err=0,total=0;', 'pool agg decl');
  h = rep(h, ' skip+=j.skip;', '', 'pool agg add');
  // old-runner updateRunStats (dead code pending remnant sweep) writes rs-skip inline on a
  // single long line — neutralize FIRST (else the line-cutter below would eat the whole fn).
  h = rep(h, "document.getElementById('rs-skip').textContent=skip.toLocaleString();if(runTotal>0)", 'if(runTotal>0)', 'updateRunStats write');
  h = cutAllLines(h, "document.getElementById('rs-skip').textContent=skip.toLocaleString();", 2, 'skip display writers'); // pool renderer + dead old parallel-runner aggregate
  h = cutLine(h, '.s-skip {', 'skip css');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index cut');
} else console.log('index already cut');
