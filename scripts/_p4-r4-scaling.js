// _p4-r4-scaling.js — Phase 4 R4: adaptive worker scaling.
// Hardware "comfortable" cap = min(cores × multiplier, floor(freeGB × 0.5 / 0.35)),
// multiplier tunable (slider may exceed cap — amber). PestPac pressure = median(rolling
// 30 OK durations) / median(first-50 baseline): >1.4 sustained 2 checks → drop ~20%,
// <1.15 → +1 creep (drop fast, recover slow). License logic unchanged but now yields a
// CAP composed in ONE evaluation path (coordEvalScale) on ONE timer. Manual wins over
// auto. Scale-up strictly sequential. Sliders live during the run via pool-set-scaling.
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

// ── coordinator.js ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('coordEvalScale')) {
  c = rep(c, '  _stopSweepFired: false,', [
    '  _stopSweepFired: false,',
    '  // R4 adaptive scaling state',
    '  autoScale: true,       // pressure auto only ever reduces below the manual slider',
    '  manualTarget: 1,       // the Workers slider — manual wins over auto',
    '  scaleMultiplier: 3,    // cores × this = comfortable hardware cap (advisory; amber past it)',
    '  licenseCap: Infinity,  // set by coordLicenseScale each eval when elastic is on',
    '  _durBaseline: [],      // first 50 OK-row durations (median = baseline)',
    '  _durRolling: [],       // last 30 OK-row durations (ring)',
    '  _pressureHigh: 0,      // consecutive high-pressure evaluations',
    '  pressure: null,',
    "  capReason: 'manual',"
  ].join('\n'), 'COORD fields');
  c = rep(c, 'const newTarget = Math.max(1, Math.min(COORD.workers.size + headroom, hwCap, MAX_WORKERS_HARD_CEILING));',
    'const newTarget = Math.max(1, COORD.workers.size + headroom); // R4: pure license cap; composition happens in coordEvalScale', 'license target');
  c = repRx(c, /    COORD\.desiredWorkers = newTarget;\r?\n    await coordScaleTo\(newTarget\);/, [
    '    // R4: license math yields a CAP; the ONE evaluation path (coordEvalScale) composes',
    '    // it with pressure + the manual slider and does the actual scaling.',
    '    COORD.licenseCap = newTarget;'
  ].join('\n'), 'license tail');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator part 1 done');
} else console.log('coordinator part 1 already done');

