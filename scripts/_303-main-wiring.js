// _303-main-wiring.js â€” rewire main.js to the agreed model.
//   workerCount -> startWorkers (the SEED, not a target, not a floor)
//   NEW maxWorkers            -> the user's LIVE lid
//   NEW hwSlider / ppSlider   -> 1-5, 4 = 100% of each heuristic
//   elastic                   -> autoScale (the throughput climb on/off) â€” NOT license
// Deletes the pressure state resets (fields are gone) and the hardcoded autoScale = true,
// which meant the Auto-scale checkbox never disabled anything: the pressure block ran on
// EVERY pool regardless of the box.
'use strict';
const fs = require('fs');
const path = require('path');
const mp = path.join(__dirname, '..', 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function rep(from, to, label) {
  // CRLF-tolerant: src files are MIXED (earlier node writes injected LF into CRLF files),
  // so literal multi-line anchors are unreliable. Build a \r?\n regex from the literal.
  const rx = new RegExp(from.split('\n').map(esc).join('\\r?\\n'), 'g');
  const hits = m.match(rx);
  if (!hits) throw new Error('anchor missing: ' + label);
  if (hits.length > 1) throw new Error('anchor NOT UNIQUE (' + hits.length + '): ' + label);
  m = m.replace(rx, () => to); // function form: no $-substitution surprises
}
if (m.includes('COORD.startWorkers =')) { console.log('already done'); process.exit(0); }

// â”€â”€ pool-start â”€â”€
rep(`  COORD.manualTarget = Math.max(1, Math.min(parseInt(workerCount) || 1, MAX_WORKERS_HARD_CEILING));
  COORD.scaleMultiplier = Math.max(1, parseInt(scaleMultiplier) || 3);
  COORD.autoScale = true;
  COORD.licenseCap = Infinity;
  COORD._durBaseline = []; COORD._durRolling = []; COORD._pressureHigh = 0;
  COORD.pressure = null; COORD.capReason = 'manual';
  COORD.hwCapAdvisory = computeHardwareCap(COORD.scaleMultiplier);`,
`  // v3.0.3: Start SEEDS, Max CLAMPS, heuristics decide in between.
  COORD.startWorkers = Math.max(1, Math.min(parseInt(startWorkers ?? workerCount) || 1, MAX_WORKERS_HARD_CEILING));
  COORD.maxWorkers   = Math.max(1, Math.min(parseInt(maxWorkers) || MAX_WORKERS_HARD_CEILING, MAX_WORKERS_HARD_CEILING));
  COORD.hwSlider     = Math.max(1, Math.min(5, parseInt(hwSlider) || 4));   // 4 = 100%
  COORD.ppSlider     = Math.max(1, Math.min(5, parseInt(ppSlider) || 4));   // 4 = 100%
  COORD.scaleMultiplier = 3; // the comfortable-cap BASE; hwSlider scales it, so this is fixed
  // v3.0.3: was hardcoded \`= true\`, so the Auto-scale checkbox never disabled anything and
  // the pressure block ran on every pool regardless of the box.
  COORD.autoScale = (elastic !== false);
  COORD.licenseCap = Infinity;
  COORD._rowTimes = []; COORD._tp = null; COORD._tpBest = null;
  COORD._tpW = null; COORD._tpStableSince = null; COORD._climbLastW = null; COORD._climbDir = undefined;
  COORD.throughput = null; COORD.capReason = 'settling';
  COORD.hwCapAdvisory = computeHardwareCap(COORD.scaleMultiplier);`, 'pool-start state');

rep('  let target = Math.max(1, Math.min(_modeWorkerCount, MAX_WORKERS_HARD_CEILING));\n  COORD.desiredWorkers = target;',
    '  let target = Math.max(1, Math.min(_modeWorkerCount, COORD.maxWorkers, MAX_WORKERS_HARD_CEILING));\n  COORD.desiredWorkers = target;', 'pool-start target');

// â”€â”€ step-mode release â”€â”€
rep(`    const tgt = (COORD.startModeTarget && COORD.startModeTarget.workers) || 1;
    COORD.manualTarget = Math.max(1, Math.min(tgt, MAX_WORKERS_HARD_CEILING));
    COORD.desiredWorkers = COORD.manualTarget;`,
`    const tgt = (COORD.startModeTarget && COORD.startModeTarget.workers) || 1;
    COORD.startWorkers = Math.max(1, Math.min(tgt, MAX_WORKERS_HARD_CEILING));
    COORD.desiredWorkers = Math.min(COORD.startWorkers, COORD.maxWorkers || MAX_WORKERS_HARD_CEILING);`, 'step release');

// â”€â”€ pool-set-scaling: live knobs â”€â”€
rep(`  if (d.workers != null) COORD.manualTarget = Math.max(1, Math.min(MAX_WORKERS_HARD_CEILING, parseInt(d.workers) || 1));
  if (d.autoScale != null) COORD.autoScale = !!d.autoScale;
  if (d.multiplier != null) { COORD.scaleMultiplier = Math.max(1, parseInt(d.multiplier) || 3); COORD.hwCapAdvisory = computeHardwareCap(COORD.scaleMultiplier); }`,
`  // v3.0.3: every knob is live. Max especially â€” Matthew's override is lowering it BELOW
  // the live count mid-run, which must drain workers, not wait for the next launch.
  if (d.maxWorkers != null)   COORD.maxWorkers   = Math.max(1, Math.min(MAX_WORKERS_HARD_CEILING, parseInt(d.maxWorkers) || 1));
  if (d.startWorkers != null) COORD.startWorkers = Math.max(1, Math.min(MAX_WORKERS_HARD_CEILING, parseInt(d.startWorkers) || 1));
  if (d.hwSlider != null)     COORD.hwSlider     = Math.max(1, Math.min(5, parseInt(d.hwSlider) || 4));
  if (d.ppSlider != null)     COORD.ppSlider     = Math.max(1, Math.min(5, parseInt(d.ppSlider) || 4));
  if (d.autoScale != null)    COORD.autoScale    = !!d.autoScale;
  // hwCapAdvisory must be RECOMPUTED here: it was only ever refreshed on a slider move, so
  // the renderer's amber cache went stale during a run and lied (slider 4 showed amber
  // while the real cap was 21).
  COORD.hwCapAdvisory = computeHardwareCap(COORD.scaleMultiplier || 3);`, 'set-scaling');

rep('  return { ok: true, hwCap: COORD.hwCapAdvisory || computeHardwareCap(COORD.scaleMultiplier) };',
    '  return { ok: true, hwCap: COORD.hwCapAdvisory || computeHardwareCap(3), hwEffective: Math.max(1, Math.round((COORD.hwCapAdvisory || computeHardwareCap(3)) * ((COORD.hwSlider || 4) / 4))) };', 'set-scaling return');

// â”€â”€ legacy pool-set-workers â”€â”€
rep('  COORD.manualTarget = Math.max(1, target || 1);\n  COORD.desiredWorkers = target;',
    '  COORD.startWorkers = Math.max(1, target || 1); // v3.0.3: legacy path â€” seeds Start, Max still clamps\n  COORD.desiredWorkers = Math.min(target, COORD.maxWorkers || MAX_WORKERS_HARD_CEILING);', 'set-workers');

// â”€â”€ pool-resume â”€â”€
rep(`  COORD.manualTarget = Math.max(1, Math.min(parseInt(workerCount) || 1, MAX_WORKERS_HARD_CEILING));
  COORD._durBaseline = []; COORD._durRolling = []; COORD._pressureHigh = 0; COORD.pressure = null; COORD.licenseCap = Infinity;`,
`  COORD.startWorkers = Math.max(1, Math.min(parseInt(startWorkers ?? workerCount) || 1, MAX_WORKERS_HARD_CEILING));
  COORD.maxWorkers   = Math.max(1, Math.min(parseInt(maxWorkers) || MAX_WORKERS_HARD_CEILING, MAX_WORKERS_HARD_CEILING));
  COORD.hwSlider     = Math.max(1, Math.min(5, parseInt(hwSlider) || 4));
  COORD.ppSlider     = Math.max(1, Math.min(5, parseInt(ppSlider) || 4));
  COORD.autoScale    = (elastic !== false);
  COORD.scaleMultiplier = 3;
  COORD._rowTimes = []; COORD._tp = null; COORD._tpBest = null;
  COORD._tpW = null; COORD._tpStableSince = null; COORD._climbLastW = null; COORD._climbDir = undefined;
  COORD.throughput = null; COORD.licenseCap = Infinity;`, 'pool-resume state');
fs.writeFileSync(mp, m, 'utf8');
console.log('main.js rewired');
