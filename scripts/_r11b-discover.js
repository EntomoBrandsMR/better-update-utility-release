// _r11b-discover.js — sidebar anchors, overlays/z-index, orphan refs (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const L = h.split(/\r?\n/);
let out = '';
function refs(label, rx) {
  out += '=== ' + label + ' ===\n';
  for (let i = 0; i < L.length; i++) if (rx.test(L[i])) out += (i + 1) + ': ' + L[i].trim().slice(0, 135) + '\n';
  out += '\n';
}
function seg(label, needle, before, after) {
  const i = h.indexOf(needle);
  out += '=== ' + label + ' (idx ' + i + ') ===\n';
  out += (i >= 0 ? h.slice(Math.max(0, i - before), i + after) : '(NOT FOUND)') + '\n\n';
}
seg('launch-card Start btn', '<button class="btn grn" onclick="startRun()">', 400, 200);
refs('z-index values', /z-index/);
refs('overlay/modal elements', /id="(setupOverlay|resumeOverlay|pasteModal|profileModal|addProfile)/);
refs('runStopped refs', /runStopped/);
refs('_lastRunSnapshot refs', /_lastRunSnapshot/);
refs('onPoolOnceFlow / phase fns', /onPoolOnceFlow|updatePhaseIndicator\(|showPhaseIndicator\(/);
refs('currentRunId refs', /currentRunId/);
seg('sb-sec Live region', '<div class="sb-sec">Live</div>', 200, 100);
fs.writeFileSync(path.join(__dirname, '_r11b-dump.txt'), out, 'utf8');
console.log('written', out.length);