// coordinator part 2: pressure collection, eval fn, sequential ramp, payload, export
c = fs.readFileSync(cp, 'utf8');
if (!c.includes('_median')) {
  c = rep(c, "if(job){ job.done++; if(msg.status==='ok'||msg.status==='ok (retry)') job.ok++; else job.err++; }", [
    "if(job){ job.done++; if(msg.status==='ok'||msg.status==='ok (retry)') job.ok++; else job.err++; }",
    '      // R4: collect OK-row durations for PestPac-pressure sensing.',
    "      if(String(msg.status||'').indexOf('ok')===0 && Number.isFinite(msg.durationMs)){",
    '        if(COORD._durBaseline.length < 50) COORD._durBaseline.push(msg.durationMs);',
    '        COORD._durRolling.push(msg.durationMs);',
    '        if(COORD._durRolling.length > 30) COORD._durRolling.shift();',
    '      }'
  ].join('\n'), 'pressure collect');
  c = rep(c, 'async function coordLicenseScale(profileId, buffer, hwCap){', [
    "function _median(a){ if(!a || !a.length) return null; const s2=[...a].sort((x,y)=>x-y); const m=Math.floor(s2.length/2); return s2.length%2 ? s2[m] : (s2[m-1]+s2[m])/2; }",
    '',
    '// R4: the ONE evaluation path — composes license cap (elastic), PestPac pressure, and',
    '// the manual slider. Manual wins over auto: auto only ever reduces below the slider.',
    '// Pressure = median(last 30 OK rows)/median(first 50): >1.4 sustained 2 checks → drop',
    '// ~20% of live workers; 1.15–1.4 → hold; <1.15 → creep back +1 per tick (drop fast,',
    '// recover slow). Changes apply at row boundaries (scale-down drains; ramp is sequential).',
    'async function coordEvalScale(){',
    '  if(!COORD.active || COORD.stopping) return;',
    '  if(COORD.elasticParams){',
    '    try{ await coordLicenseScale(COORD.elasticParams.licenseProfileId, COORD.elasticParams.licenseBuffer, COORD.elasticParams.hwCap); }catch(e){}',
    '  } else COORD.licenseCap = Infinity;',
    '  let target = Math.max(1, Math.min(parseInt(COORD.manualTarget) || 1, MAX_WORKERS_HARD_CEILING));',
    "  let reason = 'manual';",
    "  if(Number.isFinite(COORD.licenseCap) && COORD.licenseCap < target){ target = COORD.licenseCap; reason = 'license'; }",
    '  if(COORD.autoScale){',
    '    const base = COORD._durBaseline.length >= 50 ? _median(COORD._durBaseline) : null;',
    '    const roll = COORD._durRolling.length >= 30 ? _median(COORD._durRolling) : null;',
    '    if(base && roll){',
    '      COORD.pressure = Math.round((roll / base) * 100) / 100;',
    '      if(COORD.pressure > 1.4) COORD._pressureHigh++; else COORD._pressureHigh = 0;',
    '      if(COORD._pressureHigh >= 2){',
    '        const dropped = Math.max(1, Math.floor(COORD.workers.size * 0.8));',
    "        if(dropped < target){ target = dropped; reason = 'pressure'; }",
    '        COORD._pressureHigh = 0;',
    '      } else if(COORD.pressure >= 1.15){',
    '        const hold = Math.max(1, COORD.workers.size);',
    "        if(hold < target){ target = hold; reason = 'pressure-hold'; }",
    '      } else if(COORD.workers.size < target){',
    "        const creep = COORD.workers.size + 1;",
    "        if(creep < target){ target = creep; reason = reason === 'manual' ? 'recovering' : reason; }",
    '      }',
    '    }',
    '  }',
    '  COORD.capReason = reason;',
    '  COORD.desiredWorkers = target;',
    '  await coordScaleTo(target);',
    '  coordEmitStatus();',
    '}',
    '',
    'async function coordLicenseScale(profileId, buffer, hwCap){'
  ].join('\n'), 'eval fn');
  c = repRx(c, /(    const canSpawn = Math\.min\(target - live, Math\.max\(0, totalRemaining\)\);)\r?\n    for \(let i = 0; i < canSpawn; i\+\+\) await coordSpawnWorker\(\);/,
    '$1\n' + [
    '    // R4: strictly sequential ramp — each worker must log in and pull its first row',
    "    // (status 'running') before the next spawns. 90s per-worker ramp budget; a worker",
    '    // that dies or finishes during ramp releases the loop immediately.',
    '    for (let i = 0; i < canSpawn; i++) {',
    '      const _id = await coordSpawnWorker();',
    '      if (!_id) break;',
    '      const _t0 = Date.now();',
    '      while (Date.now() - _t0 < 90000) {',
    '        const _w = COORD.workers.get(_id);',
    '        if (!_w) break;',
    "        if (_w.status === 'running' || _w.status === 'shut-down' || _w.status === 'error' || _w.status === 'done') break;",
    '        await new Promise(rs => setTimeout(rs, 500));',
    '      }',
    '    }'
  ].join('\n'), 'sequential ramp');
  c = rep(c, ' desiredWorkers: COORD.desiredWorkers,',
    ' desiredWorkers: COORD.desiredWorkers, pressure: COORD.pressure, capReason: COORD.capReason, manualTarget: COORD.manualTarget, licenseCap: Number.isFinite(COORD.licenseCap) ? COORD.licenseCap : null,', 'status payload');
  c = repRx(c, /(return \{ COORD, coordJournalPath[^\n]*?)( \};)/, '$1, coordEvalScale$2', 'export');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator part 2 done');
} else console.log('coordinator part 2 already done');

