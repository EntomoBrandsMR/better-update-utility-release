// _p3-3-stop.js — Phase 3 fix 3 (D2): Stop abandons the current row at the next STEP
// boundary in every mode (no more minutes of grinding); force-kill fuse 180s -> 10s;
// logout sweep fires promptly when the last worker exits instead of a fixed 184s clock.
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
  if (n !== expect) throw new Error(label + ': expected ' + expect + ', got ' + n);
  return s;
}
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}

// ── worker.js ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('honor Stop at EVERY step boundary')) {
  w = rep(w, "if(currentMode === 'step' && s.type !== 'dialog'){",
    [
      '// Phase 3 (D2): honor Stop at EVERY step boundary in every mode — abandon the row',
      '      // instead of grinding remaining steps/waits/retries for minutes after Stop.',
      "      if(currentMode === 'stop') throw new Error('__STOP__');",
      "      if(currentMode === 'step' && s.type !== 'dialog'){"
    ].join('\n'), 'step gate');
  w = repAll(w, "status:'stopped', error:'User stop during step-through'",
    "status:'error', error:'Stopped by user at a step boundary'", 2, 'stopped status');
  if (w.includes("status:'stopped'")) throw new Error('a stopped status survived');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker done');
} else console.log('worker already done');

// ── coordinator.js ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('_stopSweepFired')) {
  c = rep(c, 'possibleLeaks: [],   // Phase 3: workerIds that exited without VERIFIED logout (license may be held)',
    'possibleLeaks: [],   // Phase 3: workerIds that exited without VERIFIED logout (license may be held)\n  stopping: false,     // Phase 3 (D2): pool-stop in progress — gates stall-guard respawn + prompt sweep\n  _stopSweepFired: false,', 'COORD fields');
  c = rep(c, 'if(COORD.active && COORD.workers.size === 0 && coordPickJobForWorker()){',
    'if(COORD.active && !COORD.stopping && COORD.workers.size === 0 && coordPickJobForWorker()){', 'stall guard gate');
  c = repRx(c, /    coordEmitStatus\(\);\r?\n    \/\/ v2\.2\.1 LOSSLESS RECLAIM \(stall guard\):/,
    [
      '    coordEmitStatus();',
      '    // Phase 3 (D2): when the pool is stopping, fire the logout sweep PROMPTLY once the',
      '    // last worker is gone instead of on the old fixed 184s clock. sweepRunning +',
      '    // _stopSweepFired guard doubles with the fuse-path backstop in pool-stop.',
      '    if(COORD.stopping && COORD.workers.size === 0 && !COORD._stopSweepFired){',
      '      COORD._stopSweepFired = true;',
      "      setTimeout(() => coordRunLogoutSweep('pool-stop'), 1500);",
      '    }',
      '    // v2.2.1 LOSSLESS RECLAIM (stall guard):'
    ].join('\n'), 'prompt sweep hook');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator done');
} else console.log('coordinator already done');

// ── main.js ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('COORD.stopping = true;')) {
  m = repRx(m, /(  if \(COORD\.licenseTimer\) \{ clearInterval\(COORD\.licenseTimer\); COORD\.licenseTimer = null; \}\r?\n)(  \/\/ Drain all jobs)/,
    '$1  COORD.stopping = true; // Phase 3 (D2): gates stall-guard respawn; arms the prompt logout sweep\n$2', 'stopping flag');
  m = repRx(m, /    try \{ w\.process\.stdin\.write\(JSON\.stringify\(\{ cmd: 'drain' \}\) \+ '\\n'\); \} catch \{\}\r?\n    w\.status = 'draining';/,
    [
      "    // Phase 3 (D2): 'stop' abandons the current row at the next step boundary;",
      "    // 'drain' resolves any pending row request so idle workers exit immediately.",
      "    try { w.process.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\\n'); } catch {}",
      "    try { w.process.stdin.write(JSON.stringify({ cmd: 'drain' }) + '\\n'); } catch {}",
      "    w.status = 'draining';"
    ].join('\n'), 'stop+drain send');
  m = repRx(m, /  \/\/ v2\.1\.0: force-kill backstop raised to 180s\.[\s\S]*?const _ids/, [
    '  // Phase 3 (D2): force-kill fuse is 10s (was 180s). Stop now abandons the current row',
    '  // at the next STEP boundary and logout is a 5s one-URL navigation, so a healthy worker',
    '  // exits in a few seconds. Anything still alive at 10s is wedged mid-action; kill it and',
    '  // let the logout sweep (fired promptly on last-worker-exit, backstopped below) free the',
    '  // session. A killed process cannot log itself out — the sweep is the guarantee layer.',
    '  const _ids'
  ].join('\n'), 'fuse comment');
  m = rep(m, '  }, 180000);', '  }, 10000);', 'fuse value');
  m = repRx(m, /    \/\/ v2\.1\.1: after the force-kill window, sweep the License Manager[\s\S]*?setTimeout\(\(\) => coordRunLogoutSweep\('pool-stop'\), 4000\);/, [
    '    // Backstop sweep for the killed-mid-action case (sweepRunning + _stopSweepFired',
    '    // make this a no-op when the prompt last-worker-exit sweep already ran).',
    "    setTimeout(() => coordRunLogoutSweep('pool-stop'), 2000);"
  ].join('\n'), 'backstop sweep');
  m = rep(m, '  COORD.possibleLeaks = [];',
    '  COORD.possibleLeaks = [];\n  COORD.stopping = false;\n  COORD._stopSweepFired = false;', 'pool-start reset');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');
