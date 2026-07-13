// _p3-4-crash-safety.js — Phase 3 final fix: coordinator-crash safety.
// Worker: stdin close (coordinator died) => finish current row, SPILL its result to
// disk, log out, exit. Coordinator: pidfile of spawned workers. Launch: pidfile sweep
// kills survivors from a dead run; spill files merge into pool journals before Resume.
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

// ── worker.js ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('_coordinatorDead')) {
  w = repRx(w, /(_rl\.on\('line', function\(line\)\{)/, [
    "// Phase 3 CRASH SAFETY: stdout to a dead parent raises EPIPE as a stream 'error' —",
    '// swallow it so a dying coordinator cannot crash the worker mid-row.',
    "process.stdout.on('error', function(){});",
    '// If the coordinator dies our stdin closes. Finish the current row, SPILL its result',
    '// to disk (nobody is journaling anymore), log out, exit. Launch recovery merges',
    '// journal-spill-*.jsonl into the pool journal before offering Resume.',
    'let _coordinatorDead = false;',
    'const SPILL_PATH = (function(){',
    '  try { return path.join(path.dirname(path.dirname(LOG_PATH)), \'journal-spill-\' + (RUN_CONTEXT.runId || (\'w\'+process.pid)) + \'.jsonl\'); }',
    '  catch(e){ return null; }',
    '})();',
    'function spillResult(row, status, error){',
    '  if(!SPILL_PATH) return;',
    "  try { fs.appendFileSync(SPILL_PATH, JSON.stringify({ poolId: RUN_CONTEXT.poolId||null, j: RUN_CONTEXT.jobId||null, r: row, s: status, error: error||'', ts: new Date().toISOString() }) + '\\n'); } catch(e){}",
    '}',
    '$1'
  ].join('\n'), 'spill machinery');
  w = repRx(w, /(_rl\.on\('line'[\s\S]*?\n\}\);)/, [
    '$1',
    "_rl.on('close', function(){",
    '  _coordinatorDead = true;',
    '  _draining = true;',
    "  if(_pendingBatchResolve){ const r=_pendingBatchResolve; _pendingBatchResolve=null; r({cmd:'drain'}); }",
    "  if(_pendingPauseResolve){ const r=_pendingPauseResolve; _pendingPauseResolve=null; r('auto'); }",
    '});'
  ].join('\n'), 'stdin close hook');
  w = repRx(w, /(        dialogs: row\.__dialogs \|\| null\}\);)/,
    "$1\n      // Phase 3 CRASH SAFETY: the emit above went nowhere if the coordinator is dead.\n      if(_coordinatorDead) spillResult(rowNum, res.status, res.error||'');", 'spill on result');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker done');
} else console.log('worker already done');