// ── main.js ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('pool-set-scaling')) {
  // a) new comfortable-cap formula (multiplier param; advisory)
  m = repRx(m, /function computeHardwareCap\(\) \{[\s\S]*?\r?\n\}/, [
    '// R4 "comfortable" hardware cap: min(cores × multiplier, floor(freeGB × 0.5 / 0.35GB)).',
    '// The multiplier is the tunable slider (default 3). ADVISORY only — the Workers slider',
    '// may deliberately exceed it (UI turns amber past the cap). Old formula (0.70×freeRAM/',
    '// 150MB, cores×6) retired with R4.',
    'function computeHardwareCap(mult) {',
    '  try {',
    '    const freeGB = os.freemem() / (1024 * 1024 * 1024);',
    '    const cpus = (os.cpus() || []).length || 2;',
    '    const m2 = (mult && isFinite(mult)) ? Math.max(1, mult) : 3;',
    '    return Math.max(1, Math.min(Math.round(cpus * m2), Math.floor((freeGB * 0.5) / 0.35), MAX_WORKERS_HARD_CEILING));',
    '  } catch (e) {',
    '    return 1; // safe fallback',
    '  }',
    '}'
  ].join('\n'), 'cap formula');
  // b) callers pass the live multiplier
  let ncall = 0;
  m = m.replace(/computeHardwareCap\(\)/g, () => { ncall++; return 'computeHardwareCap(COORD.scaleMultiplier)'; });
  if (ncall !== 6) throw new Error('caller count: expected 6, got ' + ncall);
  // c) pool-start: params + scaling state; manual clamp loses hwCap (slider may exceed cap)
  m = rep(m, "ipcMain.handle('pool-start', async (_, { workerCount, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin, setupScope, startMode, diagnosticCapture, captureBucketCap }) => {",
    "ipcMain.handle('pool-start', async (_, { workerCount, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin, setupScope, startMode, diagnosticCapture, captureBucketCap, scaleMultiplier }) => {", 'start params');
  m = rep(m, '  let target = Math.max(1, Math.min(_modeWorkerCount, MAX_WORKERS_HARD_CEILING, hwCap));', [
    '  // R4: scaling state. The manual slider is authoritative (manual wins over auto) and',
    '  // may deliberately exceed the comfortable hardware cap — so hwCap is out of this clamp.',
    '  COORD.manualTarget = Math.max(1, Math.min(parseInt(workerCount) || 1, MAX_WORKERS_HARD_CEILING));',
    '  COORD.scaleMultiplier = Math.max(1, parseInt(scaleMultiplier) || 3);',
    '  COORD.autoScale = true;',
    '  COORD.licenseCap = Infinity;',
    '  COORD._durBaseline = []; COORD._durRolling = []; COORD._pressureHigh = 0;',
    "  COORD.pressure = null; COORD.capReason = 'manual';",
    '  COORD.hwCapAdvisory = computeHardwareCap(COORD.scaleMultiplier);',
    '  let target = Math.max(1, Math.min(_modeWorkerCount, MAX_WORKERS_HARD_CEILING));'
  ].join('\n'), 'start clamp+state');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main part a-c done');
} else console.log('main already done');

