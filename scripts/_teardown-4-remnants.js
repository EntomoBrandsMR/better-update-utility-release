// _teardown-4-remnants.js — single-runner remnant sweep. LIVE-PATH SAFE: the automation-
// event dispatcher + updateRunStats stay (fed by the v2.2.2 preload shim until R11).
// Removed: v1.x checkpoint/orphan-resume UI (preload stubs made it unreachable), the
// shadowed v1.3.4 parallel-runner pool block, its stub overrides, dead preload entries.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function cutLine(s, needle, label) {
  const i = s.indexOf(needle);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(needle, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let le = s.indexOf('\n', i); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}
function cutFromTo(s, startNeedle, endNeedle, label) {
  const i = s.indexOf(startNeedle);
  if (i < 0) throw new Error('start missing: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  const k = s.indexOf(endNeedle, i);
  if (k < 0) throw new Error('end missing: ' + label);
  let le = s.indexOf('\n', k); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}
function cutUntilBeforeKeepComments(s, startNeedle, stopNeedle, label) {
  const i = s.indexOf(startNeedle);
  if (i < 0) throw new Error('start missing: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  const k = s.indexOf(stopNeedle, i + startNeedle.length);
  if (k < 0) throw new Error('stop missing: ' + label);
  let ks = s.lastIndexOf('\n', k) + 1;
  while (true) { // leave the stop construct's own leading comments in place
    const prevStart = s.lastIndexOf('\n', ks - 2) + 1;
    const prevLine = s.slice(prevStart, ks);
    if (/^\s*\/\//.test(prevLine)) ks = prevStart; else break;
  }
  return s.slice(0, ls) + s.slice(ks);
}
function divCut(s, startNeedle, label) { // cut a balanced <div>...</div> block by tag depth
  const i = s.indexOf(startNeedle);
  if (i < 0) throw new Error('div start missing: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let depth = 0, j = ls;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = ls;
  let m;
  while ((m = re.exec(s))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { j = m.index + m[0].length; break; }
  }
  if (depth !== 0) throw new Error('unbalanced divs: ' + label);
  let le = s.indexOf('\n', j); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}

// ── index.html ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (h.includes('id="resumeOverlay"')) {
  { // resume overlay: bounded cut — overlay closes right before the TOPBAR banner comment
    const i = h.indexOf('<div class="setup-overlay" id="resumeOverlay">');
    if (i < 0) throw new Error('overlay start missing');
    const ls = h.lastIndexOf('\n', i) + 1;
    const k = h.indexOf('<!-- TOPBAR -->', i);
    if (k < 0) throw new Error('TOPBAR anchor missing');
    h = h.slice(0, ls) + h.slice(h.lastIndexOf('\n', k) + 1);
  }
  h = cutFromTo(h, '// Resume-on-launch: scan for orphaned checkpoints', "catch(e) { console.error('Orphan checkpoint scan failed:', e); }", 'startup scan');
  h = h.replace(/\r?\n    \}(\r?\n    \/\/ v2\.0\.0: scan for orphan POOL runs)/, '$1');
  h = cutUntilBeforeKeepComments(h, 'function fmtRelativeTime(iso){', 'function handleRunEvent(evt){', 'checkpoint fns');
  { // v1.3.4 parallel-runner block: anchor on `const pool = {` (unique) and walk back over
    // its banner comments; cut through the line before poolToggleAutoScale. coordActive survives.
    const mark = h.indexOf('const pool = {');
    if (mark < 0) throw new Error('pool const missing');
    let ls = h.lastIndexOf('\n', mark) + 1;
    while (true) {
      const prevStart = h.lastIndexOf('\n', ls - 2) + 1;
      const prevLine = h.slice(prevStart, ls);
      if (/^\s*\/\//.test(prevLine)) ls = prevStart; else break;
    }
    const stop = h.indexOf('function poolToggleAutoScale(){', mark);
    if (stop < 0) throw new Error('poolToggleAutoScale missing');
    const ks = h.lastIndexOf('\n', stop) + 1;
    h = h.slice(0, ls)
      + '// v2.0.0: true while the elastic coordinator pool is running (drives Stop routing).\n'
      + '// (Survivor of the v1.3.4 parallel-runner block removed in the Phase 2 teardown.)\n'
      + 'let coordActive = false;\n\n'
      + h.slice(ks);
  }
  h = cutLine(h, 'function startWorkerPool(){ /* superseded by coordinator poolRunClick */ }', 'stub startWorkerPool');
  h = cutLine(h, 'function poolHandleEvent(){ }', 'stub poolHandleEvent');
  h = cutLine(h, 'function poolFinished(){ poolUIActive(false); }', 'stub poolFinished');
  const bad = h.split(/\r?\n/).filter(l => !/^\s*\/\/|^\s*<!--/.test(l) &&
    /showResumePrompt|resumeChoice|executeResume|resumeOverlay|shardRanges|poolWorkerCard|renderPool\(|pool\.workers|fmtRelativeTime/.test(l));
  if (bad.length) { bad.forEach(l => console.error('SURVIVOR: ' + l.trim().slice(0, 100))); throw new Error('index remnant leftovers'); }
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index swept');
} else console.log('index already swept');

// ── preload.js ──
const pp = path.join(root, 'src', 'preload.js');
let p = fs.readFileSync(pp, 'utf8');
if (p.includes('findOrphanCheckpoints')) {
  p = cutLine(p, 'getCheckpoint:       ()      => Promise.resolve(null),', 'stub getCheckpoint');
  p = cutLine(p, 'findOrphanCheckpoints:()     => Promise.resolve([]),', 'stub findOrphan');
  p = cutLine(p, 'loadCheckpoint:      ()      => Promise.resolve(null),', 'stub loadCheckpoint');
  p = cutLine(p, 'discardCheckpoint:   ()      => Promise.resolve({ ok: true }),', 'stub discardCheckpoint');
  p = cutLine(p, "poolReadJournal:     (d)     => ipcRenderer.invoke('pool-read-journal', d),", 'poolReadJournal');
  p = cutLine(p, 'breakerThreshold: parseInt(d.breakerThreshold) || 0,', 'shim breaker');
  p = cutLine(p, 'batchSize: 10,', 'shim batchSize');
  p = cutLine(p, 'verifyAfterAction: true,', 'shim verify');
  p = cutLine(p, '// v2.2.3 Session 3D (A2): verify-after-action ON by default for the legacy Start path too.', 'shim verify comment');
  const pCode = p.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
  if (/Checkpoint|breakerThreshold|verifyAfterAction|batchSize|pool-read-journal/.test(pCode)) throw new Error('preload leftovers');
  fs.writeFileSync(pp, p, 'utf8');
  console.log('preload swept');
} else console.log('preload already swept');
