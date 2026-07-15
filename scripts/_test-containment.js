// _test-containment.js — OFFLINE. No PestPac, no network, no real processes.
// THE TEST THAT WOULD HAVE CAUGHT 29 WORKERS.
// Loads the REAL coordinator.js (not a reimplementation), stubs only electron and
// child_process.spawn, then hammers the eval path concurrently exactly like the live
// system does — the eval timer plus every slider move — and asserts the invariant
// Matthew watched break: LIVE WORKERS MUST NEVER EXCEED THE TARGET.
//
// SAFETY: every path is redirected into a throwaway temp dir. Matthew's real userData
// (%APPDATA%\buu-2) is never touched — he may be mid-run while this executes.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'buu-test-'));
let fakePid = 90000;
const spawned = [];

// ── stub electron + child_process BEFORE coordinator.js is required ──
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => TMP, isPackaged: false } };
  if (req === 'child_process') {
    return {
      spawn: () => {
        const child = {
          pid: ++fakePid,
          stdin: { write() {}, end() {}, on() {} },
          stdout: { on() {}, setEncoding() {} },
          stderr: { on() {}, setEncoding() {} },
          on() { return child; },
          once() { return child; },
          kill() {},
          unref() {},
          removeAllListeners() { return child; },
        };
        spawned.push(child);
        return child;
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const wireCoordinator = require(path.join(__dirname, '..', 'src', 'pool', 'coordinator.js'));

const ctx = {
  SERVICE_NAME: 'BUU2-TEST',
  MAX_WORKERS_HARD_CEILING: 150,
  loadRowsForJob: () => [],
  getLogsDir: () => TMP,
  encStore: (x) => Buffer.from(JSON.stringify(x)),
  readAllProfiles: () => [{ id: 'p1', name: 'test-profile' }],
  readConfig: () => ({}),
  getBundledChromiumPath: () => path.join(TMP, 'fake-chrome.exe'),
  licenseReaderLogout: async () => {},
  resolveOnceFlowByName: () => ({ steps: [] }),
  buildPoolWorker: () => '// fake worker source',
  buildLogoutSweeper: () => '// fake sweeper',
  buildOnceFlowRunner: () => '// fake once runner',
  keytar: null,
  mainWindow: null, // _send must no-op safely
};

const api = wireCoordinator(ctx);
const { COORD, coordEvalScale, coordScaleTo } = api;

let fails = 0;
const ok = (cond, name, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  :: ' + extra : '')); if (!cond) fails++; };

function seedJob(rows) {
  COORD.jobs.clear();
  COORD.workers.clear();
  COORD.jobs.set('j1', {
    jobId: 'j1', label: 'test', totalRows: rows, nextRow: 1,
    completedRows: new Set(), done: 0, ok: 0, err: 0, finished: false,
    requeue: [], profileId: 'p1', flowSteps: [], spreadsheetPath: null,
    setupFlowId: null, teardownFlowId: null, batchSize: 1,
  });
  COORD.active = true;
  COORD.stopping = false;
  COORD.usedProfileIds = COORD.usedProfileIds || new Set();
  COORD.elasticParams = null;      // license off for this test
  COORD.autoScale = false;         // isolate CONTAINMENT from the scaling heuristics
  COORD._durBaseline = []; COORD._durRolling = []; COORD._pressureHigh = 0;
  COORD.licenseCap = Infinity;
  COORD.setupScope = 'per-worker';
  COORD.startMode = 'run-all';
}

// simulate login completing fast so the sequential ramp progresses
let peak = 0;
const sim = setInterval(() => {
  for (const w of COORD.workers.values()) if (w.status === 'starting') w.status = 'running';
  if (COORD.workers.size > peak) peak = COORD.workers.size;
}, 10);

(async () => {
  console.log('temp sandbox: ' + TMP + '\n');

  // ── T1: the exact live scenario — target 4, five concurrent callers ──
  seedJob(100000);
  COORD.manualTarget = 4;
  peak = 0;
  await Promise.all([
    coordEvalScale(), coordEvalScale(), coordEvalScale(), coordEvalScale(), coordEvalScale(),
  ]);
  await new Promise(r => setTimeout(r, 400));
  ok(peak <= 4, 'T1 five concurrent evals never exceed target 4', 'peak=' + peak + ' live=' + COORD.workers.size);

  // ── T2: staggered re-entry mid-ramp (the slider-move case) ──
  seedJob(100000);
  COORD.manualTarget = 4;
  peak = 0;
  const race = [coordEvalScale()];
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 15)); race.push(coordEvalScale()); }
  await Promise.all(race);
  await new Promise(r => setTimeout(r, 400));
  ok(peak <= 4, 'T2 staggered re-entry mid-ramp never exceeds target 4', 'peak=' + peak + ' live=' + COORD.workers.size);

  // ── T3: raising the target is still honoured exactly ──
  COORD.manualTarget = 7;
  peak = 0;
  await coordEvalScale();
  await new Promise(r => setTimeout(r, 500));
  ok(COORD.workers.size <= 7, 'T3 raised target 7 not exceeded', 'live=' + COORD.workers.size);
  ok(COORD.workers.size > 4, 'T3 raised target actually scaled UP', 'live=' + COORD.workers.size);

  // ── T4: lowering the target drains (Matthew: Max is a LIVE lid) ──
  COORD.manualTarget = 2;
  await coordEvalScale();
  await new Promise(r => setTimeout(r, 200));
  const draining = [...COORD.workers.values()].filter(w => w.status === 'draining').length;
  const keep = [...COORD.workers.values()].filter(w => w.status !== 'draining').length;
  ok(keep <= 2, 'T4 lowering Max mid-run retires the excess', 'keeping=' + keep + ' draining=' + draining);

  // ── T5: target 1 spawns exactly 1 (his "set it to 1 and it did nothing" case) ──
  seedJob(100000);
  COORD.manualTarget = 1;
  peak = 0;
  await Promise.all([coordEvalScale(), coordEvalScale(), coordEvalScale()]);
  await new Promise(r => setTimeout(r, 300));
  ok(peak <= 1, 'T5 target 1 under concurrency stays at 1', 'peak=' + peak);

  // ── T6: never spawn more workers than there is work ──
  seedJob(2);
  COORD.manualTarget = 10;
  peak = 0;
  await coordEvalScale();
  await new Promise(r => setTimeout(r, 300));
  ok(peak <= 2, 'T6 workers never exceed remaining rows', 'peak=' + peak + ' rows=2');

  clearInterval(sim);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\ntotal fake processes spawned: ' + spawned.length);
  console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  clearInterval(sim);
  console.log('HARNESS ERROR: ' + e.stack);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
