// _303-throughput.js — REPLACE THE PRESSURE SYSTEM WITH A THROUGHPUT CLIMB.
//
// What is being deleted and why (all three proven on Matthew's 2026-07-15 run):
//  - baseline = median of first 50 OK rows, captured at 1 WORKER on whatever accounts
//    happened to be first. His data: 1 worker at 5:55 = 7.1s/row, 1 worker at 6:10 =
//    3.1s/row. SAME worker count, 2.3x apart. The ratio measured account complexity.
//  - drop trigger 1.4 sits BELOW the measured noise maximum of 1.46 => fires on nothing.
//  - drop = floor(workers*0.8) compounding with no floor: 13->10->8->6->4->3->2->1, and
//    recovery is +1 per eval => 24 minutes to climb back. One false positive, half an hour.
//
// What replaces it: measure OVERALL ROWS/MIN (Matthew: "focus on the overall") and hill-
// climb it. Latency is actively misleading — his 4->13 more than DOUBLED row time while
// throughput IMPROVED 35%, so any "time doubled = bad" rule backs off at a GOOD count.
// Throughput = workers/duration captures both his cases with one formula:
//    4->7 workers @2x time  = 34 -> 30 rows/min  WORSE  (he was right)
//    4->13 workers @2.2x    = better
// Samples are only taken when the worker count has been STABLE for a full window,
// otherwise the sample is a blend of two configurations and means nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = path.join(__dirname, '..', 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (c.includes('coordThroughputTarget')) { console.log('already done'); process.exit(0); }

// ── 1) record every completed row's timestamp (the throughput signal) ──
const rowAnchor = "      if(job && job.completedRows) job.completedRows.add(msg.row);";
if (c.indexOf(rowAnchor) < 0) throw new Error('row-result anchor missing');
if (c.indexOf(rowAnchor) !== c.lastIndexOf(rowAnchor)) throw new Error('row-result anchor not unique');
c = c.replace(rowAnchor, [
  '      // v3.0.3: throughput signal. One timestamp per completed row — this is the ONLY',
  '      // thing the scaler measures. Trimmed to the last 10 minutes so memory is bounded',
  '      // on 25k-row runs.',
  '      if(String(msg.status||\'\').indexOf(\'ok\') === 0){',
  '        if(!COORD._rowTimes) COORD._rowTimes = [];',
  '        COORD._rowTimes.push(Date.now());',
  '        if(COORD._rowTimes.length > 5000) COORD._rowTimes = COORD._rowTimes.slice(-3000);',
  '      }',
  rowAnchor,
].join('\n'));

