// _teardown-2-verify.js — remove verify-after-action everywhere (worker, main, coordinator,
// UI). Exact-string anchored; throws if any anchor is missing.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function repRx(s, rx, to, label) {
  const m = s.match(rx);
  if (!m) throw new Error('anchor missing: ' + label);
  if (s.match(new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g')).length > 1) throw new Error('anchor not unique: ' + label);
  return s.replace(rx, to);
}
function rep(s, from, to, label) {
  const i = s.indexOf(from);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(from, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  return s.slice(0, i) + to + s.slice(i + from.length);
}
function cutFromTo(s, startNeedle, endNeedle, label) { // start-of-line(start) .. end-of-line(end)
  const i = s.indexOf(startNeedle);
  if (i < 0) throw new Error('start missing: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  const k = s.indexOf(endNeedle, i);
  if (k < 0) throw new Error('end missing: ' + label);
  let le = s.indexOf('\n', k); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}

function cutUntilBefore(s, startNeedle, stopNeedle, label) {
  const i = s.indexOf(startNeedle);
  if (i < 0) throw new Error('start missing: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  const k = s.indexOf(stopNeedle, i + startNeedle.length);
  if (k < 0) throw new Error('stop missing: ' + label);
  return s.slice(0, ls) + s.slice(s.lastIndexOf('\n', k) + 1);
}
function cutBlockByBraces(s, startNeedle, label) {
  const i = s.indexOf(startNeedle);
  if (i < 0) throw new Error('block start missing: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let d = 0, j = ls, seen = false;
  for (; j < s.length; j++) {
    if (s[j] === '{') { d++; seen = true; }
    else if (s[j] === '}') { d--; if (seen && d === 0) break; }
  }
  if (j >= s.length) throw new Error('unbalanced: ' + label);
  let le = s.indexOf('\n', j); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}

// ── worker.js ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('VERIFY_AFTER_ACTION')) { console.log('worker already cut'); } else {
w = cutFromTo(w, '// v2.2.3 Session 3D (A2): verify pass toggle.', 'const VERIFY_AFTER_ACTION = /*__BUU_CFG_17__*/null;', 'verify const');
// verifyRow: cut from its leading comments through the line before main()'s own
// leading comments (brace-matching is unsafe — braces appear inside strings).
{
  const i = w.indexOf('// v2.2.3 Session 3D (A2): verify-after-action pass. Re-navigates');
  if (i < 0) throw new Error('verifyRow comments missing');
  const ls = w.lastIndexOf('\n', i) + 1;
  const k = w.indexOf('async function main(){', i);
  if (k < 0) throw new Error('main() anchor missing');
  let ks = w.lastIndexOf('\n', k) + 1;
  // keep main()'s doc comments: walk back over comment-only lines
  while (true) {
    const prevStart = w.lastIndexOf('\n', ks - 2) + 1;
    const prevLine = w.slice(prevStart, ks);
    if (/^\s*\/\//.test(prevLine)) ks = prevStart; else break;
  }
  w = w.slice(0, ls) + w.slice(ks);
}

// verify pass block in processRow + trailing close brace
w = cutFromTo(w, '// v2.2.3 Session 3D (A2): verify-after-action. Re-navigate and read back fields', '        res.verifyOk = true;', 'verify pass block');
w = repRx(w, /\r?\n      \}\r?\n      const entry=\{/, '\n      const entry={', 'verify chain close');
// xlsx entry columns
w = repRx(w, /,\r?\n        \/\/ v2\.2\.3 Session 3D \(A2\): verify-pass result columns\.\r?\n        verifyFailedFields: res\.verifyFailedFields \|\| '',\r?\n        verifyOk: res\.verifyOk \? 'yes' : '' \};/, ' };', 'entry columns');
// emit fields
w = repRx(w, /      \/\/ v2\.2\.3 Session 3D \(A2\): also pass verify result columns\.\r?\n/, '', 'emit comment');
w = repRx(w, /,\r?\n        verifyFailedFields: res\.verifyFailedFields \|\| null,\r?\n        verifyOk: !!res\.verifyOk\}\);/, '});', 'emit fields');
// renumber the last cfg marker
w = rep(w, '/*__BUU_CFG_18__*/null', '/*__BUU_CFG_17__*/null', 'marker renumber');
if (/VERIFY_AFTER_ACTION|verifyRow|verifyOk|verifyFailedFields/.test(w)) throw new Error('worker still references verify');
fs.writeFileSync(wp, w, 'utf8');
}

// ── main.js ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
m = rep(m, ', captureBucketCap, verifyAfterAction }) => {', ', captureBucketCap }) => {', 'pool-start params');
m = cutFromTo(m, "// v2.2.3 Session 3D (A2): verify-after-action toggle. ON by default since v2.2.3 exists", 'COORD.verifyAfterAction = (verifyAfterAction === false) ? false : true;', 'pool-start assign');
m = cutFromTo(m, '// v2.2.3 Session 3D (A2): restore verify-after-action toggle.', 'COORD.verifyAfterAction = (meta.verifyAfterAction === false) ? false : true', 'resume restore');
m = cutFromTo(m, "// v2.2.3 Session 3D (A2): verify-after-action. Re-navigates to the row's primary URL", 'verifyAfterAction = true,', 'prelude destructure');
m = repRx(m, /    \(verifyAfterAction \? 'true' : 'false'\),\r?\n/, '', 'inj entry');
if (/verifyAfterAction/.test(m)) throw new Error('main still references verifyAfterAction');
fs.writeFileSync(mp, m, 'utf8');

// ── coordinator.js ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
c = cutFromTo(c, '// v2.2.3 Session 3D (A2): verify-after-action toggle.', 'verifyAfterAction: !!COORD.verifyAfterAction,', 'meta field');
if (/verifyAfterAction/.test(c)) throw new Error('coordinator still references verifyAfterAction');
fs.writeFileSync(cp, c, 'utf8');
console.log('worker/main/coordinator verify teardown done');

// ── index.html ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
h = cutUntilBefore(h, '<!-- v2.2.3 Session 3D (A2): verify-after-action toggle. THE headline feature', '<button class="tbtn grn" id="poolRunBtn"', 'UI toggle block');
h = cutFromTo(h, '// v2.2.3 Session 3D (A2): verify-after-action toggle. ON by default.', "const verifyAfterAction = !!(document.getElementById('poolVerify')||{checke", 'read line');
h = rep(h, ', captureBucketCap, verifyAfterAction });', ', captureBucketCap });', 'poolStart param');
if (/verifyAfterAction|poolVerify/.test(h)) throw new Error('index still references verify');
fs.writeFileSync(hp, h, 'utf8');
console.log('index.html verify teardown done');
