// _p4-r5a-debugger.js — Phase 4 R5a: step-debugger core.
// Worker gains cursor commands at the step pause: redo-step (re-execute previous, pause
// here again), last-step (cursor back one, NO execution), skip-step, restart-row; skip
// row = existing next-row (error, reason manual via R1 mapping). Renderer pane becomes
// PERSISTENT for the whole step session (2.2.9 hid it during execution — stalls were
// invisible): buttons disable while a step executes, a live status line + elapsed ticker
// shows what's running. R5b (live flow reload + fresh-read at launch) ships separately.
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

// ── worker.js: pause commands + cursor loop ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('_autoOnce')) {
  w = repRx(w, /    case 'next-step':\r?\n    case 'next-row':/, [
    "    // R5 debugger cursor commands — all just release the pending pause with their name;",
    '    // the step loop interprets them.',
    "    case 'redo-step':",
    "    case 'last-step':",
    "    case 'skip-step':",
    "    case 'restart-row':",
    "    case 'next-step':",
    "    case 'next-row':"
  ].join('\n'), 'line handler cases');
  w = rep(w, "    row.__stepTrail = []; // reset on retry too",
    "    row.__stepTrail = []; // reset on retry too\n    let _autoOnce = false; // R5: redo-step executes the repositioned step without pausing first", 'autoOnce decl');
  w = repRx(w, /    for\(let si=0;si<DATA_STEPS\.length;si\+\+\)\{\r?\n      const s=DATA_STEPS\[si\];/,
    '    for(let si=0;si<DATA_STEPS.length;si++){\n      let s=DATA_STEPS[si];', 's let');
  w = rep(w, "      if(currentMode === 'step' && s.type !== 'dialog'){",
    [
      '      const _skipPause = _autoOnce; _autoOnce = false;',
      "      if(currentMode === 'step' && s.type !== 'dialog' && !_skipPause){"
    ].join('\n'), 'pause gate');
  w = repRx(w, /        if\(cmd === 'next-row'\) throw new Error\('__NEXT_ROW__'\);\r?\n        \/\/ 'next-step' \/ 'run-all' \/ 'auto' fall through\./, [
      "        if(cmd === 'next-row') throw new Error('__NEXT_ROW__');",
      '        // R5 debugger cursor commands (we are paused BEFORE executing step si):',
      '        //   skip-step: do not execute si; pause at si+1',
      '        //   last-step: cursor back one, NO execution (no undo of page state); pause at si-1',
      '        //   restart-row: cursor to step 1, trail cleared; pause there (page state untouched)',
      '        //   redo-step: re-execute the previously executed step (si-1), then pause here again',
      "        if(cmd === 'skip-step'){",
      "          row.__stepTrail.push({ index: si, label: s._label || s.type, type: s.type, ok: true, note: 'skipped by user', ms: 0, ts: new Date().toISOString() });",
      "          emit({type:'log', message:'Step '+(si+1)+' skipped by user'});",
      '          continue;',
      '        }',
      "        if(cmd === 'last-step'){ si = Math.max(-1, si - 2); continue; }",
      "        if(cmd === 'restart-row'){ done.length = 0; row.__stepTrail = []; si = -1; emit({type:'log', message:'Row '+rowNum+' restarted from step 1 by user'}); continue; }",
      "        if(cmd === 'redo-step'){ si = Math.max(-1, si - 2); _autoOnce = true; continue; }",
      "        // 'next-step' / 'run-all' / 'auto' fall through.",
      '        s = DATA_STEPS[si] || s; // rebind (cheap now; load-bearing once R5b live reload lands)'
    ].join('\n'), 'cursor commands');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker done');
} else console.log('worker already done');

// ── main.js: whitelist ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes("'redo-step'")) {
  m = rep(m, "if (!['next-step','next-row','run-all','stop','mode'].includes(cmd)",
    "if (!['next-step','next-row','run-all','stop','mode','redo-step','last-step','skip-step','restart-row'].includes(cmd)", 'whitelist');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');