// ── 2) the climb itself, inserted before coordEvalScale ──
const evalAnchor = 'async function coordEvalScale(){';
if (c.indexOf(evalAnchor) < 0) throw new Error('coordEvalScale anchor missing');
c = c.replace(evalAnchor, [
  '// v3.0.3: THE CLIMB. Returns the worker count to aim for, based purely on measured',
  '// rows/min. Never reads row latency — see the header note for why latency lies.',
  '// Cadence is the caller\'s (the eval timer), so the "Eval every (min)" box is the single',
  '// visible knob for how twitchy this is (Matthew: "set the time to whatever the auto',
  '// time check is").',
  'const TP_WINDOW_MS = 60000;   // sample window; 30 rows at 13 workers is only ~19s (too twitchy)',
  'const TP_NOISE = 0.10;        // MEASURED: throughput at a fixed 13 workers wobbled 1.32-1.63 rows/sec',
  'function coordThroughputNow(){',
  '  const now = Date.now();',
  '  const times = COORD._rowTimes || [];',
  '  let n = 0;',
  '  for (let i = times.length - 1; i >= 0; i--) { if (now - times[i] > TP_WINDOW_MS) break; n++; }',
  '  return n / (TP_WINDOW_MS / 1000); // rows per second',
  '}',
  'function coordThroughputTarget(){',
  '  const W = COORD.workers.size || 1;',
  '  const now = Date.now();',
  '  if (COORD._tpW !== W) { COORD._tpW = W; COORD._tpStableSince = now; } // W changed: restart the clock',
  '  // A sample taken while the worker count was changing is a blend of two configurations',
  '  // and means nothing. Wait for a clean window before believing anything.',
  '  if (now - (COORD._tpStableSince || now) < TP_WINDOW_MS) { COORD.capReason = COORD.capReason || \'settling\'; return W; }',
  '  const T = coordThroughputNow();',
  '  if (!COORD._tp) COORD._tp = {};',
  '  const prevRec = COORD._tp[W];',
  '  COORD._tp[W] = prevRec ? { t: (prevRec.t * prevRec.n + T) / (prevRec.n + 1), n: prevRec.n + 1 } : { t: T, n: 1 };',
  '  // remember the best measured count — this is what gets written to the flow',
  '  if (!COORD._tpBest || COORD._tp[W].t > COORD._tpBest.t) COORD._tpBest = { w: W, t: COORD._tp[W].t };',
  '  const lastW = COORD._climbLastW;',
  '  let dir = (COORD._climbDir === undefined) ? 1 : COORD._climbDir;',
  '  if (lastW != null && lastW !== W && COORD._tp[lastW]) {',
  '    const before = COORD._tp[lastW].t, after = COORD._tp[W].t;',
  '    if (after > before * (1 + TP_NOISE))      { /* real gain: keep going */ }',
  '    else if (after < before * (1 - TP_NOISE)) { dir = -dir; }   // real loss: turn around',
  '    else                                      { dir = 0; }      // inside the noise: settle',
  '  }',
  '  COORD._climbLastW = W;',
  '  COORD._climbDir = dir;',
  '  COORD.throughput = Math.round(T * 600) / 10; // rows/min, for the readout',
  '  return Math.max(1, W + dir);',
  '}',
  '',
  evalAnchor,
].join('\n'));

// ── 3) rewire the decision: heuristics decide, Max clamps ──
const oldBlock = c.match(/  let target = Math\.max\(1, Math\.min\(parseInt\(COORD\.manualTarget\)[\s\S]*?COORD\.capReason = reason;/);
if (!oldBlock) throw new Error('decision block anchor missing');
c = c.replace(oldBlock[0], [
  '  // v3.0.3: HEURISTICS DECIDE, MAX CLAMPS. The old line was',
  '  //   target = min(manualTarget, CEILING)  ... then only ever reduced',
  '  // which made auto incapable of EVER adding a worker — all the scaling code could only',
  '  // subtract from a number the user already set. That is why auto "never worked".',
  '  let reason = \'held\';',
  '  let target;',
  '  if (COORD.autoScale) { target = coordThroughputTarget(); reason = \'throughput\'; }',
  '  else { target = COORD.workers.size || COORD.startWorkers || 1; }',
  '',
  '  // Hardware heuristic: slider 1-5, 4 = 100% of the comfortable cap, 5 = 125% overdrive.',
  '  const _hwSlider = Math.max(1, Math.min(5, parseInt(COORD.hwSlider) || 4));',
  '  const _hwBase = COORD.hwCapAdvisory || MAX_WORKERS_HARD_CEILING;',
  '  const _hwEff = Math.max(1, Math.round(_hwBase * (_hwSlider / 4)));',
  '  if (_hwEff < target) { target = _hwEff; reason = \'hardware\'; }',
  '',
  '  // License cap: UNCONDITIONAL. Already computed above; never gated on a checkbox.',
  '  if (Number.isFinite(COORD.licenseCap) && COORD.licenseCap < target) { target = COORD.licenseCap; reason = \'license\'; }',
  '',
  '  // Max: the user\'s LIVE lid. Lower it below the live count mid-run and workers drain.',
  '  // It is a clamp, never the target — that distinction is the whole point of this rewrite.',
  '  const _max = Math.max(1, Math.min(parseInt(COORD.maxWorkers) || MAX_WORKERS_HARD_CEILING, MAX_WORKERS_HARD_CEILING));',
  '  if (_max < target) { target = _max; reason = \'max\'; }',
  '',
  '  target = Math.max(1, target);',
  '  COORD.capReason = reason;',
].join('\n'));
fs.writeFileSync(cp, c, 'utf8');
console.log('done');
