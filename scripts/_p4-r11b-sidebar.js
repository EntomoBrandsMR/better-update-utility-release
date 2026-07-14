// _p4-r11b-sidebar.js — Phase 4 R11b: sidebar consolidation + D6 audit + orphan sweep.
// Sidebar gains a Flow section (active flow name + Save Flow); the single Run button is
// the existing sidebar Run pool button; pool sliders already live there (v2.1.0 + R4).
// Worker cards and run status DO NOT MOVE (spec). Dead UI deleted: the launch-card
// duplicate Start button, runStopped (uncalled since R11a), _lastRunSnapshot, and the
// pane functions' dead single-runner branches. D6: explicit z-index ladder documented
// in one place; both overlays were already default-hidden — repro not confirmable in
// source, Matthew re-tests in his pass (noted in TODO).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('sbFlowName')) {
  const before = h.split('\n').length;
  // 1) sidebar Flow section before "Live"
  h = repRx(h, /(  <div class="sb-sep"><\/div>\r?\n  <div class="sb-sec">Live<\/div>)/, [
    '  <div class="sb-sep"></div>',
    '  <!-- R11b: flow-building + run-launch controls consolidated in the sidebar (spec:',
    '       flow name, Save Flow, single Run button — the Run pool button below is it;',
    '       the pool sliders moved here back in v2.1.0/R4). -->',
    '  <div class="sb-sec">Flow</div>',
    '  <div style="padding:2px 14px 6px;display:flex;flex-direction:column;gap:6px">',
    '    <div id="sbFlowName" style="font-size:12px;font-weight:700;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="Active flow">Building</div>',
    '    <button class="tbtn" onclick="saveFlow()" style="width:100%">Save flow</button>',
    '  </div>',
    '$1'
  ].join('\n'), 'flow section');
  // 2) name sync
  h = repRx(h, /(  const el = document\.getElementById\('builderFlowName'\);\r?\n  if\(el\) el\.textContent = [^\n]*\r?\n)/, [
    '$1',
    "  const sb = document.getElementById('sbFlowName');",
    "  if(sb) sb.textContent = (flowName || 'Building') + (flowDirty ? ' \\u2022' : '');",
    ''
  ].join('\n'), 'name sync');
  // 3) launch-card duplicate Start button dies
  h = repRx(h, /      <button class="btn grn" onclick="startRun\(\)">[\s\S]*?<\/button>\r?\n/, '', 'launch start');
  // 4) runStopped (uncalled since R11a)
  h = repRx(h, /function runStopped\(\)\{[\s\S]*?\r?\n\}\r?\n/, '// R11b: runStopped deleted — poolUIActive owns the UI reset; nothing called it since R11a.\n', 'runStopped');
  // 5) orphaned snapshot decl
  h = repRx(h, /^let _lastRunSnapshot = null;\r?\n/m, '', 'snapshot decl');
  // 6) pane dead single-runner branches (API.runControl no longer exists)
  for (const cmd of ['next-step', 'next-row', 'run-all']) {
    h = repRx(h, new RegExp("\\} else if \\(API\\.runControl\\) \\{\\r?\\n    await API\\.runControl\\(\\{runId:currentRunId, cmd:'" + cmd + "'\\}\\);\\r?\\n  \\}"), '}', 'dead branch ' + cmd);
  }
  // 7) D6: z-index ladder, explicit and documented in one place
  h = repRx(h, /(\.modal-bg \{)/, [
    '/* R11b (D6 audit): the overlay z ladder, explicit and in ONE place.',
    '   10   sticky in-page headers',
    '   400  .setup-overlay   (first-boot Chromium blocker)',
    '   500  .modal-bg        (paste modal etc. — must sit above the setup overlay)',
    '   Every overlay defaults hidden and is shown explicitly (.open / .show). */',
    '$1'
  ].join('\n'), 'z ladder');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done (lines ' + before + ' -> ' + h.split('\n').length + ')');
} else console.log('index already done');