// ── index.html: persistent pane, exec state, new buttons ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('stepPaneSticky')) {
  // ids + exec status line in the panel header
  h = rep(h, '<div style="font-size:13px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.04em">⏸ Paused</div>',
    '<div id="pauseTitle" style="font-size:13px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.04em">⏸ Paused</div>', 'title id');
  h = rep(h, '<div id="pausePos" style="font-size:12px;color:var(--t2)"></div>',
    '<div id="pausePos" style="font-size:12px;color:var(--t2)"></div>\n      <div id="pauseExec" style="font-size:12px;color:var(--t2);display:none;font-family:monospace"></div>', 'exec line');
  // new debugger buttons after Next step
  h = repRx(h, /(<button[^\n]*id="paneNextStepBtn"[^\n]*<\/button>)/, [
    '$1',
    '      <button class="btn sm" id="paneRedoStepBtn" onclick="paneCursorCmd(\'redo-step\',\'Re-running previous step\')" title="Re-execute the previously executed step, then pause here again">Redo step</button>',
    '      <button class="btn sm" id="paneLastStepBtn" onclick="paneCursorCmd(\'last-step\',\'Moving cursor back\')" title="Move the cursor back one step WITHOUT executing anything (page state is not undone)">Last step</button>',
    '      <button class="btn sm" id="paneSkipStepBtn" onclick="paneCursorCmd(\'skip-step\',\'Skipping step\')" title="Skip this step without executing it">Skip step</button>',
    '      <button class="btn sm" id="paneRestartRowBtn" onclick="paneCursorCmd(\'restart-row\',\'Restarting row\')" title="Restart this row from step 1 (page state is not reset - your eyes decide if that is safe)">Restart row</button>'
  ].join('\n'), 'new buttons');
  h = rep(h, 'id="paneNextRowBtn"', 'id="paneNextRowBtn" title="Skip this row - it is recorded as an error (reason: manual)"', 'skiprow title');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index part 1 done');
} else console.log('index part 1 already done');

