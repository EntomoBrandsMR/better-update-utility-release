// _303-test-update.js — bring _test-containment.js onto the v3.0.3 model.
// manualTarget is gone: Start SEEDS, Max CLAMPS, heuristics decide between them.
// Adds the assertion for the semantics Matthew specified: raising Max must NOT raise the
// worker count (it is a lid, not a target); lowering it below live MUST drain.
'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '_test-containment.js');
let s = fs.readFileSync(p, 'utf8');
function rep(from, to, label) {
  if (!s.includes(from)) throw new Error('anchor missing: ' + label);
  s = s.split(from).join(to);
}

// seedJob: establish the new fields
rep(`  COORD.elasticParams = null;      // license off for this test
  COORD.autoScale = false;         // isolate CONTAINMENT from the scaling heuristics`,
`  COORD.elasticParams = null;      // license scrape off for this test (needs a browser)
  COORD.autoScale = false;         // isolate CONTAINMENT from the climb
  // v3.0.3 model: Start seeds, Max clamps. hwCapAdvisory high so hardware never binds here.
  COORD.startWorkers = 1;
  COORD.maxWorkers = 150;
  COORD.hwSlider = 4;
  COORD.ppSlider = 4;
  COORD.hwCapAdvisory = 150;
  COORD._rowTimes = []; COORD._tp = null; COORD._tpBest = null;
  COORD._tpW = null; COORD._tpStableSince = null; COORD._climbLastW = null; COORD._climbDir = undefined;`, 'seed fields');
rep(`  COORD._durBaseline = []; COORD._durRolling = []; COORD._pressureHigh = 0;
  COORD.licenseCap = Infinity;`, '  COORD.licenseCap = Infinity;', 'dead fields');

// T1
rep(`  seedJob(100000);
  COORD.manualTarget = 4;
  peak = 0;
  await Promise.all([
    coordEvalScale(), coordEvalScale(), coordEvalScale(), coordEvalScale(), coordEvalScale(),
  ]);`,
`  seedJob(100000);
  COORD.startWorkers = 4; COORD.maxWorkers = 4;
  peak = 0;
  await Promise.all([
    coordEvalScale(), coordEvalScale(), coordEvalScale(), coordEvalScale(), coordEvalScale(),
  ]);`, 'T1');

// T2
rep(`  seedJob(100000);
  COORD.manualTarget = 4;
  peak = 0;
  const race = [coordEvalScale()];`,
`  seedJob(100000);
  COORD.startWorkers = 4; COORD.maxWorkers = 4;
  peak = 0;
  const race = [coordEvalScale()];`, 'T2');

// T3 — semantics change: Max is a LID, not a target
rep(`  // ── T3: raising the target is still honoured exactly ──
  COORD.manualTarget = 7;
  peak = 0;
  await coordEvalScale();
  await new Promise(r => setTimeout(r, 500));
  ok(COORD.workers.size <= 7, 'T3 raised target 7 not exceeded', 'live=' + COORD.workers.size);
  ok(COORD.workers.size > 4, 'T3 raised target actually scaled UP', 'live=' + COORD.workers.size);`,
`  // ── T3: Max is a LID, not a target. Raising it with the climb OFF must change nothing —
  // the pool holds the user's number (Start). Matthew: "max is my overide".
  COORD.maxWorkers = 7;
  await coordEvalScale();
  await new Promise(r => setTimeout(r, 400));
  ok(COORD.workers.size === 4, 'T3 raising Max with climb off does NOT raise workers (lid, not target)', 'live=' + COORD.workers.size);
  ok(COORD.workers.size <= 7, 'T3 Max never exceeded', 'live=' + COORD.workers.size);`, 'T3');

// T4
rep("  COORD.manualTarget = 2;\n  await coordEvalScale();", '  COORD.maxWorkers = 2;\n  await coordEvalScale();', 'T4');

// T5
rep(`  seedJob(100000);
  COORD.manualTarget = 1;
  peak = 0;`,
`  seedJob(100000);
  COORD.startWorkers = 1; COORD.maxWorkers = 1;
  peak = 0;`, 'T5');

// T6
rep(`  seedJob(2);
  COORD.manualTarget = 10;
  peak = 0;`,
`  seedJob(2);
  COORD.startWorkers = 10; COORD.maxWorkers = 10;
  peak = 0;`, 'T6');
fs.writeFileSync(p, s, 'utf8');
console.log('test updated to the v3.0.3 model');
