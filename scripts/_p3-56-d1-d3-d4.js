// _p3-56-d1-d3-d4.js — Phase 3 fixes 5+6:
// D1: before-quit kills all workers; second-instance triggers an update check.
// D3: coordEmitStatus throttled to ~4/s (was per-message: hundreds/s on big pools —
//     the renderer full-grid rebuild storm behind the typing lockup).
// D4: elastic license timer does NOT start while stepping; it starts at Release.
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

// ── main.js: D1 + D4 ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes("app.on('before-quit'")) {
  m = rep(m, "app.on('window-all-closed',",
    [
      "// Phase 3 (D1): nothing ever killed workers on app quit — closing BUU mid-run orphaned",
      "// N worker processes (each holding a Chromium tree + a PestPac license) under the app's",
      "// own exe name. Kill them all on the way out; the pidfile sweep on next launch is the",
      "// backstop for anything this misses (e.g. a hard crash where before-quit never fires).",
      "app.on('before-quit', () => {",
      '  try { if (COORD.licenseTimer) { clearInterval(COORD.licenseTimer); COORD.licenseTimer = null; } } catch {}',
      '  try { for (const w of COORD.workers.values()) { try { if (w.process) w.process.kill(); } catch {} } } catch {}',
      '});',
      "app.on('window-all-closed',"
    ].join('\n'), 'before-quit');
  m = repRx(m, /(app\.on\('second-instance', \(\) => \{)/,
    "$1\n  // Phase 3 (D1): a second launch used to only focus the existing window — with lingering\n  // processes common, fresh launches were rare and the update prompt almost never appeared.\n  // Re-check on every second launch so updates surface even without a clean restart.\n  try { checkForUpdates(false); } catch {}", 'second-instance');
  m = repRx(m, /  \/\/ Elastic license loop\.\r?\n  if \(elastic && licenseProfileId\) \{/,
    [
      '  // Elastic license loop.',
      "  // Phase 3 (D4): NOT started while stepping — the timer used to scale up workers (each",
      '  // burning a login/license) while the user was still verifying row 1. It starts at',
      "  // Release (pool-run-control 'run-all') from the params stashed on COORD here.",
      '  COORD.elasticParams = (elastic && licenseProfileId)',
      '    ? { licenseProfileId, licenseBuffer, hwCap, intervalMs: Math.max(1, parseInt(licenseIntervalMin) || 5) * 60 * 1000 }',
      '    : null;',
      "  if (elastic && licenseProfileId && COORD.startMode !== 'step' && COORD.startMode !== 'step-row') {"
    ].join('\n'), 'elastic gate');
  m = rep(m, '    const tgt = (COORD.startModeTarget && COORD.startModeTarget.workers) || 1;',
    [
      '    // Phase 3 (D4): start the elastic license timer now that the user has Released.',
      '    if (COORD.elasticParams && !COORD.licenseTimer) {',
      '      const ep = COORD.elasticParams;',
      '      COORD.licenseTimer = setInterval(() => coordLicenseScale(ep.licenseProfileId, ep.licenseBuffer, ep.hwCap), ep.intervalMs);',
      '    }',
      '    const tgt = (COORD.startModeTarget && COORD.startModeTarget.workers) || 1;'
    ].join('\n'), 'release timer start');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main D1+D4 done');
} else console.log('main already done');

// ── coordinator.js: D3 throttle ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('_coordEmitStatusNow')) {
  c = rep(c, 'function coordEmitStatus(', [
    '// Phase 3 (D3): THROTTLE. coordEmitStatus used to fire on EVERY worker message — at',
    '// 100+ workers that is hundreds of full status broadcasts per second, each triggering',
    '// a full worker-grid innerHTML rebuild in the renderer. The render storm saturated the',
    '// renderer main thread and starved every input in the app ("can no longer type").',
    '// Coalesce to at most one broadcast per 250ms; a trailing emit catches the final state.',
    'let _emitTimer = null;',
    'let _emitPending = false;',
    'function coordEmitStatus() {',
    '  if (_emitTimer) { _emitPending = true; return; }',
    '  _coordEmitStatusNow();',
    '  _emitTimer = setTimeout(() => {',
    '    _emitTimer = null;',
    '    if (_emitPending) { _emitPending = false; coordEmitStatus(); }',
    '  }, 250);',
    '}',
    'function _coordEmitStatusNow('
  ].join('\n'), 'throttle wrapper');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator D3 done');
} else console.log('coordinator already done');
