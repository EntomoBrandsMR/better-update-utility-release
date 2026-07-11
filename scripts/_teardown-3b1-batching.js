// _teardown-3b1-batching.js — workers pull ONE row. Deletes: batch-size knob+UI, worker
// tail reclaim + 'reclaim' message, reclaim tallies/displays, batchPos/Total, RETRY cfg
// (filter moves coordinator-side). KEEPS: requeue (crash safety), w.batch as <=1 container.
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
function repAll(s, from, to, expect, label) {
  let n = 0;
  while (s.includes(from)) { s = s.replace(from, to); n++; if (n > 50) break; }
  if (n !== expect) throw new Error(label + ': expected ' + expect + ', replaced ' + n);
  return s;
}
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}
function cutLine(s, needle, label) {
  const i = s.indexOf(needle);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(needle, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let le = s.indexOf('\n', i); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}
function cutAllLines(s, needle, expect, label) {
  let n = 0;
  while (true) {
    const i = s.indexOf(needle);
    if (i < 0) break;
    const ls = s.lastIndexOf('\n', i) + 1;
    let le = s.indexOf('\n', i); if (le < 0) le = s.length; else le++;
    s = s.slice(0, ls) + s.slice(le); n++;
  }
  if (n !== expect) throw new Error(label + ': expected ' + expect + ' lines, cut ' + n);
  return s;
}
function cutFromTo(s, startNeedle, endNeedle, label) {
  const i = s.indexOf(startNeedle);
  if (i < 0) throw new Error('start missing: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  const k = s.indexOf(endNeedle, i);
  if (k < 0) throw new Error('end missing: ' + label);
  let le = s.indexOf('\n', k); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}

// ── worker.js ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('RETRY_ROW_INDEXES')) { console.log('worker already cut'); } else {
w = cutFromTo(w, '// RETRY_ROW_INDEXES=null processes all rows', 'const RETRY_ROW_SET = RETRY_ROW_INDEXES ? new Set(RETRY_ROW_INDEXES) : null;', 'retry consts');
w = w.replace(/\/\*__BUU_CFG_(\d+)__\*\//g, (m, n) => +n > 5 ? '/*__BUU_CFG_' + (+n - 1) + '__*/' : m);
w = cutFromTo(w, 'holds the unstarted tail', "let _reclaimReason = 'drain';", 'reclaim decls');
w = cutLine(w, 'if(_draining){ _reclaimRows = msg.rows.slice(_bi); break; }', 'tail check');
w = cutFromTo(w, '// v2.2.2 Session 2E: retry-failed mode.', "error:'(retry mode: row not in retry set)', durationMs:0});", 'retry filter head');
w = repRx(w, /\r?\n        continue;\r?\n      \}(\r?\n      const row = ALL_ROWS\[rowNum-1\];)/, '$1', 'retry filter tail');
w = cutAllLines(w, '_reclaimRows = msg.rows.slice(_bi+1);', 2, 'user-stop tails');
w = cutAllLines(w, "_reclaimReason = 'user-stop';", 2, 'user-stop reasons');
w = cutFromTo(w, '// v2.2.1 LOSSLESS RECLAIM (worker side): before the shutdown', "if(_reclaimRows && _reclaimRows.length){ emit({type:'reclaim'", 'reclaim emit');
w = rep(w, 'for(let _bi=0; _bi<msg.rows.length; _bi++){', '{ // one row per pull (Phase 2 teardown: batching removed)', 'loop head');
w = rep(w, 'const rowNum = msg.rows[_bi];', 'const rowNum = msg.rows[0];', 'row pick');
w = repRx(w, /, batchPos:_bi\+1, batchSize:msg\.rows\.length\}\);/, '});', 'row-start emit');
const wCode = w.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
if (/RETRY_ROW|_reclaim|\b_bi\b|batchPos/.test(wCode)) throw new Error('worker batching leftovers');
fs.writeFileSync(wp, w, 'utf8');
console.log('worker cut');
}

