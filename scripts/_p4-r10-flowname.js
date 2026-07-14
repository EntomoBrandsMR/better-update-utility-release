// _p4-r10-flowname.js — Phase 4 R10: flow-name UX.
// Build page shows the active flow name ('Building' = new/unsaved; a dot marks dirty).
// Dirty tracking: explicit hooks on every step mutation + a delegated input/change
// listener over the whole builder panel (catches config fields). Unsaved-changes prompt
// (Save / Don't Save / Cancel, native 3-button dialog) on flow-switch AND app close;
// the close path round-trips Save through the renderer since the save dialog lives there.
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
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}

// ── index.html ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('markFlowDirty')) {
  h = rep(h, '<div class="page-title">Build steps</div>',
    '<div class="page-title">Build steps <span id="builderFlowName" style="font-size:13px;font-weight:600;color:var(--t3);margin-left:8px">— Building</span></div>', 'title');
  h = rep(h, 'let flowAutomation = false; // R9: saves into flows\\automation when checked', [
    'let flowAutomation = false; // R9: saves into flows\\automation when checked',
    '',
    "// R10: dirty tracking + active-flow-name display. 'Building' = new/unsaved flow; a",
    '// dot marks unsaved changes. Main is kept informed so app-close can prompt.',
    'let flowDirty = false;',
    'function updateBuilderTitle(){',
    "  const el = document.getElementById('builderFlowName');",
    "  if(el) el.textContent = '\\u2014 ' + (flowName || 'Building') + (flowDirty ? ' \\u2022' : '');",
    '}',
    'function markFlowDirty(){',
    '  if(flowDirty) return;',
    '  flowDirty = true;',
    '  updateBuilderTitle();',
    '  if(API.setFlowDirty) API.setFlowDirty(true);',
    '}',
    'function clearFlowDirty(){',
    '  flowDirty = false;',
    '  updateBuilderTitle();',
    '  if(API.setFlowDirty) API.setFlowDirty(false);',
    '}'
  ].join('\n'), 'state fns');
  // mutation hooks
  h = rep(h, 'function u(id,f,v) { const s=steps.find(x=>x.id===id); if(s) s[f]=v; scheduleValidationRefresh(); }',
    'function u(id,f,v) { const s=steps.find(x=>x.id===id); if(s){ s[f]=v; markFlowDirty(); } scheduleValidationRefresh(); }', 'u hook');
  h = rep(h, 'function delStep(e,id) { e.stopPropagation(); steps=steps.filter(s=>s.id!==id); renderSteps(); }',
    'function delStep(e,id) { e.stopPropagation(); steps=steps.filter(s=>s.id!==id); markFlowDirty(); renderSteps(); }', 'del hook');
  h = rep(h, '[steps[i],steps[ni]]=[steps[ni],steps[i]]; renderSteps(); }',
    '[steps[i],steps[ni]]=[steps[ni],steps[i]]; markFlowDirty(); renderSteps(); }', 'mv hook');
  h = rep(h, "steps.push(st); document.getElementById('addMenu')",
    "steps.push(st); markFlowDirty(); document.getElementById('addMenu')", 'add hook');
  h = repRx(h, /(    steps\.splice\(insertAt, 0, moved\);\r?\n    dragSrcId = null;\r?\n    renderSteps\(\);)/,
    '    steps.splice(insertAt, 0, moved);\n    markFlowDirty();\n    dragSrcId = null;\n    renderSteps();', 'drag hook');
  h = repRx(h, /function setRunMode\(([^)]*)\)\s*\{/, 'function setRunMode($1){ markFlowDirty();', 'runmode hook');
  h = rep(h, 'onchange="flowAutomation=this.checked"', 'onchange="flowAutomation=this.checked;markFlowDirty()"', 'automation hook');
  // delegated catch-all + boot title init
  h = rep(h, 'renderColChips(); renderPreview(); renderSteps(); refreshRunBtn();', [
    'renderColChips(); renderPreview(); renderSteps(); refreshRunBtn();',
    '  // R10: delegated dirty catch-all — any input/change inside the builder (step fields,',
    '  // flow-type controls, run config) marks the flow dirty. Explicit hooks cover the',
    '  // button-driven mutations (add/delete/reorder) that fire no input events.',
    '  try{',
    "    const _pb = document.getElementById('panel-builder');",
    "    if(_pb){ _pb.addEventListener('input', markFlowDirty, true); _pb.addEventListener('change', markFlowDirty, true); }",
    '    updateBuilderTitle();',
    '  }catch(e){}',
    '  if(API.onSaveFlowThenClose) API.onSaveFlowThenClose(async function(){',
    '    // R10 app-close Save path: save, then let main proceed; a cancelled save stays open.',
    '    const ok = await saveFlow();',
    '    if(ok && API.flowCloseNow) API.flowCloseNow();',
    '  });'
  ].join('\n'), 'boot hook');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index part 1 done');
} else console.log('index part 1 already done');

