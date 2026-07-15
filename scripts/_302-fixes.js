// _302-fixes.js — v3.0.2 batch 1.
// A) panel-schedules was inserted OUTSIDE .content/.shell (body-level orphan) by the R16
//    script, which anchored on pasteModal. .shell is full-height so an activated panel
//    below it renders off-screen => Schedules was completely blank. Move it inside
//    .content, next to its sibling panels.
// B) setRunMode() opened with markFlowDirty(), and boot calls setRunMode('per-row') —
//    so BUU marked a nonexistent flow dirty before the user touched anything, and Load
//    flow then demanded to save "changes" to nothing. Programmatic callers now say so.
// C) Belt-and-braces: never prompt to save a flow that has nothing in it.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function rep(s, from, to, label) {
  const i = s.indexOf(from);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(from, i + 1) >= 0) throw new Error('anchor NOT UNIQUE: ' + label);
  return s.slice(0, i) + to + s.slice(i + from.length);
}
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');

// ── A) relocate panel-schedules into .content ──
const startMark = '<!-- \u2550\u2550 SCHEDULES (R16) \u2550\u2550 -->';
const modalMark = '<div class="modal-bg" id="pasteModal">';
const a = h.indexOf(startMark);
const b = h.indexOf(modalMark);
if (a < 0 || b < 0) throw new Error('schedules/modal anchors missing');
if (a > b) throw new Error('unexpected order');
let block = h.slice(a, b);
const bo = (block.match(/<div\b/g) || []).length, bc = (block.match(/<\/div>/g) || []).length;
if (bo !== bc) throw new Error('extracted block unbalanced: ' + bo + ' open / ' + bc + ' close');
h = h.slice(0, a) + h.slice(b);               // remove from body level
block = block.replace(/\s+$/, '') + '\n\n';
h = rep(h, '</div><!-- /content -->', block + '</div><!-- /content -->', 'reinsert into content');

// ── B) programmatic setRunMode must not dirty the flow ──
h = rep(h, 'function setRunMode(mode){ markFlowDirty();',
  '// v3.0.2: _programmatic = called by boot/load to sync the UI, NOT a user edit. Boot\n' +
  "// called setRunMode('per-row') which marked a nonexistent flow dirty, so Load flow\n" +
  '// immediately demanded to save "unsaved changes" that did not exist.\n' +
  'function setRunMode(mode, _programmatic){ if(!_programmatic) markFlowDirty();', 'setRunMode sig');
h = rep(h, "setRunMode('per-row');", "setRunMode('per-row', true); // v3.0.2: boot sync, not a user edit", 'boot call');
h = rep(h, 'setRunMode(runMode);  // triggers visibility toggles + validation re-run',
  'setRunMode(runMode, true);  // triggers visibility toggles + validation re-run (v3.0.2: load sync, not a user edit)', 'load call');

// ── C) never prompt when there is nothing to save ──
h = rep(h, 'async function loadFlow(){', [
  '// v3.0.2: is there anything a save would actually preserve? The locked PestPac',
  '// login/logout steps are seeded scaffolding, not user work.',
  'function flowHasContent(){',
  '  try{ return !!(flowName || (steps||[]).some(function(s){ return !s.locked; })); }catch(e){ return true; }',
  '}',
  'async function loadFlow(){'
].join('\n'), 'flowHasContent');
h = rep(h, '  if(flowDirty){\n    const r = API.confirmUnsaved ? await API.confirmUnsaved() : (confirm(\'Discard unsaved changes?\') ? 1 : 2);',
  "  if(flowDirty && flowHasContent()){\n    const r = API.confirmUnsaved ? await API.confirmUnsaved() : (confirm('Discard unsaved changes?') ? 1 : 2);", 'loadFlow guard');
fs.writeFileSync(hp, h, 'utf8');
console.log('A/B/C applied');