// ── coordinator.js: runContext identity + pidfile add/remove ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('coordPidfileAdd')) {
  c = rep(c, 'runContext: { runId: workerId,', 'runContext: { runId: workerId, poolId: COORD.poolId, jobId,', 'runContext identity');
  c = rep(c, "const proc = spawn(process.execPath, [runnerPath, job.spreadsheetPath, credPath], { stdio:",
    "const proc = spawn(process.execPath, [runnerPath, job.spreadsheetPath, credPath], { stdio:", 'spawn anchor sanity');
  c = repRx(c, /(const proc = spawn\(process\.execPath, \[runnerPath, job\.spreadsheetPath, credPath\], \{ stdio:[^\n]*\n)/,
    '$1  coordPidfileAdd(proc.pid);\n', 'pidfile add');
  c = repRx(c, /(  proc\.on\('close', code => \{\r?\n    runnerLogStream)/,
    "  proc.on('close', code => {\n    coordPidfileRemove(proc.pid);\n    runnerLogStream", 'pidfile remove');
  c = rep(c, 'module.exports = function wireCoordinator(ctx) {', [
    '// Phase 3 CRASH SAFETY: pidfile of live worker processes. If the coordinator dies',
    '// (crash, force-close), the next launch reads this file and kills any survivors whose',
    '// PID still resolves to our own executable name (guards against PID reuse).',
    "const PIDFILE = () => path.join(app.getPath('userData'), 'worker-pids.json');",
    'function coordPidfileRead(){ try { return JSON.parse(fs.readFileSync(PIDFILE(), \'utf8\')).pids || []; } catch(e){ return []; } }',
    'function coordPidfileWrite(pids){ try { fs.writeFileSync(PIDFILE(), JSON.stringify({ pids })); } catch(e){} }',
    'function coordPidfileAdd(pid){ if(!pid) return; const p = coordPidfileRead(); if(!p.includes(pid)) p.push(pid); coordPidfileWrite(p); }',
    'function coordPidfileRemove(pid){ if(!pid) return; coordPidfileWrite(coordPidfileRead().filter(x => x !== pid)); }',
    '',
    'module.exports = function wireCoordinator(ctx) {'
  ].join('\n'), 'pidfile helpers');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator done');
} else console.log('coordinator already done');

// ── journal.js: spill merge ──
const jp = path.join(root, 'src', 'journal.js');
let j = fs.readFileSync(jp, 'utf8');
if (!j.includes('mergeSpillFiles')) {
  j = j.replace(/\s*$/, '\n') + [
    '',
    '// Phase 3 CRASH SAFETY: merge worker spill files (journal-spill-*.jsonl, written when a',
    '// worker outlived a dead coordinator) into their pool journals, so Resume sees those rows',
    '// as completed instead of re-running them. Standalone: needs no COORD. Idempotent-ish:',
    '// each spill file is deleted after a successful merge.',
    'module.exports.mergeSpillFiles = function mergeSpillFiles(){',
    '  const dir = app.getPath(\'userData\');',
    '  let merged = 0;',
    '  let files = [];',
    '  try { files = fs.readdirSync(dir).filter(f => /^journal-spill-.*\\.jsonl$/.test(f)); } catch(e){ return 0; }',
    '  for (const f of files) {',
    '    const full = path.join(dir, f);',
    '    try {',
    '      const lines = fs.readFileSync(full, \'utf8\').split(/\\r?\\n/).filter(Boolean);',
    '      const byPool = {};',
    '      for (const line of lines) {',
    '        let o; try { o = JSON.parse(line); } catch(e){ continue; }',
    '        if (!o || !o.poolId || o.r === undefined) continue;',
    '        (byPool[o.poolId] = byPool[o.poolId] || []).push(JSON.stringify({ j: o.j || null, r: o.r, s: o.s }));',
    '      }',
    '      for (const poolId of Object.keys(byPool)) {',
    '        const jp2 = path.join(dir, \'pool-journal-pool\' + poolId + \'.jsonl\');',
    '        if (!fs.existsSync(jp2)) continue; // no journal to merge into — leave the spill alone',
    '        fs.appendFileSync(jp2, byPool[poolId].join(\'\\n\') + \'\\n\');',
    '        merged += byPool[poolId].length;',
    '      }',
    '      fs.unlinkSync(full);',
    '    } catch(e){ /* leave the spill file for the next attempt */ }',
    '  }',
    '  return merged;',
    '};',
    ''
  ].join('\n');
  fs.writeFileSync(jp, j, 'utf8');
  console.log('journal done');
} else console.log('journal already done');

// ── main.js: launch recovery (pidfile sweep + spill merge) ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('sweepOrphanWorkers')) {
  m = rep(m, 'app.whenReady().then(() => {', [
    '// Phase 3 CRASH SAFETY: launch recovery. (1) Kill orphaned workers from a dead run —',
    '// pidfile entries whose PID still resolves to our own exe name (guards PID reuse; the',
    "// workers run under the app's exe via ELECTRON_RUN_AS_NODE, which is exactly why they",
    '// blend into Task Manager and lingered invisibly — D1). (2) Merge worker spill files',
    '// into pool journals before any Resume offer, so crash-finished rows are not re-run.',
    'function sweepOrphanWorkers() {',
    '  try {',
    "    const pf = path.join(app.getPath('userData'), 'worker-pids.json');",
    '    let pids = [];',
    "    try { pids = (JSON.parse(fs.readFileSync(pf, 'utf8')).pids || []); } catch (e) {}",
    '    if (pids.length) {',
    "      const { execSync } = require('child_process');",
    '      const me = path.basename(process.execPath).toLowerCase();',
    '      let killed = 0;',
    '      for (const pid of pids) {',
    '        if (!pid || pid === process.pid) continue;',
    '        try {',
    '          const out = execSync(\'tasklist /FI "PID eq \' + pid + \'" /FO CSV /NH\', { encoding: \'utf8\', timeout: 5000 });',
    '          const mm = out.match(/^"([^"]+)"/m);',
    '          if (mm && mm[1].toLowerCase() === me) { process.kill(pid); killed++; }',
    '        } catch (e) {}',
    '      }',
    "      if (killed) console.log('[crash-safety] killed ' + killed + ' orphaned worker process(es) from a previous run');",
    '    }',
    '    try { fs.writeFileSync(pf, JSON.stringify({ pids: [] })); } catch (e) {}',
    '  } catch (e) {}',
    '  try {',
    "    const merged = require('./journal').mergeSpillFiles();",
    "    if (merged) console.log('[crash-safety] merged ' + merged + ' spilled row result(s) into pool journals');",
    '  } catch (e) {}',
    '}',
    '',
    'app.whenReady().then(() => {',
    '  sweepOrphanWorkers();'
  ].join('\n'), 'launch recovery');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');