// index part 2: sticky semantics, exec state machinery, button handler rewrites, hooks
h = fs.readFileSync(hp, 'utf8');
if (!h.includes('paneSetExecuting')) {
  // machinery, inserted before paneNextStep
  h = rep(h, 'async function paneNextStep(){', [
    '// R5: PERSISTENT step pane. On 2.2.9 the pane vanished while a step executed and only',
    '// reappeared at the next pause — a stalled step was indistinguishable from a dead run.',
    '// Now: sticky from step-mode launch until Stop/Release; buttons DISABLE during execution;',
    '// a live status line + elapsed ticker names what is running so stalls show at a glance.',
    'let stepPaneSticky = false;',
    'let lastPauseEvt = null;',
    'let _paneExecTimer = null, _paneExecStart = 0, _paneExecMsg = \'\';',
    'const PANE_BTN_IDS = [\'paneNextStepBtn\',\'paneRedoStepBtn\',\'paneLastStepBtn\',\'paneSkipStepBtn\',\'paneRestartRowBtn\',\'paneNextRowBtn\',\'paneRunAllBtn\'];',
    'function paneButtonsEnabled(on){',
    '  for(const id of PANE_BTN_IDS){ const b=document.getElementById(id); if(b){ b.disabled=!on; b.style.opacity=on?\'\':\'0.45\'; } }',
    '}',
    'function paneSetExecuting(msg){',
    '  const panel=document.getElementById(\'pausePanel\'); if(panel) panel.style.display=\'\';',
    '  const t=document.getElementById(\'pauseTitle\'); if(t){ t.textContent=\'▶ Running\'; t.style.color=\'var(--blue)\'; }',
    '  const ex=document.getElementById(\'pauseExec\');',
    '  _paneExecMsg = msg || \'Executing\';',
    '  _paneExecStart = Date.now();',
    '  let ctx = \'\';',
    '  if(lastPauseEvt && lastPauseEvt.step){',
    '    ctx = \' · step \'+((lastPauseEvt.stepIndex||0)+1)+\'/\'+(lastPauseEvt.totalSteps||\'?\')+\' · \'+(lastPauseEvt.step.type||\'\')+(lastPauseEvt.step.selector?(\' · \'+String(lastPauseEvt.step.selector).slice(0,60)):\'\');',
    '  }',
    '  if(ex){ ex.style.display=\'\'; ex.textContent=_paneExecMsg+ctx+\' (0s)\'; }',
    '  clearInterval(_paneExecTimer);',
    '  _paneExecTimer = setInterval(function(){',
    '    const e2=document.getElementById(\'pauseExec\');',
    '    if(e2 && e2.style.display!==\'none\'){',
    '      const secs=Math.round((Date.now()-_paneExecStart)/1000);',
    '      e2.textContent=e2.textContent.replace(/ \\(\\d+s\\)$/, \'\')+\' (\'+secs+\'s)\';',
    '      if(secs>=45) e2.style.color=\'var(--amber)\'; // stall suspicion',
    '    }',
    '  }, 1000);',
    '  paneButtonsEnabled(false);',
    '}',
    'function paneSetPaused(){',
    '  const t=document.getElementById(\'pauseTitle\'); if(t){ t.textContent=\'⏸ Paused\'; t.style.color=\'var(--amber)\'; }',
    '  const ex=document.getElementById(\'pauseExec\'); if(ex){ ex.style.display=\'none\'; ex.style.color=\'var(--t2)\'; }',
    '  clearInterval(_paneExecTimer); _paneExecTimer=null;',
    '  paneButtonsEnabled(true);',
    '}',
    'function forceHidePause(){',
    '  stepPaneSticky=false;',
    '  clearInterval(_paneExecTimer); _paneExecTimer=null;',
    '  const panel=document.getElementById(\'pausePanel\');',
    '  if(panel) panel.style.display=\'none\';',
    '}',
    'async function paneCursorCmd(cmd, msg){',
    '  if(!(currentPoolPause && API.poolRunControl)) return;',
    '  paneSetExecuting(msg);',
    '  currentPoolPause = null;',
    '  await API.poolRunControl({cmd:cmd});',
    '}',
    '',
    'async function paneNextStep(){'
  ].join('\n'), 'machinery');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index part 2 done');
} else console.log('index part 2 already done');