// index part 2: saveFlow sync/clear/returns + loadFlow gate/clear
h = fs.readFileSync(hp, 'utf8');
if (!h.includes('confirmUnsaved')) {
  h = repRx(h, /    if\(p\) \{\r?\n      alert\('Flow saved to ' \+ p\);/, [
    '    if(p) {',
    "      // R10: the filename is the flow's name (v1.2.8.1 rule) — sync it, clear dirty.",
    "      flowName = String(p).replace(/\\\\/g,'/').split('/').pop().replace(/\\.json$/i,'');",
    '      clearFlowDirty();',
    "      alert('Flow saved to ' + p);"
  ].join('\n'), 'save sync');
  h = repRx(h, /(      if\(runMode === 'once'\) refreshOnceFlowDropdowns\(\);\r?\n    \})(\r?\n  \} else \{)/,
    '$1\n    return !!p;$2', 'save return 1');
  h = repRx(h, /(    a\.download = \(flow\.name \|\| 'buu-flow'\) \+ '\.json';\r?\n    a\.click\(\);\r?\n)(  \}\r?\n\})/,
    '$1    return false; // browser fallback cannot confirm a save landed\n$2', 'save return 2');
  h = repRx(h, /async function loadFlow\(\)\{\r?\n  let json;/, [
    'async function loadFlow(){',
    "  // R10: unsaved-changes gate on flow switch — Save / Don't Save / Cancel via a",
    '  // native 3-button dialog (confirm() can only do two).',
    '  if(flowDirty){',
    "    const r = API.confirmUnsaved ? await API.confirmUnsaved() : (confirm('Discard unsaved changes?') ? 1 : 2);",
    '    if(r === 2) return;',
    '    if(r === 0){ const ok = await saveFlow(); if(!ok) return; }',
    '  }',
    '  let json;'
  ].join('\n'), 'load gate');
  h = rep(h, "  { const _fa = document.getElementById('flowAutomation'); if (_fa) _fa.checked = flowAutomation; }",
    "  { const _fa = document.getElementById('flowAutomation'); if (_fa) _fa.checked = flowAutomation; }\n  clearFlowDirty(); // R10: freshly loaded = clean; also refreshes the builder title", 'load clear');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index part 2 done');
} else console.log('index part 2 already done');

// ── preload ──
const pp = path.join(root, 'src', 'preload.js');
let p = fs.readFileSync(pp, 'utf8');
if (!p.includes('confirmUnsaved')) {
  p = repRx(p, /(  readFlowByName:[^\n]*\r?\n)/, [
    '$1',
    "  setFlowDirty:        (v)     => ipcRenderer.send('flow-dirty-state', !!v), // R10",
    "  confirmUnsaved:      ()      => ipcRenderer.invoke('confirm-unsaved'),     // R10",
    "  flowCloseNow:        ()      => ipcRenderer.send('flow-close-now'),        // R10",
    "  onSaveFlowThenClose: (cb)    => ipcRenderer.on('save-flow-then-close', () => cb()), // R10",
    ''
  ].join('\n'), 'preload entries');
  fs.writeFileSync(pp, p, 'utf8');
  console.log('preload done');
} else console.log('preload already done');

// ── main.js: dirty state, 3-button dialog, close interception ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('flowDirtyMain')) {
  m = rep(m, '// R9: flow folders. flows\\once\\ (setup/teardown once-flows), flows\\automation\\', [
    "// R10: unsaved-changes prompt on app close. The renderer keeps us informed of dirty",
    '// state; close is intercepted once and prompted natively (Save / Don\u2019t Save / Cancel).',
    '// Save round-trips through the renderer — the save dialog lives there.',
    'let flowDirtyMain = false;',
    'let forceClosing = false;',
    "ipcMain.on('flow-dirty-state', (_, v) => { flowDirtyMain = !!v; });",
    "ipcMain.on('flow-close-now', () => { forceClosing = true; try { mainWindow.close(); } catch (e) {} });",
    "ipcMain.handle('confirm-unsaved', async () => {",
    '  const r = await dialog.showMessageBox(mainWindow, {',
    "    type: 'warning', buttons: ['Save', \"Don't Save\", 'Cancel'], defaultId: 0, cancelId: 2,",
    "    title: 'Unsaved changes', message: 'This flow has unsaved changes.', detail: 'Save them before switching flows?',",
    '  });',
    '  return r.response;',
    '});',
    '',
    '// R9: flow folders. flows\\once\\ (setup/teardown once-flows), flows\\automation\\'
  ].join('\n'), 'ipc block');
  m = rep(m, "  mainWindow.loadFile(path.join(__dirname, 'index.html'));", [
    "  mainWindow.loadFile(path.join(__dirname, 'index.html'));",
    '  // R10: intercept close while a flow has unsaved changes.',
    '  mainWindow.on(\'close\', (e) => {',
    '    if (forceClosing || !flowDirtyMain) return;',
    '    e.preventDefault();',
    '    dialog.showMessageBox(mainWindow, {',
    "      type: 'warning', buttons: ['Save', \"Don't Save\", 'Cancel'], defaultId: 0, cancelId: 2,",
    "      title: 'Unsaved changes', message: 'This flow has unsaved changes.', detail: 'Save before closing BUU?',",
    '    }).then(r => {',
    "      if (r.response === 0) { try { mainWindow.webContents.send('save-flow-then-close'); } catch (e2) {} }",
    '      else if (r.response === 1) { forceClosing = true; mainWindow.close(); }',
    '      // Cancel: stay open.',
    '    }).catch(() => {});',
    '  });'
  ].join('\n'), 'close hook');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');
