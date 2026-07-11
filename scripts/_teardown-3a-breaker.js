// _teardown-3a-breaker.js — remove the circuit breaker everywhere. Anchored; throws on miss.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}
function cutLine(s, needle, label) {
  const i = s.indexOf(needle);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(needle, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let le = s.indexOf('\n', i); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}
function cutAllLines(s, needle, label, expect) {
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
function cutUntilBefore(s, startNeedle, stopNeedle, label) {
  const i = s.indexOf(startNeedle);
  if (i < 0) throw new Error('start missing: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  const k = s.indexOf(stopNeedle, i + startNeedle.length);
  if (k < 0) throw new Error('stop missing: ' + label);
  return s.slice(0, ls) + s.slice(s.lastIndexOf('\n', k) + 1);
}

// ── worker.js ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('BREAKER_THRESHOLD')) { console.log('worker already cut'); } else {
w = repRx(w, /(\/\/ v2\.2\.2 Session 2E: per-job knobs\.) BREAKER_THRESHOLD=0 disables the circuit breaker\./, '$1', 'knob comment');
w = cutLine(w, 'const BREAKER_THRESHOLD = /*__BUU_CFG_5__*/null;', 'breaker const');
w = repRx(w, /  \/\/ v2\.2\.2 Session 2E: circuit-breaker counters \+ re-auth timer[\s\S]*?nextReauthAt=0 disables proactive re-auth\.\r?\n/,
  '  // v2.2.2 Session 2E: re-auth timer scoped to main(). nextReauthAt=0 disables proactive re-auth.\n', 'counter comment');
w = repRx(w, /  let consecutiveErrors = 0;\r?\n  let lastSuccessfulRow = 0;\r?\n/, '', 'counter lets');
w = repRx(w, /      \/\/ v2\.2\.2 Session 2E: circuit breaker bookkeeping\.[\s\S]*?_reclaimReason = 'breaker';[^\r\n]*\r?\n        break;\r?\n      \}\r?\n/, '', 'bookkeeping+trip');
w = w.replace(/\/\*__BUU_CFG_(\d+)__\*\//g, (m, n) => +n > 5 ? '/*__BUU_CFG_' + (+n - 1) + '__*/' : m);
// stale comment mentions of the breaker reclaim reason
w = repRx(w, /^.*'breaker'[^\n]*circuit breaker tripped[^\n]*\r?\n/m, '', 'reason comment');
w = w.replace(/, [XYZ] breaker/g, '');
const wCode = w.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
if (/BREAKER|consecutiveErrors|lastSuccessfulRow|circuit|breaker/i.test(wCode.replace(/'breaker':0,? ?/g, ''))) throw new Error('worker breaker leftovers');
fs.writeFileSync(wp, w, 'utf8');
}

// ── coordinator.js ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes("case 'circuit-breaker':")) { console.log('coordinator already cut'); } else {
c = cutUntilBefore(c, "case 'circuit-breaker':", "case 'logging-out':", 'breaker case');
c = repRx(c, /(\/\/ retryCount defaults to 2 \(prior hardcode\)); breakerThreshold 0 means disabled;/, '$1;', 'cfg comment');
c = cutLine(c, 'breakerThreshold: Number.isFinite(job.breakerThreshold) ? job.breakerThreshold : 0,', 'cfg field');
c = repRx(c, / \|\| msg\.reason === 'breaker'/, '', 'reclaim reason vocab');
c = repRx(c, /'drain' \| 'user-stop' \| 'breaker'/, "'drain' | 'user-stop'", 'reclaim reason comment');
const cCode = c.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
if (/breaker/i.test(cCode.replace(/'breaker':0,? ?/g, ''))) throw new Error('coordinator breaker leftovers');
fs.writeFileSync(cp, c, 'utf8');
console.log('worker + coordinator breaker cut');
}

// ── main.js ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('breakerThreshold')) { console.log('main already cut'); } else {
m = repRx(m, /(ipcMain\.handle\('pool-submit-job', async \(_, \{[^\n]*?), breakerThreshold(\b[^\n]*\n)/, '$1$2', 'submit destructure');
m = cutLine(m, '// breakerThreshold: stop the worker if this many consecutive rows fail. 0 = disabled.', 'submit comment');
m = cutLine(m, 'const _bt = parseInt(breakerThreshold);', 'bt parse');
m = cutLine(m, 'breakerThreshold: Number.isFinite(_bt) ? Math.max(0, _bt) : 0,', 'job field');
m = cutLine(m, 'breakerThreshold: Number.isFinite(j.breakerThreshold) ? j.breakerThreshold : 0,', 'resume field');
m = repRx(m, /retry=2\/breaker=0\/etc/, 'retry=2/etc', 'resume comment');
m = repRx(m, /breakerThreshold = 0, (retryRowIndexes = null)/, '$1', 'prelude destructure');
m = cutLine(m, '(parseInt(breakerThreshold) || 0),', 'inj entry');
if (/breakerThreshold/.test(m)) throw new Error('main breaker leftovers');
fs.writeFileSync(mp, m, 'utf8');
}

// ── index.html ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
{ // UI block: enclosing <div class="fg"> .. </div> around the label/input/hint
  const i = h.indexOf('<label>Stop after consecutive errors</label>');
  if (i < 0) throw new Error('breaker label missing');
  let ls = h.lastIndexOf('\n', i) + 1;            // label line start
  ls = h.lastIndexOf('\n', ls - 2) + 1;           // <div class="fg"> line start
  const closeIdx = h.indexOf('</div>', i);
  if (closeIdx < 0) throw new Error('breaker block close missing');
  let le = h.indexOf('\n', closeIdx); le = le < 0 ? h.length : le + 1;
  h = h.slice(0, ls) + h.slice(le);
}
h = cutAllLines(h, "breakerThreshold: parseInt(document.getElementById('breakerThreshold').value||20),", 'submit reads', 2);
h = cutLine(h, 'breakerThreshold: snap.breakerThreshold,', 'snapshot');
h = cutLine(h, 'breakerThreshold:(checkpoint.breakerThreshold!=null?checkpoint.breakerThreshold:20),', 'checkpoint');
h = cutLine(h, "breakerThreshold: document.getElementById('breakerThreshold').value,", 'settings save');
h = repRx(h, /^.*if\(c\.breakerThreshold != null\).*\r?\n/m, '', 'settings load');
// renderer: circuit-breaker event branch, orphan-resume breaker branch, reclaim display
h = cutUntilBefore(h, "else if(evt.type==='circuit-breaker'){", "else if(evt.type==='row-start'){", 'evt branch');
h = cutUntilBefore(h, "}else if(orphan.lastError && orphan.lastError.phase==='circuit-breaker'){", "}else if(orphan.lastError && orphan.lastError.phase==='fatal'){", 'orphan branch');
h = repRx(h, /^.*if\(reclaimAgg\['breaker'\]>0\).*\r?\n/m, '', 'reclaim display');
h = repRx(h, /  \/\/ default hidden, only breaker case shows it/, '', 'skipBtn trailing comment');
const hLeft = h.split(/\r?\n/).filter(l => !/^\s*\/\/|^\s*<!--/.test(l) && /breaker/i.test(l.replace(/'breaker':0,? ?/g, '')));
if (hLeft.length) { hLeft.forEach(l => console.error('SURVIVOR: ' + l.trim().slice(0, 100))); throw new Error('index breaker leftovers'); }
fs.writeFileSync(hp, h, 'utf8');
console.log('main + index breaker cut');
