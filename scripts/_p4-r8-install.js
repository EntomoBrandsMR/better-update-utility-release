// _p4-r8-install.js — Phase 4 R8: C:\BUU fixed install root + upgrade-preserve + migration.
// package.json: oneClick installer pinned to C:\BUU (stable path = taskbar pins survive
// updates), desktop shortcut kept. installer.nsh: preInit forces InstallLocation; on
// UPDATE the old uninstaller parks flows\/logs\/failures\ in %TEMP% and customInstall
// restores them after the new files land. main.js: flows/logs/failures live under the
// install root when packaged (internal state — journals, spills, pidfile, creds — stays
// in userData; worker spills now target userData explicitly via runContext.userDataDir
// since the old dirname(dirname(LOG_PATH)) derivation breaks once logs leave userData).
// First-launch migration copies %APPDATA%\buu-2 flows/logs into the root.
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

// ── package.json nsis ──
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.build.nsis.allowToChangeInstallationDirectory !== false) {
  pkg.build.nsis.oneClick = true;
  pkg.build.nsis.perMachine = false;
  pkg.build.nsis.allowToChangeInstallationDirectory = false;
  pkg.build.nsis.createDesktopShortcut = true;
  pkg.build.nsis.createStartMenuShortcut = true;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('package.json done');
} else console.log('package.json already done');

