// _303-signatures.js — the handlers must actually RECEIVE the new knobs, and COORD's
// field list must reflect the new model (manualTarget is gone).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function patch(file, edits) {
  const p = path.join(root, file);
  let s = fs.readFileSync(p, 'utf8');
  for (const [from, to, label] of edits) {
    const rx = new RegExp(from.split('\n').map(esc).join('\\r?\\n'), 'g');
    const hits = s.match(rx);
    if (!hits) throw new Error(file + ': anchor missing: ' + label);
    if (hits.length > 1) throw new Error(file + ': NOT UNIQUE (' + hits.length + '): ' + label);
    s = s.replace(rx, () => to);
  }
  fs.writeFileSync(p, s, 'utf8');
  console.log(file + ' patched');
}

// ── pool-resume: accept the new knobs ──
patch('src/main.js', [[
  "ipcMain.handle('pool-resume', async (_, { poolId, workerCount, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin }) => {",
  "ipcMain.handle('pool-resume', async (_, { poolId, workerCount, startWorkers, maxWorkers, hwSlider, ppSlider, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin }) => {",
  'pool-resume sig',
]]);

// ── COORD field list ──
patch('src/pool/coordinator.js', [[
  '  manualTarget: 1,       // the Workers slider — manual wins over auto',
  '  // v3.0.3: manualTarget DELETED. It was the target AND the ceiling, which made auto\n' +
  '  // incapable of ever adding a worker. Start seeds, Max clamps, heuristics decide.\n' +
  '  startWorkers: 1,       // seed only — NOT a floor; heuristics may go below it\n' +
  '  maxWorkers: 150,       // the user\'s LIVE lid; lower it mid-run and workers drain\n' +
  '  hwSlider: 4,           // 1-5, 4 = 100% of the comfortable hardware cap\n' +
  '  ppSlider: 4,           // 1-5, 4 = 100% of the measured PestPac optimum\n' +
  '  throughput: null,      // rows/min, the ONLY signal the scaler reads\n' +
  '  _rowTimes: [],         // completion timestamps (bounded)\n' +
  '  _tp: null,             // W -> { t: rows/sec, n: samples }\n' +
  '  _tpBest: null,         // { w, t } best measured — this is what lands in the flow',
  'COORD fields',
]]);