// main part d-i: timers, set-workers, resume, new IPC, destructure
m = fs.readFileSync(mp, 'utf8');
if (!m.includes("ipcMain.handle('pool-set-scaling'")) {
  // d) pool-start timer: ONE evaluation timer, elastic or not (still step-gated per D4)
  m = repRx(m, /  if \(elastic && licenseProfileId && COORD\.startMode !== 'step' && COORD\.startMode !== 'step-row'\) \{\r?\n    COORD\.licenseTimer = setInterval\(\(\) => coordLicenseScale\(licenseProfileId, licenseBuffer, hwCap\), Math\.max\(1, parseInt\(licenseIntervalMin\) \|\| 5\) \* 60 \* 1000\);\r?\n  \}/, [
    '  // R4: ONE evaluation timer — coordEvalScale composes license cap (when elastic),',
    '  // PestPac pressure, and the manual slider. Runs for every non-step pool so pressure',
    '  // sensing works without elastic. Still gated off in step modes (D4); Release starts it.',
    "  if (COORD.startMode !== 'step' && COORD.startMode !== 'step-row') {",
    '    COORD.licenseTimer = setInterval(() => coordEvalScale(), Math.max(1, parseInt(licenseIntervalMin) || 2) * 60 * 1000);',
    '  }'
  ].join('\n'), 'start timer');
  // e) release path: same ONE timer; manual target from the stored startModeTarget
  m = repRx(m, /    \/\/ Phase 3 \(D4\): start the elastic license timer now that the user has Released\.\r?\n    if \(COORD\.elasticParams && !COORD\.licenseTimer\) \{\r?\n      const ep = COORD\.elasticParams;\r?\n      COORD\.licenseTimer = setInterval\(\(\) => coordLicenseScale\(ep\.licenseProfileId, ep\.licenseBuffer, ep\.hwCap\), ep\.intervalMs\);\r?\n    \}\r?\n    const tgt = \(COORD\.startModeTarget && COORD\.startModeTarget\.workers\) \|\| 1;\r?\n    const hwCap = computeHardwareCap\(COORD\.scaleMultiplier\);\r?\n    COORD\.desiredWorkers = Math\.max\(1, Math\.min\(tgt, MAX_WORKERS_HARD_CEILING, hwCap\)\);/, [
    '    // R4 (D4 gate): start the ONE evaluation timer now that the user has Released.',
    '    if (!COORD.licenseTimer) {',
    '      const _iv = (COORD.elasticParams && COORD.elasticParams.intervalMs) || 2 * 60 * 1000;',
    '      COORD.licenseTimer = setInterval(() => coordEvalScale(), _iv);',
    '    }',
    '    const tgt = (COORD.startModeTarget && COORD.startModeTarget.workers) || 1;',
    '    COORD.manualTarget = Math.max(1, Math.min(tgt, MAX_WORKERS_HARD_CEILING));',
    '    COORD.desiredWorkers = COORD.manualTarget;'
  ].join('\n'), 'release timer');
  // f) pool-set-workers: manual slider path — no hwCap clamp; track manualTarget
  m = repRx(m, /const target = Math\.max\(0, Math\.min\(parseInt\(workerCount\) \|\| 0, MAX_WORKERS_HARD_CEILING, hwCap\)\);/,
    'const target = Math.max(0, Math.min(parseInt(workerCount) || 0, MAX_WORKERS_HARD_CEILING)); // R4: slider may exceed the (advisory) hardware cap\n  COORD.manualTarget = Math.max(1, target || 1);', 'set-workers clamp');
  // g) resume path: clamp + modernized timer (kept elastic-gated structurally; noted in TODO)
  m = repRx(m, /let target = Math\.max\(1, Math\.min\(parseInt\(workerCount\) \|\| 1, MAX_WORKERS_HARD_CEILING, hwCap, Math\.max\(1, totalRemaining\)\)\);/,
    'let target = Math.max(1, Math.min(parseInt(workerCount) || 1, MAX_WORKERS_HARD_CEILING, Math.max(1, totalRemaining)));\n  COORD.manualTarget = Math.max(1, Math.min(parseInt(workerCount) || 1, MAX_WORKERS_HARD_CEILING));\n  COORD._durBaseline = []; COORD._durRolling = []; COORD._pressureHigh = 0; COORD.pressure = null; COORD.licenseCap = Infinity;', 'resume clamp');
  m = repRx(m, /COORD\.licenseTimer = setInterval\(\(\) => coordLicenseScale\(licenseProfileId, licenseBuffer, hwCap\), Math\.max\(1, parseInt\(licenseIntervalMin\) \|\| 5\) \* 60 \* 1000\);/,
    'COORD.licenseTimer = setInterval(() => coordEvalScale(), Math.max(1, parseInt(licenseIntervalMin) || 2) * 60 * 1000);', 'resume timer');
  // h) live scaling IPC
  m = rep(m, "ipcMain.handle('pool-set-workers'", [
    '// R4: live scaling-settings updates from the sidebar sliders. Applies mid-run; changes',
    '// take effect immediately via an evaluation when the pool is active (non-step).',
    "ipcMain.handle('pool-set-scaling', async (_, d) => {",
    '  d = d || {};',
    '  if (d.workers != null) COORD.manualTarget = Math.max(1, Math.min(MAX_WORKERS_HARD_CEILING, parseInt(d.workers) || 1));',
    '  if (d.autoScale != null) COORD.autoScale = !!d.autoScale;',
    '  if (d.multiplier != null) { COORD.scaleMultiplier = Math.max(1, parseInt(d.multiplier) || 3); COORD.hwCapAdvisory = computeHardwareCap(COORD.scaleMultiplier); }',
    '  if (d.intervalMin != null && COORD.licenseTimer) {',
    '    clearInterval(COORD.licenseTimer);',
    '    COORD.licenseTimer = setInterval(() => coordEvalScale(), Math.max(1, parseInt(d.intervalMin) || 2) * 60 * 1000);',
    '  }',
    "  if (COORD.active && COORD.startMode !== 'step' && COORD.startMode !== 'step-row') { try { await coordEvalScale(); } catch (e) {} }",
    '  return { ok: true, hwCap: COORD.hwCapAdvisory || computeHardwareCap(COORD.scaleMultiplier) };',
    '});',
    '',
    "ipcMain.handle('pool-set-workers'"
  ].join('\n'), 'set-scaling ipc');
  // i) destructure the new export
  m = rep(m, 'coordScaleTo, coordLicenseScale,', 'coordScaleTo, coordLicenseScale, coordEvalScale,', 'destructure');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main part d-i done');
} else console.log('main d-i already done');