// ── coordinator.js ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes("case 'reclaim': {")) { console.log('coordinator already cut'); } else {
c = cutLine(c, 'batchSize: 10,', 'COORD batchSize');
c = rep(c, 'startModeTarget: { workers: 1, batchSize: 10 },', 'startModeTarget: { workers: 1 },', 'COORD target');
c = repAll(c, 'batch.length < COORD.batchSize', 'batch.length < 1', 2, 'batch cap');
c = rep(c, '    if(job.completedRows && job.completedRows.has(r)) continue; // already done in a prior run',
  '    if(job.completedRows && job.completedRows.has(r)) continue; // already done in a prior run\n' +
  '    // Phase 2 teardown: retry-failed filtering moved coordinator-side (worker cfg no longer\n' +
  '    // carries the set; unselected rows are simply never handed out or journaled).\n' +
  '    if(job.retryRowIndexes && job.retryRowIndexes.length){\n' +
  '      if(!job._retrySet) job._retrySet = new Set(job.retryRowIndexes);\n' +
  '      if(!job._retrySet.has(r)) continue;\n' +
  '    }', 'retry filter');
c = rep(c, '// retryRowIndexes null = process all rows; reauthIntervalMin 0 = no proactive re-auth.', '// reauthIntervalMin 0 = no proactive re-auth.', 'cfg comment');
c = cutLine(c, 'retryRowIndexes: Array.isArray(job.retryRowIndexes) ? job.retryRowIndexes : null,', 'cfg retry');
c = cutLine(c, 'reclaimsTotal: j.reclaimsTotal || 0,', 'status reclaimsTotal');
c = cutLine(c, "reclaimsByReason: j.reclaimsByReason || { 'drain':0, 'user-stop':0, 'breaker':0, 'crash':0 },", 'status reclaimsByReason');
c = rep(c, ' batchSize: (w.batch||[]).length,', '', 'worker payload batchSize');
c = rep(c, ', batchPos: w.batchPos, batchTotal: w.batchSize', '', 'worker payload pos');
c = rep(c, ' batchSize: COORD.batchSize,', '', 'pool payload batchSize');
c = cutLine(c, 'w.batchPos = msg.batchPos; w.batchSize = msg.batchSize;', 'row-start pos');
c = cutLine(c, 'let crashCount = 0;', 'crashCount decl');
c = repRx(c, /\r?\n          crashCount\+\+;/, '', 'crashCount inc');
c = repRx(c, /        if\(crashCount > 0\)\{[\s\S]*?\r?\n        \}\r?\n/, '', 'crash tally block');
c = repRx(c, /    case 'reclaim': \{[\s\S]*?\r?\n    \}\r?\n(?=  \}\r?\n  coordEmitStatus)/, '', 'reclaim case');
c = c.replace(/^\s*\/\/.*(reclaimsTotal|reclaimsByReason|tally crash reclaims|re-processed).*\r?\n/gm, '');
const cCode = c.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
if (/reclaimsTotal|reclaimsByReason|batchSize|batchPos|crashCount/.test(cCode)) throw new Error('coordinator batching leftovers');
fs.writeFileSync(cp, c, 'utf8');
console.log('coordinator cut');
}

// ── main.js ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('_cfgBatch')) { console.log('main already cut'); } else {
m = rep(m, " workerCount, batchSize, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin, setupScope, startMode, diagnosticCapture, captureBucketCap }", " workerCount, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin, setupScope, startMode, diagnosticCapture, captureBucketCap }", 'pool-start params');
m = cutLine(m, 'const _cfgBatch = Math.max(1, Math.min(500, parseInt(batchSize) || 10));', 'cfgBatch');
m = rep(m, 'COORD.startModeTarget = { workers: _cfgWorkers, batchSize: _cfgBatch };', 'COORD.startModeTarget = { workers: _cfgWorkers };', 'target assign');
m = repRx(m, /  if \(COORD\.startMode === 'step' \|\| COORD\.startMode === 'step-row'\) \{\r?\n    COORD\.batchSize = 1;\r?\n  \} else \{\r?\n    COORD\.batchSize = _cfgBatch;\r?\n  \}\r?\n/, '', 'batchSize if/else');
m = repRx(m, /[ ]*if \(COORD\.startModeTarget && COORD\.startModeTarget\.batchSize\) \{\r?\n[ ]*COORD\.batchSize = COORD\.startModeTarget\.batchSize;\r?\n[ ]*\}\r?\n/, '', 'run-all restore');
m = rep(m, ', batchSize: COORD.batchSize };', ' };', 'run-control return');
m = rep(m, "ipcMain.handle('pool-resume', async (_, { poolId, workerCount, batchSize, elastic,", "ipcMain.handle('pool-resume', async (_, { poolId, workerCount, elastic,", 'resume params');
m = repRx(m, /COORD\.startModeTarget = meta\.startModeTarget \|\| \{ workers: 1, batchSize: meta\.batchSize \|\| 10 \}/, 'COORD.startModeTarget = meta.startModeTarget || { workers: 1 }', 'resume target');
m = repRx(m, /^.*COORD\.batchSize = Math\.max\(1, Math\.min\(500, parseInt\(batchSize\) \|\| meta\.batchSize \|\| 10\)\);.*\r?\n/m, '', 'resume batchSize');
m = cutAllLines(m, 'reclaimsTotal: 0,', 2, 'job reclaimsTotal init');
m = cutAllLines(m, "reclaimsByReason: { 'drain':0, 'user-stop':0, 'breaker':0, 'crash':0 },", 2, 'job reclaimsByReason init');
m = repRx(m, / job\.reclaimsTotal = 0; job\.reclaimsByReason = \{ 'drain':0, 'user-stop':0, 'breaker':0, 'crash':0 \};/, '', 'reset loop');
m = rep(m, 'retryRowIndexes = null, reauthIntervalMin = 0,', 'reauthIntervalMin = 0,', 'prelude retry');
m = cutLine(m, "(retryRowIndexes && retryRowIndexes.length ? JSON.stringify(retryRowIndexes) : 'null'),", 'inj retry');
m = m.replace(/^\s*\/\/.*(reclaimsByReason buckets|reclaimsTotal is the).*\r?\n/gm, '');
const mCode = m.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
if (/batchSize|reclaims|_cfgBatch/.test(mCode)) throw new Error('main batching leftovers');
fs.writeFileSync(mp, m, 'utf8');
console.log('main cut');
}

