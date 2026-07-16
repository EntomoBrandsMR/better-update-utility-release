// _303-ui-js.js — wire the new controls. Rewrites poolScalingLive/Amber, adds
// poolResetDefaults, updates the poolStart/poolResume payloads, the R14 flow save/load,
// and poolFillAuto. Every old id reference must go or it silently reads null.
'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'index.html');
let h = fs.readFileSync(p, 'utf8');
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function rep(from, to, label) {
  const rx = new RegExp(from.split('\n').map(esc).join('\\r?\\n'), 'g');
  const hits = h.match(rx);
  if (!hits) throw new Error('anchor missing: ' + label);
  if (hits.length > 1) throw new Error('NOT UNIQUE (' + hits.length + '): ' + label);
  h = h.replace(rx, () => to);
}
if (h.includes('function poolResetDefaults')) { console.log('already done'); process.exit(0); }

const G = "function _pv(id, dflt){ const el = document.getElementById(id); const n = parseInt((el||{}).value); return isNaN(n) ? dflt : n; }";

// ── poolScalingLive: send the new knobs ──
rep(`  const w=document.getElementById('poolWorkerCount'), wl=document.getElementById('poolWorkersVal');
  const m=document.getElementById('poolScaleMult'), ml=document.getElementById('poolScaleMultVal');
  const iv=document.getElementById('poolLicInterval'), il=document.getElementById('poolLicIntervalVal');
  if(wl&&w) wl.textContent=w.value;
  if(ml&&m) ml.textContent=m.value;
  if(il&&iv) il.textContent=iv.value;`,
`  // v3.0.3: Max/Start are boxes, Hardware/PestPac are 1-5 sliders (4 = 100%).
  const hw=document.getElementById('poolHwSlider'), hwl=document.getElementById('poolHwSliderVal');
  const pp=document.getElementById('poolPpSlider'), ppl=document.getElementById('poolPpSliderVal');
  if(hwl&&hw) hwl.textContent=hw.value;
  if(ppl&&pp) ppl.textContent=pp.value;`, 'live labels');

rep(`      const r=await API.poolSetScaling({ workers: parseInt((w||{}).value)||1, multiplier: parseInt((m||{}).value)||3, intervalMin: parseInt((iv||{}).value)||2 });`,
`      const r=await API.poolSetScaling({
        maxWorkers:   _pv('poolMaxWorkers', 150),
        startWorkers: _pv('poolStartWorkers', 9),
        hwSlider:     _pv('poolHwSlider', 4),
        ppSlider:     _pv('poolPpSlider', 4),
        intervalMin:  _pv('poolLicInterval', 2),
        autoScale:    !!(document.getElementById('poolElastic')||{}).checked,
      });`, 'live send');

// ── amber: compare Max against the EFFECTIVE hw cap, and use the fresh value main returns ──
rep(`  const w=document.getElementById('poolWorkerCount'), wl=document.getElementById('poolWorkersVal');`,
`  const w=document.getElementById('poolMaxWorkers'), wl=document.getElementById('poolMaxWorkers');`, 'amber ids');

// ── poolFillAuto ──
rep("  const inp=document.getElementById('poolWorkerCount');", "  const inp=document.getElementById('poolStartWorkers');", 'fillAuto');

// ── poolRunClick payload ──
rep(`  const n = Math.max(1, Math.min(150, parseInt(document.getElementById('poolWorkerCount').value)||1));`,
`    const n = Math.max(1, Math.min(150, _pv('poolStartWorkers', 9)));`, 'run n');
rep("const res = await API.poolStart({ workerCount:n, elastic,",
    "const res = await API.poolStart({ workerCount:n, startWorkers:n, maxWorkers:_pv('poolMaxWorkers',150), hwSlider:_pv('poolHwSlider',4), ppSlider:_pv('poolPpSlider',4), elastic,", 'start payload');

// ── resume payload ──
rep(`  const n = Math.max(1, Math.min(150, parseInt((document.getElementById('poolWorkerCount')||{}).value)||4));`,
`  const n = Math.max(1, Math.min(150, _pv('poolStartWorkers', 9)));`, 'resume n');
rep('const res = await API.poolResume({ poolId:p.poolId, workerCount:n, elastic,',
    "const res = await API.poolResume({ poolId:p.poolId, workerCount:n, startWorkers:n, maxWorkers:_pv('poolMaxWorkers',150), hwSlider:_pv('poolHwSlider',4), ppSlider:_pv('poolPpSlider',4), elastic,", 'resume payload');

// ── R14 flow save ──
rep(`      workers: parseInt((document.getElementById('poolWorkerCount')||{}).value) || 1,
      scaleMult: parseInt((document.getElementById('poolScaleMult')||{}).value) || 3,`,
`      maxWorkers: _pv('poolMaxWorkers', 150),
      startWorkers: _pv('poolStartWorkers', 9),
      hwSlider: _pv('poolHwSlider', 4),
      ppSlider: _pv('poolPpSlider', 4),`, 'flow save');

// ── R14 flow load ──
rep(`    _set('poolWorkerCount', ps.workers != null ? ps.workers : 1);
    _set('poolScaleMult', ps.scaleMult != null ? ps.scaleMult : 3);`,
`    _set('poolMaxWorkers', ps.maxWorkers != null ? ps.maxWorkers : 150);
    _set('poolHwSlider', ps.hwSlider != null ? ps.hwSlider : 4);
    _set('poolPpSlider', ps.ppSlider != null ? ps.ppSlider : 4);
    // v3.0.3: a flow that has LEARNED its best worker count replaces the Start default.
    // Matthew: "that flow knows whats best for it". lastGoodWorkers is written in the
    // background by the pool and is NEVER carried in the renderer's flow object.
    _set('poolStartWorkers', data.lastGoodWorkers != null ? data.lastGoodWorkers
          : (ps.startWorkers != null ? ps.startWorkers : 9));`, 'flow load');

// ── new: reset defaults + the _pv helper ──
rep('function poolScalingLive(){', [
  G,
  '// v3.0.3: in the R4 doc, never built. Restores the agreed defaults.',
  'function poolResetDefaults(){',
  "  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=v; };",
  "  set('poolMaxWorkers',150); set('poolStartWorkers',9); set('poolHwSlider',4);",
  "  set('poolPpSlider',4); set('poolLicBuffer',10); set('poolLicInterval',2);",
  "  const el=document.getElementById('poolDiagCap'); if(el) el.value=10;",
  '  poolScalingLive();',
  '}',
  'function poolScalingLive(){',
].join('\n'), 'reset + helper');
fs.writeFileSync(p, h, 'utf8');
console.log('renderer JS wired');