// ── preload.js ──
const pp = path.join(root, 'src', 'preload.js');
let p = fs.readFileSync(pp, 'utf8');
if (!p.includes('poolSetScaling')) {
  p = rep(p, "poolSetWorkers:      (d)     => ipcRenderer.invoke('pool-set-workers', d),",
    "poolSetWorkers:      (d)     => ipcRenderer.invoke('pool-set-workers', d),\n  poolSetScaling:      (d)     => ipcRenderer.invoke('pool-set-scaling', d), // R4 live sliders", 'preload entry');
  fs.writeFileSync(pp, p, 'utf8');
  console.log('preload done');
} else console.log('preload already done');

// ── index.html: sliders, status line, live handler ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('poolScalingLive')) {
  // workers number input -> slider block (balanced replacement of the whole row)
  h = repRx(h, /    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">\r?\n      <span style="font-size:11px;color:var\(--t3\)">Workers<\/span>\r?\n      <input id="poolWorkerCount" type="number"[^\n]*\r?\n    <\/div>/, [
    '    <div style="display:flex;flex-direction:column;gap:2px">',
    '      <div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;color:var(--t3)">Workers</span><span id="poolWorkersVal" style="font-size:11px;font-weight:700;color:var(--t1)">4</span></div>',
    '      <input id="poolWorkerCount" type="range" min="1" max="150" value="4" step="1" style="width:100%" oninput="poolScalingLive()" title="Manual worker target. Manual wins over auto - auto-scale only ever reduces below this. Amber = beyond the comfortable hardware cap (deliberate overdrive).">',
    '    </div>',
    '    <div style="display:flex;flex-direction:column;gap:2px">',
    '      <div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;color:var(--t3)" title="Comfortable hardware cap = CPU cores x this multiplier, bounded by free RAM. Advisory only.">HW multiplier</span><span id="poolScaleMultVal" style="font-size:11px;font-weight:700;color:var(--t1)">3</span></div>',
    '      <input id="poolScaleMult" type="range" min="1" max="8" value="3" step="1" style="width:100%" oninput="poolScalingLive()">',
    '    </div>'
  ].join('\n'), 'workers+mult sliders');
  // interval number -> slider block (always enabled; one eval timer)
  h = repRx(h, /    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">\r?\n      <span id="poolIntervalLbl"[^\n]*\r?\n      <input id="poolLicInterval" type="number"[^\n]*\r?\n      <span id="poolIntervalUnit"[^\n]*\r?\n    <\/div>/, [
    '    <div style="display:flex;flex-direction:column;gap:2px">',
    '      <div style="display:flex;align-items:center;justify-content:space-between"><span id="poolIntervalLbl" style="font-size:11px;color:var(--t3)" title="How often the pool re-evaluates scaling: license check (when Auto-scale is on) + PestPac pressure. Minutes.">Eval every (min)</span><span id="poolLicIntervalVal" style="font-size:11px;font-weight:700;color:var(--t1)">2</span></div>',
    '      <input id="poolLicInterval" type="range" min="1" max="10" value="2" step="1" style="width:100%" oninput="poolScalingLive()">',
    '      <span id="poolIntervalUnit" style="display:none">min</span>',
    '    </div>'
  ].join('\n'), 'interval slider');
  // scale status readout above the Run button
  h = rep(h, '    <button class="tbtn grn" id="poolRunBtn"',
    '    <div id="scaleStatus" style="font-size:10px;color:var(--t3);line-height:1.5"></div>\n    <button class="tbtn grn" id="poolRunBtn"', 'scaleStatus div');
  // live handler + amber + simplified autoscale toggle
  h = repRx(h, /function poolToggleAutoScale\(\)\{[\s\S]*?\r?\n\}/, [
    '// R4: live scaling updates. Debounced push of slider values to the coordinator; applies',
    '// mid-run. The response carries the comfortable hardware cap for the amber styling.',
    'let _scaleT=null, _hwCapCache=null;',
    'function poolScalingLive(){',
    "  const w=document.getElementById('poolWorkerCount'), wl=document.getElementById('poolWorkersVal');",
    "  const m=document.getElementById('poolScaleMult'), ml=document.getElementById('poolScaleMultVal');",
    "  const iv=document.getElementById('poolLicInterval'), il=document.getElementById('poolLicIntervalVal');",
    '  if(wl&&w) wl.textContent=w.value;',
    '  if(ml&&m) ml.textContent=m.value;',
    '  if(il&&iv) il.textContent=iv.value;',
    '  poolScalingAmber();',
    '  clearTimeout(_scaleT);',
    '  _scaleT=setTimeout(async function(){',
    '    if(!API.poolSetScaling) return;',
    '    try{',
    '      const r=await API.poolSetScaling({ workers: parseInt((w||{}).value)||1, multiplier: parseInt((m||{}).value)||3, intervalMin: parseInt((iv||{}).value)||2 });',
    '      if(r&&r.hwCap){ _hwCapCache=r.hwCap; poolScalingAmber(); }',
    '    }catch(e){}',
    '  }, 300);',
    '}',
    'function poolScalingAmber(){',
    "  const w=document.getElementById('poolWorkerCount'), wl=document.getElementById('poolWorkersVal');",
    '  if(!w||!wl||!_hwCapCache) return;',
    '  const over=parseInt(w.value)>_hwCapCache;',
    "  wl.style.color=over?'var(--amber)':'var(--t1)';",
    "  wl.title=over?('Beyond the comfortable hardware cap ('+_hwCapCache+') - deliberate overdrive'):('Comfortable cap: '+_hwCapCache);",
    '}',
    'function poolToggleAutoScale(){',
    '  // R4: the eval interval applies to every pool (pressure sensing runs regardless);',
    '  // the Auto-scale checkbox now only controls the LICENSE part of each evaluation.',
    '  poolScalingLive();',
    '}'
  ].join('\n'), 'live handler');
  // scale readout fed from pool-status
  h = rep(h, 'function renderCoordStatus(st){', [
    'function renderCoordStatus(st){',
    '  // R4: live scaling readout — e.g. "8 live / target 12 (cap: license) · pressure 1.1".',
    '  try{',
    "    const _se=document.getElementById('scaleStatus');",
    '    if(_se){',
    '      if(st && st.active){',
    "        let _t=(st.workers?st.workers.length:0)+' live / target '+(st.desiredWorkers!=null?st.desiredWorkers:'?')+' (cap: '+(st.capReason||'manual')+')';",
    "        if(st.pressure!=null) _t+=' \\u00b7 pressure '+st.pressure;",
    "        if(st.licenseCap!=null) _t+=' \\u00b7 lic cap '+st.licenseCap;",
    '        _se.textContent=_t;',
    "      } else _se.textContent='';",
    '    }',
    '  }catch(e){}'
  ].join('\n'), 'status readout');
  // pool-start payload carries the multiplier
  h = rep(h, 'const res = await API.poolStart({ workerCount:n, elastic, licenseProfileId: elastic?activeProfileId:null, licenseBuffer:licBuffer, licenseIntervalMin:licInterval, setupScope, startMode, diagnosticCapture, captureBucketCap });',
    "const res = await API.poolStart({ workerCount:n, elastic, licenseProfileId: elastic?activeProfileId:null, licenseBuffer:licBuffer, licenseIntervalMin:licInterval, setupScope, startMode, diagnosticCapture, captureBucketCap, scaleMultiplier: parseInt((document.getElementById('poolScaleMult')||{}).value)||3 });", 'start payload');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done');
} else console.log('index already done');

// clamp updates: reads capped at 100 pre-R4; the slider goes to 150
h = fs.readFileSync(hp, 'utf8');
let nclamp = 0;
h = h.replace(/Math\.min\(100, parseInt\(\(document\.getElementById\('poolWorkerCount'\)\|\|\{\}\)\.value\)\|\|4\)/g, () => { nclamp++; return "Math.min(150, parseInt((document.getElementById('poolWorkerCount')||{}).value)||4)"; });
h = h.replace(/Math\.min\(100, parseInt\(document\.getElementById\('poolWorkerCount'\)\.value\)\|\|1\)/g, () => { nclamp++; return "Math.min(150, parseInt(document.getElementById('poolWorkerCount').value)||1)"; });
if (nclamp) { fs.writeFileSync(hp, h, 'utf8'); }
console.log('worker-count read clamps updated:', nclamp);
