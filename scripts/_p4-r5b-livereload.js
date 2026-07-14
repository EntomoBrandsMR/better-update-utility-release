// _p4-r5b-livereload.js — Phase 4 R5b: live flow reload + Tier 1 fresh-read.
// Tier 1: the pool reads the SAVED flow file fresh at every launch (disk wins; loud warn
// when in-memory edits differed) + "flow last saved" timestamp in the launch log.
// Live reload: at every step-pause boundary, editor changes push to the worker; edits
// apply cursor-forward. Shape changed ABOVE the cursor -> warn + pick "continue from
// step N" (repositions). NO live reload during full-speed runs (only fires at pauses).
// Also hoists R2's migrateLoadedSteps out of loadFlow scope (bug: was loadFlow-local).
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

// ── worker.js: flow-update command + reposition handling ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('_pendingCursor')) {
  w = rep(w, "_rl.on('line', function(line){",
    "let _pendingCursor = null; // R5b: set by flow-update with a cursor; consumed at the pause loop\n_rl.on('line', function(line){", 'cursor decl');
  w = rep(w, "    // R5 debugger cursor commands — all just release the pending pause with their name;", [
    "    case 'flow-update':",
    '      // R5b: live flow reload at a pause boundary. Replaces the DATA steps with the',
    "      // renderer's current editor state (same locked/logout filter as boot); optional",
    '      // cursor repositions (0-based data-step index). Without a cursor the pending',
    "      // pause stays pending — edits apply from the current step forward via the",
    '      // rebind in the step loop.',
    '      if(Array.isArray(msg.steps)){',
    '        DATA_STEPS.length = 0;',
    "        for(const _st of msg.steps){ if(!_st.locked && _st.type !== 'pestpac-logout') DATA_STEPS.push(_st); }",
    '      }',
    '      if(msg.cursor != null && _pendingPauseResolve){',
    '        _pendingCursor = Math.max(0, parseInt(msg.cursor) || 0);',
    "        const r = _pendingPauseResolve; _pendingPauseResolve = null; r('reposition');",
    '      }',
    '      break;',
    "    // R5 debugger cursor commands — all just release the pending pause with their name;"
  ].join('\n'), 'flow-update case');
  w = rep(w, "        if(cmd === 'redo-step'){ si = Math.max(-1, si - 2); _autoOnce = true; continue; }", [
    "        if(cmd === 'redo-step'){ si = Math.max(-1, si - 2); _autoOnce = true; continue; }",
    "        if(cmd === 'reposition'){ si = (_pendingCursor != null ? _pendingCursor : si + 1) - 1; _pendingCursor = null; continue; }"
  ].join('\n'), 'reposition cmd');
  w = rep(w, '        s = DATA_STEPS[si] || s; // rebind (cheap now; load-bearing once R5b live reload lands)',
    '        s = DATA_STEPS[si]; // R5b: rebind — a live flow update may have replaced the steps\n        if(!s) break; // flow shrank below the cursor — the row is done', 'rebind');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker done');
} else console.log('worker already done');