// ── main.js: buuRoot + path fns + migration + runContext userDataDir ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('function buuRoot')) {
  m = repRx(m, /function getLogsDir\(\) \{\r?\n  const dir = path\.join\(app\.getPath\('userData'\), 'logs'\);/, [
    '// R8: everything USER-FACING lives next to the app under the fixed install root',
    '// (C:\\BUU when packaged): flows\\, logs\\, failures\\. Internal state — journals,',
    '// spill files, pidfile, config, credentials — stays in userData. Dev mode keeps',
    '// userData for everything so repo runs never touch C:\\.',
    'function buuRoot() {',
    "  return app.isPackaged ? path.dirname(process.execPath) : app.getPath('userData');",
    '}',
    'function getLogsDir() {',
    "  const dir = path.join(buuRoot(), 'logs');"
  ].join('\n'), 'logs dir');
  m = repRx(m, /function getFlowsDir\(\) \{\r?\n  const dir = path\.join\(app\.getPath\('userData'\), 'flows'\);/,
    "function getFlowsDir() {\n  const dir = path.join(buuRoot(), 'flows');", 'flows dir');
  m = repRx(m, /app\.whenReady\(\)\.then\(\(\) => \{\r?\n  sweepOrphanWorkers\(\);/, [
    'app.whenReady().then(() => {',
    '  migrateAppDataToBuuRoot();',
    '  sweepOrphanWorkers();'
  ].join('\n'), 'ready hook');
  m = rep(m, 'function sweepOrphanWorkers() {', [
    '// R8: one-time migration from the old %APPDATA%\\buu-2 layout into the install root.',
    '// Copy (not move) so a rollback to a pre-R8 build still finds its data.',
    'function migrateAppDataToBuuRoot() {',
    '  try {',
    '    if (!app.isPackaged) return;',
    '    const rootDir = buuRoot();',
    "    const ud = app.getPath('userData');",
    '    if (path.resolve(rootDir) === path.resolve(ud)) return;',
    "    for (const d of ['flows', 'logs']) {",
    '      const src = path.join(ud, d), dst = path.join(rootDir, d);',
    '      if (fs.existsSync(src) && !fs.existsSync(dst)) {',
    "        try { fs.cpSync(src, dst, { recursive: true }); console.log('[r8] migrated ' + d + ' -> ' + dst); } catch (e) { console.warn('[r8] migration of ' + d + ' failed: ' + e.message); }",
    '      }',
    '    }',
    '  } catch (e) {}',
    '}',
    '',
    'function sweepOrphanWorkers() {'
  ].join('\n'), 'migration fn');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');

// ── coordinator: userDataDir into runContext; worker: spill targets userData ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('userDataDir')) {
  c = rep(c, 'runContext: { runId: workerId, poolId: COORD.poolId, jobId,',
    "runContext: { runId: workerId, poolId: COORD.poolId, jobId, userDataDir: app.getPath('userData'),", 'runContext ud');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator done');
} else console.log('coordinator already done');

const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('userDataDir')) {
  w = rep(w, "  try { return path.join(path.dirname(path.dirname(LOG_PATH)), 'journal-spill-' + (RUN_CONTEXT.runId || ('w'+process.pid)) + '.jsonl'); }",
    [
      '  // R8: logs moved out of userData (C:\\BUU\\logs) so the old dirname(dirname(LOG_PATH))',
      '  // derivation no longer lands where mergeSpillFiles scans. The coordinator now passes',
      '  // userData explicitly; the derivation stays as the fallback for old runContexts.',
      "  try { return path.join(RUN_CONTEXT.userDataDir || path.dirname(path.dirname(LOG_PATH)), 'journal-spill-' + (RUN_CONTEXT.runId || ('w'+process.pid)) + '.jsonl'); }"
    ].join('\n'), 'spill path');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker done');
} else console.log('worker already done');

// ── build/installer.nsh: preInit fixed root + upgrade preserve ──
const np = path.join(root, 'build', 'installer.nsh');
let nsh = fs.readFileSync(np, 'utf8');
if (!nsh.includes('buu-preserve')) {
  nsh = nsh.replace(/\s*$/, '\n') + [
    '',
    '; R8: fixed install root C:\\BUU. A stable path means taskbar pins survive updates',
    '; (the old per-user versioned paths broke pins) and everything BUU lives in one place:',
    '; app files + flows\\ + logs\\ + failures\\.',
    '!macro preInit',
    '  SetRegView 64',
    '  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\\BUU"',
    '  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\\BUU"',
    '  SetRegView 32',
    '  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\\BUU"',
    '  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\\BUU"',
    '!macroend',
    '',
    '; R8: preserve user data through UPDATES. electron-builder runs the OLD uninstaller',
    '; first, which removes $INSTDIR recursively — park flows\\/logs\\/failures\\ in %TEMP%',
    '; on the way down (updates only; a real uninstall leaves nothing parked), then',
    '; customInstall restores them after the new files land. Rename is same-volume (C:)',
    '; so this is instant regardless of size.',
    '!macro customUnInstall',
    '  ${ifNot} ${isUpdated}',
    '    Goto buu_preserve_done',
    '  ${endIf}',
    '  CreateDirectory "$TEMP\\buu-preserve"',
    '  Rename "$INSTDIR\\flows" "$TEMP\\buu-preserve\\flows"',
    '  Rename "$INSTDIR\\logs" "$TEMP\\buu-preserve\\logs"',
    '  Rename "$INSTDIR\\failures" "$TEMP\\buu-preserve\\failures"',
    '  buu_preserve_done:',
    '!macroend',
    '',
    '!macro customInstall',
    '  IfFileExists "$TEMP\\buu-preserve\\flows\\*.*" 0 +2',
    '    Rename "$TEMP\\buu-preserve\\flows" "$INSTDIR\\flows"',
    '  IfFileExists "$TEMP\\buu-preserve\\logs\\*.*" 0 +2',
    '    Rename "$TEMP\\buu-preserve\\logs" "$INSTDIR\\logs"',
    '  IfFileExists "$TEMP\\buu-preserve\\failures\\*.*" 0 +2',
    '    Rename "$TEMP\\buu-preserve\\failures" "$INSTDIR\\failures"',
    '  RMDir "$TEMP\\buu-preserve"',
    '!macroend',
    ''
  ].join('\n');
  fs.writeFileSync(np, nsh, 'utf8');
  console.log('installer.nsh done');
} else console.log('installer.nsh already done');
