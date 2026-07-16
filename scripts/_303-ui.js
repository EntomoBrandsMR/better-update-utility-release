// _303-ui.js — rewrite the worker-pool sidebar to the agreed model.
// OUT: "Workers" slider (was target AND ceiling — the thing that made auto pointless) and
//      "HW multiplier" 1-8.
// IN:  Max workers (box, hard lid, LIVE), Start (box, seed only, default 9), Hardware
//      slider 1-5, PestPac slider 1-5 (4 = 100% on both), Reset defaults.
// KEPT verbatim per Matthew: Buffer BOX ("what is present and good the buffer box"),
//      Auto-scale checkbox, and everything south of it. Eval every goes BACK to a box.
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
if (h.includes('poolMaxWorkers')) { console.log('already done'); process.exit(0); }

const BOX = 'width:56px;padding:4px 6px;background:var(--bg2);border:1px solid var(--brd);border-radius:6px;color:var(--t1);font-size:12px';
const ROW = 'display:flex;align-items:center;justify-content:space-between;gap:6px';
const COL = 'display:flex;flex-direction:column;gap:2px';
const HD = 'display:flex;align-items:center;justify-content:space-between';
const LBL = 'font-size:11px;color:var(--t3)';
const VAL = 'font-size:11px;font-weight:700;color:var(--t1)';

// ── replace Workers + HW multiplier with Max / Start / Hardware / PestPac ──
rep(`    <div style="display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;color:var(--t3)">Workers</span><span id="poolWorkersVal" style="font-size:11px;font-weight:700;color:var(--t1)">4</span></div>
      <input id="poolWorkerCount" type="range" min="1" max="150" value="4" step="1" style="width:100%" oninput="poolScalingLive()" title="Manual worker target. Manual wins over auto - auto-scale only ever reduces below this. Amber = beyond the comfortable hardware cap (deliberate overdrive).">
    </div>
    <div style="display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;color:var(--t3)" title="Comfortable hardware cap = CPU cores x this multiplier, bounded by free RAM. Advisory only.">HW multiplier</span><span id="poolScaleMultVal" style="font-size:11px;font-weight:700;color:var(--t1)">3</span></div>
      <input id="poolScaleMult" type="range" min="1" max="8" value="3" step="1" style="width:100%" oninput="poolScalingLive()">
    </div>`,
`    <!-- v3.0.3: Max is a LID, Start is a SEED, the heuristics decide in between. The old
         single "Workers" slider was the target AND the ceiling, so auto could only ever
         subtract from it and never add - which is why none of the scaling code did anything. -->
    <div style="${ROW}">
      <span style="${LBL}" title="Hard ceiling. Nothing may exceed this - not the climb, not hardware, not licenses. Live: lower it below the running worker count and workers drain down to it.">Max workers</span>
      <input id="poolMaxWorkers" type="number" min="1" max="150" value="150" style="${BOX}" oninput="poolScalingLive()" title="Your override. Nothing ever goes above this.">
    </div>
    <div style="${ROW}">
      <span style="${LBL}" title="How many workers to launch with. A seed, NOT a floor - the heuristics may settle below it. A flow that has learned its best count replaces this on load.">Start</span>
      <input id="poolStartWorkers" type="number" min="1" max="150" value="9" style="${BOX}" oninput="poolScalingLive()" title="Initial worker count. Not a floor.">
    </div>
    <div style="${COL}">
      <div style="${HD}"><span style="${LBL}" title="How much of the comfortable hardware cap to use. 4 = 100% (cores x 3, bounded by free RAM). 5 = 125%, deliberate overdrive. Advisory - the pool still obeys Max and licenses.">Hardware</span><span id="poolHwSliderVal" style="${VAL}">4</span></div>
      <input id="poolHwSlider" type="range" min="1" max="5" value="4" step="1" style="width:100%" oninput="poolScalingLive()">
    </div>
    <div style="${COL}">
      <div style="${HD}"><span style="${LBL}" title="How much of the measured PestPac optimum to use. The pool measures OVERALL rows/min and finds where throughput peaks; 4 = run at that peak (100%), 5 = 125% overdrive, lower = deliberately gentler on PestPac.">PestPac</span><span id="poolPpSliderVal" style="${VAL}">4</span></div>
      <input id="poolPpSlider" type="range" min="1" max="5" value="4" step="1" style="width:100%" oninput="poolScalingLive()">
    </div>`, 'max/start/sliders');

// ── eval every: slider -> box (Matthew: "please chage that back to a box") ──
rep(`    <div style="display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;align-items:center;justify-content:space-between"><span id="poolIntervalLbl" style="font-size:11px;color:var(--t3)" title="How often the pool re-evaluates scaling: license check (when Auto-scale is on) + PestPac pressure. Minutes.">Eval every (min)</span><span id="poolLicIntervalVal" style="font-size:11px;font-weight:700;color:var(--t1)">2</span></div>
      <input id="poolLicInterval" type="range" min="1" max="10" value="2" step="1" style="width:100%" oninput="poolScalingLive()">
      <span id="poolIntervalUnit" style="display:none">min</span>
    </div>`,
`    <div style="${ROW}">
      <span id="poolIntervalLbl" style="${LBL}" title="How often the pool re-evaluates: license count (always) and the throughput climb (when Auto-scale is on). This is also the climb's step cadence - the single knob for how twitchy scaling is.">Eval every (min)</span>
      <input id="poolLicInterval" type="number" min="1" max="60" value="2" style="${BOX}" oninput="poolScalingLive()" title="Minutes between evaluations. Also the climb's step rate.">
      <span id="poolIntervalUnit" style="display:none">min</span>
    </div>`, 'eval box');

// ── Reset defaults (in the R4 doc, never built) ──
rep(`    <div id="scaleStatus" style="font-size:10px;color:var(--t3);line-height:1.5"></div>`,
`    <div id="scaleStatus" style="font-size:10px;color:var(--t3);line-height:1.5"></div>
    <button class="tbtn" onclick="poolResetDefaults()" style="width:100%;font-size:11px" title="Restore Max 150, Start 9, Hardware 4, PestPac 4, Buffer 10, Eval 2 min">Reset defaults</button>`, 'reset defaults');
fs.writeFileSync(p, h, 'utf8');
console.log('sidebar rewritten');