// index part 3: button-handler rewrites + sticky hidePause + hooks
h = fs.readFileSync(hp, 'utf8');
if (!h.includes('stepPaneSticky = true;')) {
  h = repRx(h, /async function paneNextStep\(\)\{\r?\n  \/\/ v2\.2\.2 Session 2C: pool step pauses route through poolRunControl\. Single-runner pauses\r?\n  \/\/ route through runControl as before\. currentPoolPause is set by the onPoolPause subscriber\r?\n  \/\/ below when a pool worker emits pause-step \/ pause-row\.\r?\n  if \(currentPoolPause && API\.poolRunControl\) \{\r?\n    await API\.poolRunControl\(\{cmd:'next-step'\}\);\r?\n  \} else if \(API\.runControl\) \{\r?\n    await API\.runControl\(\{runId:currentRunId, cmd:'next-step'\}\);\r?\n  \}\r?\n  currentPoolPause = null;\r?\n  hidePause\(\);\r?\n\}/, [
    'async function paneNextStep(){',
    '  // R5: pool step pauses keep the pane visible — flip to Running, disable, send.',
    '  if (currentPoolPause && API.poolRunControl) {',
    "    paneSetExecuting('Executing step');",
    '    currentPoolPause = null;',
    "    await API.poolRunControl({cmd:'next-step'});",
    '    return;',
    '  } else if (API.runControl) {',
    "    await API.runControl({runId:currentRunId, cmd:'next-step'});",
    '  }',
    '  currentPoolPause = null;',
    '  hidePause();',
    '}'
  ].join('\n'), 'paneNextStep');
  h = repRx(h, /async function paneNextRow\(\)\{\r?\n  if \(currentPoolPause && API\.poolRunControl\) \{\r?\n    await API\.poolRunControl\(\{cmd:'next-row'\}\);\r?\n  \} else if \(API\.runControl\) \{\r?\n    await API\.runControl\(\{runId:currentRunId, cmd:'next-row'\}\);\r?\n  \}\r?\n  currentPoolPause = null;\r?\n  hidePause\(\);\r?\n\}/, [
    'async function paneNextRow(){',
    '  if (currentPoolPause && API.poolRunControl) {',
    "    paneSetExecuting('Skipping row (recorded as error, reason: manual)');",
    '    currentPoolPause = null;',
    "    await API.poolRunControl({cmd:'next-row'});",
    '    return;',
    '  } else if (API.runControl) {',
    "    await API.runControl({runId:currentRunId, cmd:'next-row'});",
    '  }',
    '  currentPoolPause = null;',
    '  hidePause();',
    '}'
  ].join('\n'), 'paneNextRow');
  h = repRx(h, /(  currentRunMode='run-all';\r?\n  currentPoolPause = null;\r?\n)  hidePause\(\);(\r?\n  addLiveLog\('Released — running through to end','info'\);)/,
    '$1  forceHidePause(); // R5: Release ends the step session — the sticky pane goes away$2', 'paneRunAll');
  h = repRx(h, /function hidePause\(\)\s*\{\s*\r?\n\s*const panel=document\.getElementById\('pausePanel'\);\r?\n\s*if\(panel\) panel\.style\.display='none';\r?\n\}/, [
    'function hidePause(){',
    '  // R5: while a step session is live the pane is STICKY — legacy hide requests become',
    '  // the disabled/Running state instead of a vanishing panel (stalls were invisible).',
    '  if(stepPaneSticky) return;',
    "  const panel=document.getElementById('pausePanel');",
    "  if(panel) panel.style.display='none';",
    '}'
  ].join('\n'), 'sticky hidePause');
  h = repRx(h, /(    )showPause\('step', evt\);(\r?\n    addLiveLog\('Pool: paused before step ')/,
    "$1stepPaneSticky = true;\n$1lastPauseEvt = evt;\n$1showPause('step', evt);\n$1paneSetPaused();$2", 'pause hook step');
  h = repRx(h, /(    )showPause\('step-row', evt\);(\r?\n    addLiveLog\('Pool: paused after row ')/,
    "$1stepPaneSticky = true;\n$1lastPauseEvt = evt;\n$1showPause('step-row', evt);\n$1paneSetPaused();$2", 'pause hook row');
  h = repRx(h, /(if\(res && res\.ok===false\)\{ alert\('Could not start pool: '\+\(res\.error\|\|'unknown'\)\); return; \}\r?\n)(  poolUIActive\(true\);)/, [
    '$1',
    '  // R5: in step modes the pane appears AT LAUNCH — worker login was the first invisible',
    '  // stall on 2.2.9. Buttons stay disabled until the first pause arrives.',
    "  const _sm5=(document.getElementById('startModeSel')||{}).value;",
    "  if(_sm5==='step'||_sm5==='step-row'){ stepPaneSticky=true; paneSetExecuting('Starting — worker logging in'); }",
    '$2'
  ].join('\n'), 'launch hook');
  h = rep(h, "  document.getElementById('runStatusMsg').textContent='Pool complete';",
    "  document.getElementById('runStatusMsg').textContent='Pool complete';\n  forceHidePause(); // R5: step session over", 'complete hook');
  h = rep(h, "      } else _se.textContent='';",
    "      } else _se.textContent='';\n      if(st && !st.active && stepPaneSticky) forceHidePause(); // R5: pool died/ended", 'inactive hook');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index part 3 done');
} else console.log('index part 3 already done');