// ── main.js: whitelist + payload forward + read-flow-by-name ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('read-flow-by-name')) {
  m = rep(m, "'redo-step','last-step','skip-step','restart-row'].includes(cmd)",
    "'redo-step','last-step','skip-step','restart-row','flow-update'].includes(cmd)", 'whitelist');
  m = rep(m, "ipcMain.handle('pool-run-control', async (_, { cmd }) => {",
    "ipcMain.handle('pool-run-control', async (_, _rcPayload) => {\n  const { cmd } = _rcPayload || {};", 'payload sig');
  m = repRx(m, /  for \(const w of COORD\.workers\.values\(\)\) \{\r?\n    try \{ w\.process\.stdin\.write\(JSON\.stringify\(\{ cmd \}\) \+ '\\n'\); \} catch \{\}\r?\n  \}\r?\n  return \{ ok: true \};\r?\n\}\);/,
    [
      '  for (const w of COORD.workers.values()) {',
      "    // R5b: flow-update carries the new steps (+ optional cursor) through to the worker.",
      "    const _msg = cmd === 'flow-update' ? { cmd, steps: _rcPayload.steps, cursor: _rcPayload.cursor } : { cmd };",
      "    try { w.process.stdin.write(JSON.stringify(_msg) + '\\n'); } catch {}",
      '  }',
      '  return { ok: true };',
      '});'
    ].join('\n'), 'payload forward');
  m = rep(m, "ipcMain.handle('load-flow', async () => {", [
    '// R5b Tier 1: silent flow read by display name (the filename is the source of truth',
    '// for flow names since v1.2.8.1). Returns { json, mtime, path } or null. The pool',
    '// launch path uses this so what RUNS is always the saved file, deterministically.',
    "ipcMain.handle('read-flow-by-name', async (_, { name }) => {",
    '  try {',
    "    const safe = String(name || '').replace(/[\\\\/:*?\"<>|]/g, '_');",
    '    if (!safe) return null;',
    "    const fp = path.join(getFlowsDir(), safe + '.json');",
    '    if (!fs.existsSync(fp)) return null;',
    "    return { json: fs.readFileSync(fp, 'utf8'), mtime: fs.statSync(fp).mtimeMs, path: fp };",
    '  } catch (e) { return null; }',
    '});',
    '',
    "ipcMain.handle('load-flow', async () => {"
  ].join('\n'), 'read-by-name');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');

// ── preload.js ──
const pp = path.join(root, 'src', 'preload.js');
let p = fs.readFileSync(pp, 'utf8');
if (!p.includes('readFlowByName')) {
  p = repRx(p, /(  saveFlow:[^\n]*\r?\n)/,
    "$1  readFlowByName:      (d)     => ipcRenderer.invoke('read-flow-by-name', d), // R5b Tier 1\n", 'preload entry');
  fs.writeFileSync(pp, p, 'utf8');
  console.log('preload done');
} else console.log('preload already done');

// ── index.html: hoist migrateLoadedSteps, Tier-1 fresh-read, live-reload push ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('maybePushFlowUpdate')) {
  // 1) hoist migrateLoadedSteps out of loadFlow (R2 put it inside — loadFlow-local scope
  //    meant nothing else could migrate; the launch fresh-read needs it too)
  const migRx = /  \/\/ R2: If-click is absorbed into the unified Click\. Migrate on load; the flow persists\r?\n  \/\/ migrated on its next save\. \(The engine also keeps a legacy alias as a backstop\.\)\r?\n  function migrateLoadedSteps\(list\)\{[\s\S]*?\r?\n  \}\r?\n/;
  const mm = h.match(migRx);
  if (!mm) throw new Error('migrateLoadedSteps block not found');
  h = h.replace(migRx, '');
  h = rep(h, 'async function loadFlow(){', mm[0].replace(/\r\n/g, '\n') + '\nasync function loadFlow(){', 'hoist');
  // 2) Tier-1 fresh-read + submit snapshot inside poolStageCurrent, right before submit
  h = rep(h, '  const res = await API.poolSubmitJob({', [
    '  // R5b Tier 1: the pool runs the SAVED flow file, read fresh at every launch — disk',
    '  // wins, deterministically, with a loud warn when in-memory edits differed (save first',
    '  // if you meant them; the R10 unsaved-changes prompt lands later). Flows never saved',
    '  // under a name in the flows folder fall back to the in-memory steps.',
    '  if (flowName && API.readFlowByName) {',
    '    try {',
    '      const _fr = await API.readFlowByName({ name: flowName });',
    '      if (_fr && _fr.json) {',
    '        const _fresh = JSON.parse(_fr.json);',
    '        if (Array.isArray(_fresh.steps) && _fresh.steps.length) {',
    '          const _memJson = JSON.stringify(steps);',
    '          const _mig = migrateLoadedSteps(_fresh.steps);',
    '          if (JSON.stringify(_mig) !== _memJson) {',
    '            steps = _mig;',
    '            renderSteps();',
    "            addLiveLog('Flow \"'+flowName+'\" re-read from disk for this launch — unsaved in-memory edits were NOT used (save first if you meant them).','warn');",
    '          }',
    '        }',
    "        if (_fr.mtime) addLiveLog('Flow last saved: ' + new Date(_fr.mtime).toLocaleString(), 'info');",
    '      }',
    '    } catch (e) {}',
    '  }',
    '  // R5b: snapshot of the DATA steps as submitted — the live-reload diff baseline.',
    "  lastSubmittedDataJson = JSON.stringify(steps.filter(function(s){ return !s.locked && s.type !== 'pestpac-logout'; }));",
    '  const res = await API.poolSubmitJob({'
  ].join('\n'), 'fresh-read');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index part 1 done');
} else console.log('index part 1 already done');