// ── index.html ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('poolBatchSize')) { console.log('index already cut'); } else {
{ // Batch input row: <div ...><span>Batch</span><input poolBatchSize></div>
  const i = h.indexOf('id="poolBatchSize"');
  if (i < 0) throw new Error('batch input missing');
  let ls = h.lastIndexOf('\n', i) + 1;              // input line start
  ls = h.lastIndexOf('\n', ls - 2) + 1;             // span line
  ls = h.lastIndexOf('\n', ls - 2) + 1;             // enclosing div line
  const closeIdx = h.indexOf('</div>', i);
  let le = h.indexOf('\n', closeIdx); le = le < 0 ? h.length : le + 1;
  h = h.slice(0, ls) + h.slice(le);
}
h = cutAllLines(h, "const batchSize = parseInt((document.getElementById('poolBatchSize')||{}).value) || 10;", 2, 'batch reads');
h = repAll(h, ' workerCount:n, batchSize, elastic,', ' workerCount:n, elastic,', 2, 'payloads');
h = rep(h, " workers (headless, batch size '+batchSize+')", ' workers (headless)', 'confirm text');
h = rep(h, 'Workers pull batches until all jobs drain.', 'Workers pull rows until all jobs drain.', 'confirm text 2');
h = cutLine(h, 'id="rs-reclaim"', 'reclaim stat');
h = cutLine(h, 'id="rs-reclaim-breakdown"', 'reclaim breakdown div');
h = cutLine(h, 'reclaim re-processed count', 'reclaim stat comment');
h = cutLine(h, 'reclaim breakdown line. Hidden until', 'reclaim breakdown comment');
h = cutLine(h, "if(w.batchPos!=null && w.batchTotal!=null) parts.push(w.batchPos+'/'+w.batchTotal);", 'card pos');
h = rep(h, ',total=0,reclaimTotal=0;', ',total=0;', 'agg decl');
h = cutLine(h, "const reclaimAgg={'drain':0,'user-stop':0,'breaker':0,'crash':0};", 'reclaimAgg');
h = cutLine(h, 'reclaimTotal+=(j.reclaimsTotal||0);', 'agg add');
h = repRx(h, /    if\(j\.reclaimsByReason\)\{\r?\n[^\r\n]*\r?\n    \}\r?\n/, '', 'agg loop');
h = cutFromTo(h, '// v2.2.3 Session 3B (A5): reclaim count + breakdown line.', "} else { bd.style.display='none'; }", 'display block');
const hCode = h.split(/\r?\n/).filter(l => !/^\s*\/\/|^\s*<!--/.test(l)).join('\n');
if (/reclaim|poolBatchSize|batchPos|batchSize/i.test(hCode)) {
  h.split(/\r?\n/).filter(l => !/^\s*\/\/|^\s*<!--/.test(l) && /reclaim|poolBatchSize|batchPos|batchSize/i.test(l)).forEach(l => console.error('SURVIVOR: ' + l.trim().slice(0, 100)));
  throw new Error('index batching leftovers');
}
fs.writeFileSync(hp, h, 'utf8');
console.log('index cut');
}
