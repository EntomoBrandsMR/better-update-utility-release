// _hdr-removal.js — kill the legacy top-bar button cluster for real (R11 left it greyed
// out instead of gone). Deletes: Updates / Load flow / Save flow / Flows / Run automation
// (runBtn) / hidden stopBtn + forceStopBtn, plus their orphaned JS (runBtnClick, stopRun,
// forceStopNow, refreshRunBtn + calls). requestStop STAYS (debugger paneStop uses it);
// loadFlow/saveFlow/openFlowsFolder/checkUpdates defs STAY (rehomed). New homes: sidebar
// FLOW section gains Load flow + Flows folder; sidebar bottom gains Check for updates.
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
// delete a whole function by brace-scanning from its header line; optional=ok if absent
function delFn(s, header, label, optional) {
  const i = s.indexOf(header);
  if (i < 0) { if (optional) { console.log('  (no def for ' + label + ' — already gone, R11)'); return s; } throw new Error('fn missing: ' + label); }
  const open = s.indexOf('{', i);
  let depth = 0, j = open;
  for (; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error('brace scan failed: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let le = s.indexOf('\n', j) + 1;
  if (le === 0) le = s.length;
  return s.slice(0, ls) + s.slice(le);
}
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (h.includes('id="runBtn"')) {
  // ── 1) the HTML cluster: tb-sp spacer through forceStopBtn ──
  const a = h.indexOf('<span class="tb-sp"></span>');
  const fb = h.indexOf('id="forceStopBtn"');
  const b = h.indexOf('</button>', fb) + '</button>'.length;
  if (a < 0 || fb < 0) throw new Error('cluster anchors missing');
  const ls = h.lastIndexOf('\n', a) + 1;
  let le = h.indexOf('\n', b) + 1;
  h = h.slice(0, ls)
    + '  <!-- The legacy header controls (Updates / Load / Save / Flows / Run automation /\n'
    + '       Stop / Force-stop) are GONE, not hidden. Everything lives in the sidebar now:\n'
    + '       Flow section (save/load/folder), Worker pool (run/stop), bottom (updates). -->\n'
    + h.slice(le);

  // ── 2) orphaned JS ──
  h = delFn(h, 'function refreshRunBtn', 'refreshRunBtn');
  h = h.split('\n').filter(l => l.trim() !== 'refreshRunBtn();').join('\n');
  h = delFn(h, 'async function runBtnClick', 'runBtnClick', true);
  h = delFn(h, 'function runBtnClick', 'runBtnClick2', true);
  h = delFn(h, 'async function stopRun', 'stopRun', true);
  h = delFn(h, 'async function forceStopNow', 'forceStopNow', true);

  // ── 3) sidebar rehoming ──
  h = rep(h, '    <button class="tbtn" onclick="saveFlow()" style="width:100%">Save flow</button>', [
    '    <button class="tbtn" onclick="saveFlow()" style="width:100%">Save flow</button>',
    '    <div style="display:flex;gap:6px">',
    '      <button class="tbtn" onclick="loadFlow()" style="flex:1">Load flow</button>',
    '      <button class="tbtn" onclick="openFlowsFolder()" style="flex:1" title="Open flows folder">\ud83d\udcc1 Flows</button>',
    '    </div>'
  ].join('\n'), 'flow buttons');
  h = rep(h, 'title="Log out any BUU sessions still logged in on PestPac (License Manager). Use if you see stuck sessions.">Log out stuck sessions</button>', [
    'title="Log out any BUU sessions still logged in on PestPac (License Manager). Use if you see stuck sessions.">Log out stuck sessions</button>',
    '    <button class="tbtn" onclick="checkUpdates()" style="width:100%;margin-top:2px" title="Check for a new BUU version now">Check for updates</button>'
  ].join('\n'), 'updates button');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('done');
} else console.log('already done');
// leftover-ref audit
const h2 = fs.readFileSync(hp, 'utf8');
for (const n of ["'runBtn'", "'runBtnLbl'", "'runBtnIcon'", "'stopBtn'", 'runBtnClick', 'stopRun(', 'forceStopNow', 'refreshRunBtn']) {
  let p = -1, c = 0;
  while ((p = h2.indexOf(n, p + 1)) >= 0) c++;
  if (c) console.log('LEFTOVER: ' + n + ' x' + c);
}
console.log('audit complete');