// index part 2: maybePushFlowUpdate + pause hook + global
h = fs.readFileSync(hp, 'utf8');
if (!h.includes('function maybePushFlowUpdate')) {
  h = rep(h, 'let stepPaneSticky = false;',
    "let stepPaneSticky = false;\nlet lastSubmittedDataJson = null; // R5b: DATA steps as submitted — live-reload diff baseline", 'global');
  h = rep(h, 'async function paneCursorCmd(cmd, msg){', [
    '// R5b: LIVE FLOW RELOAD at a step-pause boundary (never during full-speed runs — this',
    '// only fires from the pause hook). If the editor steps differ from what was submitted:',
    '//  - changes at/below the cursor: push silently; they apply from the current step forward',
    '//  - shape changed ABOVE the cursor: warn, pick "continue from step N", push + reposition',
    'async function maybePushFlowUpdate(p){',
    '  try{',
    '    if(!API.poolRunControl || lastSubmittedDataJson == null) return;',
    "    const dataNow = steps.filter(function(s){ return !s.locked && s.type !== 'pestpac-logout'; });",
    '    const nowJson = JSON.stringify(dataNow);',
    '    if(nowJson === lastSubmittedDataJson) return;',
    "    const oldData = JSON.parse(lastSubmittedDataJson || '[]');",
    '    const cur = p.stepIndex || 0;',
    '    let aboveChanged = oldData.length !== dataNow.length;',
    '    if(!aboveChanged){',
    '      for(let i=0;i<cur && i<dataNow.length;i++){',
    '        if(JSON.stringify(oldData[i]) !== JSON.stringify(dataNow[i])){ aboveChanged = true; break; }',
    '      }',
    '    }',
    '    if(aboveChanged){',
    "      const pick = prompt('Flow shape changed above the current step.\\nContinue from step N (1-'+dataNow.length+')?', String(Math.min(cur+1, dataNow.length)));",
    '      if(pick === null){',
    "        addLiveLog('Flow edits NOT pushed (cancelled) — the worker keeps running the old flow.','warn');",
    '        return;',
    '      }',
    '      const n = Math.max(1, Math.min(dataNow.length, parseInt(pick)||cur+1));',
    "      paneSetExecuting('Reloading flow — repositioning to step '+n);",
    '      currentPoolPause = null;',
    '      lastSubmittedDataJson = nowJson;',
    "      await API.poolRunControl({cmd:'flow-update', steps: steps, cursor: n-1});",
    '    } else {',
    '      lastSubmittedDataJson = nowJson;',
    "      await API.poolRunControl({cmd:'flow-update', steps: steps});",
    "      addLiveLog('Flow updated live — edits apply from the current step forward.','info');",
    '    }',
    '  }catch(e){}',
    '}',
    '',
    'async function paneCursorCmd(cmd, msg){'
  ].join('\n'), 'push fn');
  h = repRx(h, /paneSetPaused\(\);(\r?\n    addLiveLog\('Pool: paused before step ')/,
    'paneSetPaused();\n    maybePushFlowUpdate(p);$1', 'pause hook');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index part 2 done');
} else console.log('index part 2 already done');
