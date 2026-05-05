const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const CURRENT_VERSION = '1.2.4';
const SERVICE_NAME = 'BetterUpdateUtility';
const VERSION_URL = 'https://raw.githubusercontent.com/EntomoBrandsMR/better-update-utility-release/main/version.json';

let mainWindow;
// Map of runId -> { process, runId, profileId, logPath, startedAt, runnerLogStream, runnerPath, credPath }
// For v1.2.3 only one entry can exist at a time; v1.3.0 will lift this cap.
const MAX_CONCURRENT_RUNS = 1;
const automationProcesses = new Map();
let keytar = null;
try { keytar = require('keytar'); } catch(e) {}

// ── PATHS ─────────────────────────────────────────────────────────────────────
function getLogsDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getFlowsDir() {
  const dir = path.join(app.getPath('userData'), 'flows');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getBrowsersDir() {
  const dir = path.join(app.getPath('userData'), 'browsers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── CREDENTIALS ───────────────────────────────────────────────────────────────
const CRED_KEY = crypto.scryptSync('better-update-utility-v1', 'buu-salt-2024', 32);
function credFilePath() { return path.join(app.getPath('userData'), 'credentials.enc'); }
function encStore(obj) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', CRED_KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), d: enc.toString('hex') });
}
function decStore(raw) {
  try {
    const { iv, d } = JSON.parse(raw);
    const dc = crypto.createDecipheriv('aes-256-cbc', CRED_KEY, Buffer.from(iv, 'hex'));
    return JSON.parse(Buffer.concat([dc.update(Buffer.from(d, 'hex')), dc.final()]).toString('utf8'));
  } catch { return []; }
}
function readAllProfiles() {
  const f = credFilePath();
  return fs.existsSync(f) ? decStore(fs.readFileSync(f, 'utf8')) : [];
}
function writeAllProfiles(arr) { fs.writeFileSync(credFilePath(), encStore(arr)); }

// ── PROFILE IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('list-profiles', async () => readAllProfiles().map(({ id, name, loginUrl, username }) => ({ id, name, loginUrl, username })));

ipcMain.handle('save-profile', async (_, profile) => {
  if (keytar) {
    await keytar.setPassword(SERVICE_NAME, `${profile.id}:companyKey`, profile.companyKey || '');
    await keytar.setPassword(SERVICE_NAME, `${profile.id}:username`,   profile.username   || '');
    await keytar.setPassword(SERVICE_NAME, `${profile.id}:password`,   profile.password   || '');
  }
  const all = readAllProfiles();
  const i = all.findIndex(p => p.id === profile.id);
  if (i >= 0) all[i] = profile; else all.push(profile);
  writeAllProfiles(all);
  return { ok: true };
});

ipcMain.handle('get-profile', async (_, id) => {
  const all = readAllProfiles();
  const p = all.find(x => x.id === id);
  if (!p) return null;
  if (keytar) {
    return {
      ...p,
      companyKey: await keytar.getPassword(SERVICE_NAME, `${id}:companyKey`) || p.companyKey || '',
      username:   await keytar.getPassword(SERVICE_NAME, `${id}:username`)   || p.username   || '',
      password:   await keytar.getPassword(SERVICE_NAME, `${id}:password`)   || p.password   || '',
    };
  }
  return p;
});

ipcMain.handle('delete-profile', async (_, id) => {
  if (keytar) {
    for (const k of ['companyKey', 'username', 'password'])
      await keytar.deletePassword(SERVICE_NAME, `${id}:${k}`).catch(() => {});
  }
  writeAllProfiles(readAllProfiles().filter(p => p.id !== id));
  return { ok: true };
});

// ── CONFIG ────────────────────────────────────────────────────────────────────
function getConfigPath() { return path.join(app.getPath('userData'), 'buu-config.json'); }
function readConfig() { try { return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')); } catch { return {}; } }
function writeConfig(obj) { fs.writeFileSync(getConfigPath(), JSON.stringify({ ...readConfig(), ...obj })); }
ipcMain.handle('get-config', () => readConfig());
ipcMain.handle('set-config', (_, obj) => { writeConfig(obj); return { ok: true }; });

// ── CHROMIUM ──────────────────────────────────────────────────────────────────
function getBundledChromiumPath() {
  // When packaged, Chromium is bundled in resources/chromium/
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'chromium', 'chrome.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  // Dev: check local chromium folder in project directory
  const localChromium = path.join(__dirname, '..', 'chromium', 'chrome.exe');
  if (fs.existsSync(localChromium)) return localChromium;

  // Dev fallback — find in ms-playwright default location
  const localAppData = process.env.LOCALAPPDATA || '';
  const playwrightDir = path.join(localAppData, 'ms-playwright');
  if (fs.existsSync(playwrightDir)) {
    const chromiumDirs = fs.readdirSync(playwrightDir).filter(d => d.startsWith('chromium-'));
    for (const dir of chromiumDirs) {
      const exePath = path.join(playwrightDir, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exePath)) return exePath;
    }
  }
  return null;
}

ipcMain.handle('check-chromium', async () => {
  const execPath = getBundledChromiumPath();
  const resourcesPath = process.resourcesPath || 'N/A';
  const isPackaged = app.isPackaged;
  return { installed: !!execPath, path: execPath, resourcesPath, isPackaged };
});

ipcMain.handle('install-chromium', async () => {
  // Not needed when bundled — kept for compatibility
  return { ok: true };
});


// ── AUTOMATION RUNNER ─────────────────────────────────────────────────────────
ipcMain.handle('start-automation', async (_, { stepsJson, spreadsheetPath, profileId, headless, runId, resumeFromRow, errHandle, rowDelayMin, rowDelayMax, selectorTimeout, pageLoadMode, retryCount, breakerThreshold, reauthInterval, retryRowIndexes, startMode }) => {
  // startMode: 'step' | 'step-row' | 'run-all'  (added v1.2.4). Defaults to 'run-all' for back-compat.
  startMode = startMode || 'run-all';
  // v1.2.5 item 2.8: tunable speed/resilience settings. Defaults match design doc.
  selectorTimeout = (selectorTimeout != null) ? Math.min(60, Math.max(1, parseInt(selectorTimeout))) : 30;
  pageLoadMode = (pageLoadMode === 'load') ? 'load' : 'domcontentloaded';
  retryCount = (retryCount != null) ? Math.min(20, Math.max(0, parseInt(retryCount))) : 2;
  // v1.2.5 item 2.3b: consecutive-error circuit breaker. 0 = disabled.
  breakerThreshold = (breakerThreshold != null) ? Math.max(0, parseInt(breakerThreshold)) : 20;
  // v1.2.5 item 2.11: re-auth interval in minutes. 0 = disabled. Logic comes in Phase 7.
  reauthInterval = (reauthInterval != null) ? Math.min(480, Math.max(0, parseInt(reauthInterval))) : 120;
  // v1.2.5 item 2.12: retry-failed-rows. When set, runner processes ONLY these row indexes
  // (source-row numbers, 1-based). Empty/null means normal full-run behavior.
  retryRowIndexes = Array.isArray(retryRowIndexes) ? retryRowIndexes.map(n => parseInt(n)).filter(n => n > 0) : [];
  // Concurrency guard — refuse if at cap. Prevents zombie runners.
  if (automationProcesses.size >= MAX_CONCURRENT_RUNS) {
    const running = Array.from(automationProcesses.values())[0];
    const startedTime = running ? new Date(running.startedAt).toLocaleTimeString() : 'unknown';
    return { ok: false, error: `Another automation is already running (started ${startedTime}). Stop it first or wait for it to finish.` };
  }
  const steps = JSON.parse(stepsJson);
  const logPath = path.join(getLogsDir(), `BUU-log-${new Date().toISOString().slice(0,10)}-${runId}.xlsx`);
  const checkpointPath = path.join(app.getPath('userData'), `checkpoint-${runId}.json`);
  const runnerPath = path.join(os.tmpdir(), `buu-runner-${runId}.js`);
  const credPath = path.join(os.tmpdir(), `buu-cred-${runId}.enc`);

  // Open the runner log FIRST so any pre-spawn failure is captured.
  // (Was opened later — meaning chromium-not-found and other early errors left no trace.)
  const runnerLogPath = path.join(getLogsDir(), `buu-runner-${runId}.log`);
  let runnerLogStream;
  try {
    runnerLogStream = fs.createWriteStream(runnerLogPath, { flags: 'a' });
    runnerLogStream.write(`[${new Date().toISOString()}] start-automation called: runId=${runId} profileId=${profileId} spreadsheetPath=${spreadsheetPath}\n`);
  } catch (e) {
    return { ok: false, error: 'Cannot create runner log file at ' + runnerLogPath + ': ' + e.message };
  }

  // Expanded checkpoint v2 — written once at run start with full context so the run
  // can be resumed even after a crash, restart, or normal stop. The runner only updates
  // rowIndex/ts inside, never overwriting the context fields.
  let totalRowsForCheckpoint = 0;
  try {
    const probe = require('xlsx');
    const ext = path.extname(spreadsheetPath).toLowerCase();
    if (ext === '.csv') {
      totalRowsForCheckpoint = Math.max(0, fs.readFileSync(spreadsheetPath, 'utf8').split('\n').filter(Boolean).length - 1);
    } else {
      const wb = probe.readFile(spreadsheetPath);
      totalRowsForCheckpoint = probe.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).length;
    }
  } catch {}
  try {
    fs.writeFileSync(checkpointPath, JSON.stringify({
      schemaVersion: 2,
      runId,
      profileId,
      spreadsheetPath,
      spreadsheetName: path.basename(spreadsheetPath),
      flowSnapshot: steps,
      headless: !!headless,
      errHandle: errHandle || 'retry',
      rowDelayMin: rowDelayMin || 0,
      rowDelayMax: rowDelayMax || 0,
      selectorTimeout,
      pageLoadMode,
      retryCount,
      breakerThreshold,
      reauthInterval,
      retryRowIndexes,
      totalRows: totalRowsForCheckpoint,
      startedAt: new Date().toISOString(),
      rowIndex: resumeFromRow || 0,
      ts: new Date().toISOString(),
      logPath,
    }));
  } catch (e) {
    // Non-fatal — run still proceeds without resume capability if userData is read-only
    console.error('Failed to write initial checkpoint:', e.message);
  }

  // Write credentials to temp encrypted file
  const all = readAllProfiles();
  const prof = all.find(p => p.id === profileId) || {};
  if (keytar) {
    prof.companyKey = await keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
    prof.username   = await keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
    prof.password   = await keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
  }
  fs.writeFileSync(credPath, encStore([prof]));

  // Get chromium path FIRST before anything else
  const chromiumExe = getBundledChromiumPath();
  if (!chromiumExe) {
    const errMsg = `Browser engine not found. Expected at: ${path.join(process.resourcesPath || '', 'chromium', 'chrome.exe')}. Please reinstall the application.`;
    runnerLogStream.write(`[${new Date().toISOString()}] FATAL: ${errMsg}\n`);
    runnerLogStream.end();
    mainWindow?.webContents.send('automation-event', { type: 'error', message: errMsg });
    mainWindow?.webContents.send('automation-event', { type: 'done', code: 1, logPath });
    try { fs.unlinkSync(credPath); } catch {}
    return { ok: false, error: 'Chromium not found' };
  }

  // Write runner script with chromium path baked in
  const script = buildRunner(steps, logPath, checkpointPath, resumeFromRow || 0, headless, errHandle || 'retry', rowDelayMin || 0, rowDelayMax || 0, chromiumExe, startMode, selectorTimeout, pageLoadMode, retryCount, breakerThreshold, reauthInterval, retryRowIndexes);
  fs.writeFileSync(runnerPath, script);

  const env = { ...process.env };

  // Point NODE_PATH so runner can find playwright-core etc
  // When packaged, node_modules live next to app.asar in resources
  const nodeModulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : path.join(__dirname, '..', 'node_modules');
  env.NODE_PATH = nodeModulesPath;
  env.BUU_NODE_MODULES = nodeModulesPath;

  // Electron's process.execPath runs Electron, not Node.
  // Pass ELECTRON_RUN_AS_NODE=1 so Electron acts as plain Node for the runner.
  env.ELECTRON_RUN_AS_NODE = '1';

  // Append spawn-time details to the already-open runner log
  runnerLogStream.write(`[${new Date().toISOString()}] Runner spawning\n`);
  runnerLogStream.write(`[${new Date().toISOString()}] execPath: ${process.execPath}\n`);
  runnerLogStream.write(`[${new Date().toISOString()}] runnerPath: ${runnerPath}\n`);
  runnerLogStream.write(`[${new Date().toISOString()}] ELECTRON_RUN_AS_NODE: ${env.ELECTRON_RUN_AS_NODE}\n`);
  runnerLogStream.write(`[${new Date().toISOString()}] NODE_PATH: ${env.NODE_PATH}\n`);

  automationProcesses.set(runId, { process: null, runId, profileId, logPath, startedAt: Date.now(), runnerLogStream, runnerPath, credPath });

  const proc = spawn(process.execPath, [runnerPath, spreadsheetPath, credPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  // Update Map entry with the live process handle
  const entry = automationProcesses.get(runId);
  if (entry) entry.process = proc;

  proc.stderr.on('data', data => {
    runnerLogStream.write(`[STDERR] ${String(data)}\n`);
    mainWindow?.webContents.send('automation-event', { type: 'stderr', message: String(data) });
  });
  proc.stdout.on('data', data => {
    runnerLogStream.write(`[STDOUT] ${String(data)}\n`);
    String(data).split('\n').filter(Boolean).forEach(line => {
      try { mainWindow?.webContents.send('automation-event', JSON.parse(line)); } catch {}
    });
  });
  proc.on('close', code => {
    runnerLogStream.write(`[${new Date().toISOString()}] Runner exited with code: ${code}\n`);
    runnerLogStream.end();
    mainWindow?.webContents.send('automation-event', { type: 'done', code, logPath, runId });
    automationProcesses.delete(runId);
    try { fs.unlinkSync(runnerPath); } catch {}
    try { fs.unlinkSync(credPath); } catch {}
  });

  return { ok: true, logPath };
});

ipcMain.handle('stop-automation', (_, payload) => {
  const targetRunId = payload && payload.runId;
  if (targetRunId) {
    const entry = automationProcesses.get(targetRunId);
    if (entry && entry.process) { try { entry.process.kill(); } catch {} }
    automationProcesses.delete(targetRunId);
    return { ok: true, stopped: entry ? 1 : 0 };
  }
  // No runId given -> stop all (preserves v1.2.2 behavior)
  let stopped = 0;
  for (const [, entry] of automationProcesses) {
    if (entry.process) { try { entry.process.kill(); stopped++; } catch {} }
  }
  automationProcesses.clear();
  return { ok: true, stopped };
});

// Send a control command to a running runner via stdin (v1.2.4).
// cmd: 'next-step' | 'next-row' | 'run-all' | 'stop'
// If runId is omitted, applies to the (currently single) running runner.
ipcMain.handle('run-control', (_, payload) => {
  const { runId, cmd } = payload || {};
  if (!cmd) return { ok: false, error: 'Missing cmd' };
  let entry = null;
  if (runId) {
    entry = automationProcesses.get(runId);
  } else {
    entry = Array.from(automationProcesses.values())[0] || null;
  }
  if (!entry || !entry.process) return { ok: false, error: 'No running automation' };
  try {
    entry.process.stdin.write(JSON.stringify({ cmd }) + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-checkpoint', (_, runId) => {
  const p = path.join(app.getPath('userData'), `checkpoint-${runId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
});

// Find orphaned v2 checkpoints — runs that didn't complete cleanly.
// Returns an array of { runId, ts, startedAt, spreadsheetPath, spreadsheetName, profileId, rowIndex, totalRows, checkpointPath, profileExists, fileExists }
// Old (v1) checkpoints with only {rowIndex, ts} are filtered out — they predate this feature.
ipcMain.handle('find-orphan-checkpoints', () => {
  const dir = app.getPath('userData');
  const orphans = [];
  if (!fs.existsSync(dir)) return orphans;
  let files;
  try { files = fs.readdirSync(dir); } catch { return orphans; }
  const allProfiles = readAllProfiles();
  for (const f of files) {
    if (!/^checkpoint-.+\.json$/.test(f)) continue;
    const checkpointPath = path.join(dir, f);
    try {
      const c = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      // Skip v1 (no schemaVersion or no flowSnapshot) — can't resume those
      if (c.schemaVersion !== 2 || !c.flowSnapshot || !c.spreadsheetPath) continue;
      // Skip if currently running
      if (automationProcesses.has(c.runId)) continue;
      orphans.push({
        runId: c.runId,
        ts: c.ts,
        startedAt: c.startedAt,
        spreadsheetPath: c.spreadsheetPath,
        spreadsheetName: c.spreadsheetName || path.basename(c.spreadsheetPath),
        profileId: c.profileId,
        rowIndex: c.rowIndex || 0,
        totalRows: c.totalRows || 0,
        checkpointPath,
        profileExists: !!allProfiles.find(p => p.id === c.profileId),
        fileExists: fs.existsSync(c.spreadsheetPath),
        // v1.2.5 item 2.7: forward the stop-reason annotations so the modal can show them.
        lastError: c.lastError || null,
        lastStop: c.lastStop || null,
      });
    } catch {}
  }
  // Most recent first
  orphans.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return orphans;
});

// Hydrate the full checkpoint (including flowSnapshot) for a Resume action.
// Separate from find-orphan-checkpoints to keep the orphan list payload small.
ipcMain.handle('load-checkpoint', (_, checkpointPath) => {
  if (!checkpointPath || !fs.existsSync(checkpointPath)) return null;
  try { return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); } catch { return null; }
});

ipcMain.handle('discard-checkpoint', (_, checkpointPath) => {
  try { if (checkpointPath && fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── RUNNER SCRIPT BUILDER ─────────────────────────────────────────────────────
function buildRunner(steps, logPath, checkpointPath, resumeFrom, headless, errHandle, rowDelayMin, rowDelayMax, chromiumExePath, startMode, selectorTimeout, pageLoadMode, retryCount, breakerThreshold, reauthInterval, retryRowIndexes) {
  return `
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// v1.2.5 item 2.8 (Phase 7): TCP probe for network-aware retry. Builtin module — no NODE_PATH needed.
const net = require('net');

const SPREADSHEET = process.argv[2];
const CRED_PATH = process.argv[3];

// Resolve modules from app node_modules
const _nm = process.env.NODE_PATH || path.join(__dirname);
function _require(mod){
  try{return require(mod);}catch(e){
    try{return require(path.join(_nm,mod));}catch(e2){
      throw new Error('Cannot find: '+mod+' (tried NODE_PATH: '+_nm+')');
    }
  }
}
if(process.env.NODE_PATH){
  try{require('module').Module._initPaths();}catch(e){}
}

const { chromium } = _require('playwright-core');
const XLSX = _require('xlsx');
const LOG_PATH = ${JSON.stringify(logPath)};
const CHECKPOINT = ${JSON.stringify(checkpointPath)};
const RESUME_FROM = ${resumeFrom};
const HEADLESS = ${headless};
const ERR_HANDLE = ${JSON.stringify(errHandle)};
const ROW_DELAY_MIN = ${Math.round(parseFloat(rowDelayMin) * 1000)};
const ROW_DELAY_MAX = ${Math.round(parseFloat(rowDelayMax) * 1000)};
// v1.2.5 item 2.8: tunable speed/resilience
const SELECTOR_TIMEOUT = ${parseInt(selectorTimeout) * 1000};
const PAGE_LOAD_MODE = ${JSON.stringify(pageLoadMode)};
const RETRY_COUNT = ${parseInt(retryCount)};
// v1.2.5 item 2.3b: consecutive-error circuit breaker (0 = disabled)
const BREAKER_THRESHOLD = ${parseInt(breakerThreshold)};
// v1.2.5 item 2.11: re-auth interval in ms. 0 = disabled. Logic comes in Phase 7.
const REAUTH_INTERVAL_MS = ${parseInt(reauthInterval) * 60 * 1000};
// v1.2.5 item 2.12: retry-failed-rows. When non-empty, runner processes ONLY these source-row
// numbers (1-based). Use a Set for O(1) lookup since retry runs scan every source row.
const RETRY_ROW_INDEXES = new Set(${JSON.stringify(retryRowIndexes || [])});
const IS_RETRY_RUN = RETRY_ROW_INDEXES.size > 0;

// Run-mode state machine (v1.2.4).
// START_MODE is the initial mode; currentMode is mutated by stdin commands.
// Modes: 'step' = pause before each action; 'step-row' = pause after each row;
//        'run-all' = no pausing; 'stop' = clean shutdown requested.
const START_MODE = ${JSON.stringify(startMode || 'run-all')};
let currentMode = START_MODE;

// Stdin command reader. Each line is a JSON object: {"cmd":"next-step"|"next-row"|"run-all"|"stop"}.
// 'next-step' / 'next-row' resolve a pending pause without changing mode.
// 'run-all' switches mode to run-all (and resolves any pending pause).
// 'stop' switches mode to stop and resolves any pending pause; the loop checks for it.
const _readline = require('readline');
let _pendingResolve = null;
const _rl = _readline.createInterface({ input: process.stdin, terminal: false });
_rl.on('line', function(line){
  let msg;
  try { msg = JSON.parse(line); } catch(e) { return; }
  if (!msg || !msg.cmd) return;
  if (msg.cmd === 'run-all') currentMode = 'run-all';
  if (msg.cmd === 'stop') currentMode = 'stop';
  if (_pendingResolve) { const r = _pendingResolve; _pendingResolve = null; r(msg.cmd); }
});
function waitForCommand(){
  if (currentMode === 'run-all' || currentMode === 'stop') return Promise.resolve('auto');
  return new Promise(function(r){ _pendingResolve = r; });
}

// v1.2.5 item 2.8 (Phase 7): Network-aware retry.
// probeNetwork() does a single TCP connect to PestPac and resolves true/false within 5s.
// Source of truth for "are we connected" — error strings from Playwright are heterogeneous
// and unreliable as a sole classifier. We probe AFTER any row failure to decide whether
// to enter the wait-and-ping loop or fall through to the existing retry/skip logic.
function probeNetwork(){
  return new Promise(function(resolve){
    const sock = net.connect({ host: 'app.pestpac.com', port: 443, timeout: 5000 });
    let done = false;
    const finish = function(ok){
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      resolve(ok);
    };
    sock.once('connect', function(){ finish(true); });
    sock.once('error', function(){ finish(false); });
    sock.once('timeout', function(){ finish(false); });
  });
}

// waitForNetwork() loops with backoff until probeNetwork() returns true.
// Honors the user-stop sentinel — if currentMode flips to 'stop' during the wait,
// throws __STOP__ so the row catch handler bails cleanly. Returns total ms waited.
async function waitForNetwork(){
  const startWait = Date.now();
  let attempt = 0;
  const backoffs = [5000, 10000, 30000, 60000];
  while (true) {
    if (await probeNetwork()) return Date.now() - startWait;
    const wait = backoffs[Math.min(attempt, backoffs.length - 1)];
    attempt++;
    emit({
      type: 'heartbeat',
      phase: 'waiting-for-internet',
      attempt: attempt,
      waitMs: wait,
      totalWaitedMs: Date.now() - startWait
    });
    await new Promise(function(r){ setTimeout(r, wait); });
    if (currentMode === 'stop') throw new Error('__STOP__');
  }
}

// v1.2.5 item 2.10 (Phase 8): error classifier.
// Maps an error message to one of seven categories for the new Excel log column.
// String-based heuristic (vs 2.8's probe-based gate) — sufficient for forensic column,
// not used for runtime decisions. Order matters: more-specific patterns checked first.
function classifyError(errMsg){
  const m = String(errMsg || '');
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(m)) return 'internet-down';
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNREFUSED|ECONNRESET/i.test(m)) return 'pestpac-down';
  if (/ERR_|net::/i.test(m)) return 'unknown-network';
  if (/waitForSelector.*Timeout|waiting for selector/i.test(m)) return 'selector';
  if (/Timeout|timed out|TimeoutError/i.test(m)) return 'timeout';
  if (/Assert failed|HTTP 4\\d\\d|status code 4\\d\\d/i.test(m)) return 'validation';
  return 'unknown';
}

// v1.2.5 item 2.10 (Phase 8): phase classifier from error message.
// Heuristic — distinguishes pre-action (waitForSelector failed) from action (click/type
// itself failed) from post-action (assert / follow-up wait failed). Saves us from
// instrumenting every runStep case individually for v1.2.5.
function classifyPhase(errMsg){
  const m = String(errMsg || '');
  if (/waitForSelector|waiting for selector|timeout.*selector/i.test(m)) return 'pre-action';
  if (/Assert failed/i.test(m)) return 'post-action';
  if (/Navigation failed|page\\.goto/i.test(m)) return 'action';
  return 'action';  // default — most errors are action-phase
}

// Resolve a preview snapshot of what's about to happen, used during pauses.
// Mirrors the substitution logic in runStep's r() but does not touch the page.
function resolvePreview(step, row, creds){
  const r = function(v){
    if(!v) return '';
    return v.replace(/{{CRED:companyKey}}/g, creds.companyKey||'')
            .replace(/{{CRED:username}}/g, creds.username||'')
            .replace(/{{CRED:password}}/g, creds.password||'')
            .replace(/{{([^}]+)}}/g, function(_, col){ return row[col] !== undefined ? String(row[col]) : ''; });
  };
  let value = '';
  if (step.type === 'type' || step.type === 'select') value = r(step.value || '');
  else if (step.type === 'navigate') value = r(step.url || '');
  else if (step.type === 'textedit') value = '(textedit: ' + (step.editMode || 'find-replace') + ')';
  else if (step.type === 'checkbox') value = '(' + (step.checkAction || 'check') + ')';
  else if (step.type === 'wait') value = '(' + (step.waitType || 'fixed') + ')';
  return {
    type: step.type,
    label: step._label || step.type,
    selector: step.selector || '',
    value: value,
  };
}

const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\\n');}
function saveChk(row){try{
  let prev={};try{prev=JSON.parse(fs.readFileSync(CHECKPOINT,'utf8'));}catch{}
  prev.rowIndex=row;prev.ts=new Date().toISOString();
  fs.writeFileSync(CHECKPOINT,JSON.stringify(prev));
}catch{}}

const ALL_STEPS = ${JSON.stringify(steps)};
const LOGIN_STEPS = ALL_STEPS.filter(s => s.locked && s.type !== 'pestpac-logout');
const DATA_STEPS  = ALL_STEPS.filter(s => !s.locked && s.type !== 'pestpac-logout');
const LOGOUT_STEP = ALL_STEPS.find(s => s.type === 'pestpac-logout') || {type:'pestpac-logout'};

let logEntries=[], flushTimer=null;
function addLog(e){logEntries.push(e);if(logEntries.length%100===0)flush();else{clearTimeout(flushTimer);flushTimer=setTimeout(flush,3000);}}
function flush(){
  // Always write at least a Summary sheet, even with zero rows, so the user
  // has evidence the run happened. Previously returned early on empty logEntries,
  // which meant a run that died before any row completed produced no Excel log.
  let attempt=0;
  const maxAttempts=3;
  while(attempt<maxAttempts){
    attempt++;
    try{
      const wb=XLSX.utils.book_new();
      const ok=logEntries.filter(e=>e.status==='ok'||e.status==='ok (retry)');
      const errs=logEntries.filter(e=>e.status==='error');
      const skipped=logEntries.filter(e=>e.status==='skip');
      XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([
        {Metric:'Total processed',Value:logEntries.length},
        {Metric:'Successful',Value:ok.length},
        {Metric:'Errors',Value:errs.length},
        {Metric:'Skipped',Value:skipped.length},
        {Metric:'Success rate',Value:logEntries.length?Math.round(ok.length/logEntries.length*100)+'%':'N/A'},
        {Metric:'Last updated',Value:new Date().toLocaleString()},
        {Metric:'Phase at last flush',Value:(typeof _hbState!=='undefined'&&_hbState&&_hbState.phase)||'unknown'},
      ]),'Summary');
      if(logEntries.length){
        XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(logEntries),'All rows');
        if(errs.length)XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(errs),'Errors only');
        if(skipped.length)XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(skipped),'Skipped');
      } else {
        XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([
          {Note:'No rows were processed before this log was flushed. Check the runner log (.log file in the same folder) for diagnostic details.'}
        ]),'Note');
      }
      XLSX.writeFile(wb,LOG_PATH);
      return;
    }catch(e){
      if(attempt>=maxAttempts){
        emit({type:'log-error',message:e.message+' (after '+attempt+' attempts at '+LOG_PATH+')'});
        return;
      }
      // Likely a file lock (Excel/OneDrive). Wait briefly and retry.
      const wait=Date.now()+800;while(Date.now()<wait){}
    }
  }
}

async function* streamRows(fp){
  const ext=path.extname(fp).toLowerCase();
  if(ext==='.csv'){
    const lines=fs.readFileSync(fp,'utf8').split('\\n').filter(Boolean);
    const headers=lines[0].split(',').map(h=>h.trim().replace(/^"|"$/g,''));
    for(let i=1;i<lines.length;i++){
      const vals=lines[i].split(',').map(v=>v.trim().replace(/^"|"$/g,''));
      const row={};headers.forEach((h,j)=>row[h]=vals[j]||'');
      yield row;
    }
  }else{
    const wb=XLSX.readFile(fp);
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    for(const row of rows)yield row;
  }
}

async function countRows(fp){
  const ext=path.extname(fp).toLowerCase();
  if(ext==='.csv'){const c=fs.readFileSync(fp,'utf8').split('\\n').filter(Boolean).length;return Math.max(0,c-1);}
  const wb=XLSX.readFile(fp);return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).length;
}

// v1.2.5 item 2.11 (Phase 7): shared login function. Used by:
//   1. The initial LOGIN_STEPS run (via the pestpac-login step case below)
//   2. Timer-based re-auth (every REAUTH_INTERVAL_MS at row boundaries)
//   3. Connectivity-wait > 10 min (after waitForNetwork() returns)
//   4. Detection-based re-auth (when row-start detects login URL)
// Throws if any step in the sequence fails. Caller decides whether that's fatal.
async function loginToPestPac(page, creds){
  await page.goto(creds.loginUrl||'https://login.pestpac.com/',{waitUntil:'load',timeout:30000});
  await page.waitForSelector('input[name="uid"]',{timeout:15000});
  await page.fill('input[name="uid"]','');
  await page.fill('input[name="uid"]',creds.companyKey||'');
  await page.click('button[data-testid="CompanyKeyForm-loginBtn"]');
  await page.waitForSelector('input[name="username"]',{timeout:15000});
  await page.fill('input[name="username"]',creds.username||'');
  await page.fill('input[name="password"]',creds.password||'');
  await page.click('button[data-testid="loginBtn"]');
  await page.waitForSelector('a[href*="AutoLogin"]',{timeout:30000});
}

async function runStep(page,step,row,creds){
  const r=v=>{if(!v)return'';return v.replace(/{{CRED:companyKey}}/g,creds.companyKey||'').replace(/{{CRED:username}}/g,creds.username||'').replace(/{{CRED:password}}/g,creds.password||'').replace(/{{([^}]+)}}/g,(_,col)=>row[col]!==undefined?String(row[col]):'');};
  const ms=s=>Math.round(parseFloat(s||1)*1000);
  switch(step.type){
    case 'navigate':{const _navUrl=r(step.url);emit({type:'log',message:'Navigate → '+(_navUrl||'(empty URL!)')});if(!_navUrl)throw new Error('Navigate URL resolved to empty — check the navigate step\\'s URL field and the column token (e.g. {{URL}}) matches your spreadsheet header exactly.');await page.goto(_navUrl,{waitUntil:PAGE_LOAD_MODE,timeout:30000});break;}
    case 'click':await page.waitForSelector(step.selector,{timeout:SELECTOR_TIMEOUT});await page.click(step.selector);if(step.waitFor)await page.waitForSelector(step.waitFor,{timeout:SELECTOR_TIMEOUT});break;
    case 'type':await page.waitForSelector(step.selector,{timeout:SELECTOR_TIMEOUT});if(step.clearFirst!=='no')await page.fill(step.selector,'');if(parseInt(step.typeDelay||0)>0)await page.type(step.selector,r(step.value),{delay:parseInt(step.typeDelay)});else await page.fill(step.selector,r(step.value));break;
    case 'select':await page.waitForSelector(step.selector,{timeout:SELECTOR_TIMEOUT});await page.selectOption(step.selector,{label:r(step.value)});break;
    case 'checkbox':await page.waitForSelector(step.selector,{timeout:SELECTOR_TIMEOUT});if(step.checkAction==='check')await page.check(step.selector);else if(step.checkAction==='uncheck')await page.uncheck(step.selector);else if(step.checkAction==='toggle')await page.click(step.selector);else if(step.checkAction==='conditional'){const tv=(step.truthyVals||'yes,true,1,x').split(',').map(v=>v.trim().toLowerCase());if(tv.includes(String(r(step.condCol)).trim().toLowerCase()))await page.check(step.selector);else await page.uncheck(step.selector);}break;
    case 'clear':await page.waitForSelector(step.selector,{timeout:SELECTOR_TIMEOUT});await page.fill(step.selector,'');break;
    case 'wait':if(step.waitType==='random'){const mn=ms(step.waitMin||1),mx=ms(step.waitMax||3);await page.waitForTimeout(Math.floor(Math.random()*(mx-mn+1))+mn);}else if(step.waitType==='element')await page.waitForSelector(step.waitSel||'',{timeout:30000});else if(step.waitType==='navigation')await page.waitForNavigation({timeout:30000});else await page.waitForTimeout(ms(step.waitSec||1));break;
    case 'assert':await page.waitForSelector(step.selector,{timeout:SELECTOR_TIMEOUT});if(step.expected){const t=await page.locator(step.selector).textContent();if(!t.includes(step.expected))throw new Error('Assert failed: expected "'+step.expected+'" got "'+t+'"');}break;
    case 'pestpac-login':{
      // v1.2.5 item 2.11 (Phase 7): delegate to shared helper. The body lives in
      // loginToPestPac() above so the same sequence is used by the three re-auth
      // triggers (timer / connectivity-wait / detection) without duplication.
      await loginToPestPac(page, creds);
      break;}
    case 'pestpac-logout':{
      // Navigate to search, click user menu, click Log Out
      await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'load',timeout:15000});
      await page.waitForSelector('div.select',{timeout:10000});
      await page.click('div.select');
      await page.waitForSelector('a.logout',{timeout:5000});
      await page.click('a.logout');
      await page.waitForTimeout(1500);
      break;}
    case 'dialog':{
      // Register a one-time dialog handler for the next dialog that appears
      const matchText = step.dialogMatch||'';
      const dialogAction = step.dialogAction||'accept';
      page.once('dialog', async dialog => {
        const msg = dialog.message();
        const matches = !matchText || msg.toLowerCase().includes(matchText.toLowerCase());
        emit({ type: 'dialog', message: msg, dialogType: dialog.type(), action: matches ? dialogAction : 'ignored' });
        if (matches) {
          if (dialogAction === 'dismiss') await dialog.dismiss();
          else await dialog.accept();
        } else {
          await dialog.dismiss();
        }
      });
      break;}
    case 'textedit':{
      await page.waitForSelector(step.selector,{timeout:SELECTOR_TIMEOUT});
      const currentVal = await page.$eval(step.selector, el => el.value || el.textContent || el.innerText || '');
      const rr = v => {if(!v)return'';return v.replace(/{{CRED:companyKey}}/g,creds.companyKey||'').replace(/{{CRED:username}}/g,creds.username||'').replace(/{{CRED:password}}/g,creds.password||'').replace(/{{([^}]+)}}/g,(_,col)=>row[col]!==undefined?String(row[col]):'');};
      const search = rr(step.searchVal||'');
      const replaceStr = rr(step.replaceVal||'');
      const ch = step.charVal||'@';
      const flags = (step.regexFlags||'gi');
      const ci = step.caseSensitive==='yes' ? '' : 'i';
      let newVal = currentVal;
      switch(step.editMode||'find-replace'){
        case 'find-replace':
          newVal = currentVal.split(search).join(replaceStr);
          if(step.caseSensitive!=='yes'){
            // Case-insensitive replace using split approach
            const searchLower=search.toLowerCase();
            const parts=currentVal.split('');
            let result='';let i=0;
            while(i<currentVal.length){
              if(currentVal.substring(i,i+search.length).toLowerCase()===searchLower){
                result+=replaceStr;i+=search.length;
              }else{result+=currentVal[i];i++;}
            }
            newVal=result;
          }
          break;
        case 'exact-remove':
          newVal = currentVal.split(search).join('');
          break;
        case 'partial-remove-word':
          newVal = currentVal.split(/\s+/).filter(w => !(step.caseSensitive==='yes' ? w.includes(search) : w.toLowerCase().includes(search.toLowerCase()))).join(' ').trim();
          break;
        case 'partial-remove-piece':
          newVal = currentVal.split(/\s+/).map(w => {
            const idx = step.caseSensitive==='yes' ? w.indexOf(search) : w.toLowerCase().indexOf(search.toLowerCase());
            if(idx<0) return w;
            return w.slice(0,idx) + w.slice(idx+search.length);
          }).join(' ').trim();
          break;
        case 'partial-replace-piece':
          newVal = currentVal.split(/\s+/).map(w => {
            const idx = step.caseSensitive==='yes' ? w.indexOf(search) : w.toLowerCase().indexOf(search.toLowerCase());
            if(idx<0) return w;
            return w.slice(0,idx) + replaceStr + w.slice(idx+search.length);
          }).join(' ').trim();
          break;
        case 'remove-after':
          {const idx=currentVal.indexOf(ch);if(idx>=0)newVal=currentVal.slice(0,idx);}
          break;
        case 'remove-before':
          {const idx=currentVal.indexOf(ch);if(idx>=0)newVal=currentVal.slice(idx+ch.length);}
          break;
        case 'trim':
          newVal = currentVal.trim();
          break;
        case 'remove-extra-spaces':
          newVal = currentVal.trim().replace(/  +/g,' ');
          break;
        case 'regex':
          try{newVal = currentVal.replace(new RegExp(search, flags), replace);}
          catch(e){throw new Error('Invalid regex pattern: '+search+' — '+e.message);}
          break;
      }
      // Write the new value back
      const tag = await page.$eval(step.selector, el => el.tagName.toLowerCase());
      if(tag==='input'||tag==='textarea'){
        await page.fill(step.selector, newVal);
      } else {
        await page.$eval(step.selector, (el,v) => { el.textContent=v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }, newVal);
      }
      break;}
  }
}

async function main(){
  const creds=dec(fs.readFileSync(CRED_PATH,'utf8'))[0]||{};
  const totalRows=await countRows(SPREADSHEET);
  emit({type:'start',totalRows,resumeFrom:RESUME_FROM});

  // Heartbeat — emit every 5 seconds so the UI can tell the runner is alive
  // even during slow operations like login or page navigation.
  let _hbState={phase:'starting',rowIndex:0,totalRows:totalRows,startedAt:Date.now()};
  const _heartbeat=setInterval(function(){
    emit({type:'heartbeat',phase:_hbState.phase,rowIndex:_hbState.rowIndex,totalRows:_hbState.totalRows,elapsed:Date.now()-_hbState.startedAt});
  },5000);
  process.on('exit',function(){clearInterval(_heartbeat);});

  const CHROMIUM_EXE = ${JSON.stringify(chromiumExePath)};
  if (!fs.existsSync(CHROMIUM_EXE)) {
    emit({ type: 'fatal', error: 'Bundled browser not found at: ' + CHROMIUM_EXE });
    flush();
    process.exit(1);
  }
  emit({ type: 'log', message: 'Using browser: ' + CHROMIUM_EXE });
  const browser = await chromium.launch({ headless: HEADLESS, executablePath: CHROMIUM_EXE });
  const page=await(await browser.newContext()).newPage();
  let ri=0,ok=0,errs=0,skipped=0,start=Date.now();
  // v1.2.5 item 2.3b: circuit breaker state
  let consecutiveErrors=0,lastSuccessfulRow=0,_breakerTripped=false;
  // v1.2.5 item 2.7: track user-initiated stops so the finally block can preserve
  // the checkpoint and annotate it with lastStop info.
  let _userStopRequested=false;

  // Run login steps once before the row loop
  _hbState.phase='logging-in';
  for(const step of LOGIN_STEPS){
    try{ await runStep(page,step,{},creds); }
    catch(e){ emit({type:'fatal',error:'Login failed at step '+( step._label||step.type)+': '+e.message}); flush(); await browser.close(); process.exit(1); }
  }

  // v1.2.5 item 2.11 (Phase 7): re-auth state and helpers.
  // Three triggers fire maybeReauth(reason):
  //   1. Timer: at row boundaries when Date.now() >= nextReauthAt (REAUTH_INTERVAL_MS=0 disables)
  //   2. Connectivity-wait: after waitForNetwork() returns waitedMs > 10*60*1000
  //   3. Detection: at row-start when isOnLoginPage() returns true
  // Re-auth never interleaves with row execution — all triggers fire at row boundaries
  // (or during the network-wait gate, which is between rows by definition).
  let nextReauthAt = REAUTH_INTERVAL_MS > 0 ? Date.now() + REAUTH_INTERVAL_MS : 0;
  async function maybeReauth(reason){
    emit({type:'log',message:'Re-authenticating ('+reason+')…'});
    _hbState.phase='reauth-'+reason;
    try{
      await loginToPestPac(page, creds);
      // Reset the timer regardless of which trigger fired — a fresh login means
      // we don't need another timer-based re-auth for REAUTH_INTERVAL_MS.
      if(REAUTH_INTERVAL_MS > 0) nextReauthAt = Date.now() + REAUTH_INTERVAL_MS;
      emit({type:'log',message:'Re-auth complete ('+reason+'). Continuing.'});
      _hbState.phase='running';
    }catch(e){
      // Re-auth failure is fatal — we can't proceed without a valid session.
      emit({type:'fatal',error:'Re-auth failed ('+reason+'): '+e.message});
      throw e;  // Caught by main()'s outer catch which writes lastError and exits.
    }
  }
  function isOnLoginPage(){
    try{
      const u = page.url() || '';
      // Match login.pestpac.com domain (initial login destination + session-expired redirect).
      return /login\\.pestpac\\.com/i.test(u);
    }catch{return false;}
  }

  try{
    _hbState.phase='running';
    // Emit initial mode so UI can position itself before the first row.
    emit({type:'mode',mode:currentMode});
    let _stopRequested=false;
    for await(const row of streamRows(SPREADSHEET)){
      if(_stopRequested) break;
      ri++;
      if(ri<=RESUME_FROM)continue;
      // v1.2.5 item 2.12: retry-failed mode skips any source row not in the retry set.
      // Increment ri (so log row numbers match source) but skip processing entirely.
      if(IS_RETRY_RUN && !RETRY_ROW_INDEXES.has(ri)) continue;
      _hbState.rowIndex=ri;
      saveChk(ri);

      // v1.2.5 item 2.11 (Phase 7): re-auth at row boundary.
      // Trigger 1 (timer): proactive re-auth before session expires. nextReauthAt=0 disables.
      if(nextReauthAt > 0 && Date.now() >= nextReauthAt){
        try{ await maybeReauth('timer'); }
        catch(e){ _stopRequested=true; break; }
      }
      // Trigger 3 (detection): if we're sitting on the login page, the session expired.
      // Re-auth before the row's navigate steps so they don't all fail with "selector not found".
      // Skipped if trigger 1 already ran (page is now post-login).
      else if(isOnLoginPage()){
        try{ await maybeReauth('detected-login-page'); }
        catch(e){ _stopRequested=true; break; }
      }

      emit({type:'row-start',rowIndex:ri,rowNum:ri,totalRows,url:row.URL||row.url||''});
      const t0=Date.now();
      const entry={row:ri,timestamp:new Date().toISOString(),url:row.URL||row.url||'',status:'ok',error:'',failedStep:'',fieldsWritten:'',durationMs:0,
        // v1.2.5 item 2.10 (Phase 8): rich error-attribution columns. Populated only on failure.
        errorCategory:'',phase:'',stepIndex:'',stepType:'',stepLabel:'',selector:'',attemptedValue:''};
      let done=[];
      // v1.2.5 item 2.10: tracks the in-flight step for attribution when runStep throws.
      // Updated by attempt() before each runStep call. Read by the outer catch.
      let _currentStepCtx=null;

      // attempt() walks DATA_STEPS, pausing before each step when in 'step' mode.
      // Throws '__STOP__' if user requested stop (caught below); throws '__NEXT_ROW__'
      // to short-circuit out of the step loop and proceed to the next row.
      const attempt=async()=>{
        done=[];
        for(let si=0;si<DATA_STEPS.length;si++){
          const s=DATA_STEPS[si];
          // v1.2.5 item 2.10: capture step context BEFORE runStep so the outer catch
          // (which doesn't have access to si) can attribute the error correctly.
          const _preview=resolvePreview(s,row,creds);
          _currentStepCtx={
            stepIndex:si,
            totalSteps:DATA_STEPS.length,
            stepType:s.type||'',
            stepLabel:s._label||'',
            selector:s.selector||'',
            attemptedValue:_preview.value||''
          };
          if(currentMode==='step'){
            emit({type:'pause-step',rowIndex:ri,totalRows,stepIndex:si,totalSteps:DATA_STEPS.length,step:_preview,row,mode:currentMode});
            const cmd=await waitForCommand();
            if(currentMode==='stop') throw new Error('__STOP__');
            if(cmd==='next-row') throw new Error('__NEXT_ROW__');
            // 'next-step' / 'run-all' / 'auto' all fall through to execute
          }
          await runStep(page,s,row,creds);
          done.push(s._label||s.type);
        }
        // Cleared after a successful walk so retry attempts don't carry stale context.
        _currentStepCtx=null;
      };

      try{
        await attempt();
        entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;ok++;
        // v1.2.5 item 2.3b: success resets the circuit breaker
        consecutiveErrors=0;lastSuccessfulRow=ri;
        emit({type:'row-done',rowIndex:ri,totalRows,status:'ok',url:entry.url,fieldsWritten:entry.fieldsWritten,durationMs:entry.durationMs,ok,errs,skipped,elapsed:Date.now()-start});
      }catch(e){
        // Clean stop sentinel — bail out of the row loop entirely.
        if(e && e.message==='__STOP__'){
          entry.status='stopped';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;
          addLog(entry);
          emit({type:'stopped',rowIndex:ri,reason:'user'});
          _userStopRequested=true;
          _stopRequested=true;
          break;
        }
        // User chose Next-row mid-step — record what got done, count as skip, move on.
        if(e && e.message==='__NEXT_ROW__'){
          entry.status='skip';entry.error='Skipped via Next-row during step-through';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;
          skipped++;
          emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:'(user skipped)',url:entry.url,ok,errs,skipped,elapsed:Date.now()-start});
        }else{
          // v1.2.5 item 2.8 (Phase 7): Network-aware retry gate.
          // Probe AFTER the failure to decide what kind of failure this is. If PestPac is
          // unreachable, wait for connectivity to come back and only THEN fall through to
          // the existing retry/skip logic — so the bounded retry attempts run on a fresh
          // connection instead of burning all 2 attempts during a multi-minute outage.
          // (This is the fix for the 5/1 disaster pattern: lost connectivity at row N,
          // 1991 subsequent rows all 'failed' because retries hit the same dead network.)
          try {
            if (await probeNetwork() === false) {
              emit({type:'log',message:'Network down detected at row '+ri+' — waiting for reconnection before retry. (User Stop will exit cleanly.)'});
              const waitedMs = await waitForNetwork();
              emit({type:'log',message:'Network restored after '+Math.round(waitedMs/1000)+'s. Resuming row '+ri+'.'});
              // v1.2.5 item 2.11 trigger 2: long outage probably expired the session.
              // Re-auth before the retry attempts so they don't waste budget hitting the login page.
              if (waitedMs > 10 * 60 * 1000) {
                try { await maybeReauth('connectivity-wait'); }
                catch(e){ _stopRequested=true; break; }
              }
            }
          } catch (waitErr) {
            // waitForNetwork() throws __STOP__ when user clicks Stop during the wait loop.
            if (waitErr && waitErr.message === '__STOP__') {
              entry.status='stopped';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;
              addLog(entry);
              emit({type:'stopped',rowIndex:ri,reason:'user-during-network-wait'});
              _userStopRequested=true;
              _stopRequested=true;
              break;
            }
            // Unexpected error from the network gate itself — log and fall through.
            emit({type:'log',message:'Network gate unexpected error: '+(waitErr && waitErr.message)+' — continuing with retry logic'});
          }
          // Fall through to the existing retry/skip handling. If we just waited for
          // connectivity, the retry attempts now operate on a fresh connection.
          if(ERR_HANDLE==='retry'){
          // v1.2.5 item 2.8: configurable retry count (was hardcoded 1 attempt).
          let retryAttempt = 0;
          let retrySucceeded = false;
          let lastError = e;
          while(retryAttempt < RETRY_COUNT && !retrySucceeded){
            retryAttempt++;
            emit({type:'row-retry',rowIndex:ri,error:lastError.message,attempt:retryAttempt,maxAttempts:RETRY_COUNT});
            try{
              await attempt();
              entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;entry.status='ok (retry)';ok++;
              emit({type:'row-done',rowIndex:ri,totalRows,status:'ok-retry',url:entry.url,fieldsWritten:entry.fieldsWritten,durationMs:entry.durationMs,ok,errs,skipped,elapsed:Date.now()-start});
              retrySucceeded = true;
            }catch(e2){
              // Retry-attempt sentinels also possible
              if(e2 && e2.message==='__STOP__'){entry.status='stopped';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;addLog(entry);emit({type:'stopped',rowIndex:ri,reason:'user'});_userStopRequested=true;_stopRequested=true;break;}
              if(e2 && e2.message==='__NEXT_ROW__'){entry.status='skip';entry.error='Skipped via Next-row during step-through';entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;skipped++;emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:'(user skipped)',url:entry.url,ok,errs,skipped,elapsed:Date.now()-start});retrySucceeded=true;break;}
              lastError = e2;
            }
          }
          if(_stopRequested) break;
          if(!retrySucceeded){
            const errMsg = retryAttempt === 0 ? e.message : ('After '+retryAttempt+' retry attempt(s): '+lastError.message);
            entry.status='skip';entry.error=errMsg;entry.failedStep=done[done.length-1]||'?';entry.fieldsWritten=done.slice(0,-1).join(' | ');entry.durationMs=Date.now()-t0;skipped++;
            // v1.2.5 item 2.10 (Phase 8): populate rich error-attribution columns from
            // the in-flight step ctx + classifier. Truncate attemptedValue per design.
            if(_currentStepCtx){
              entry.stepIndex='Step '+(_currentStepCtx.stepIndex+1)+' of '+_currentStepCtx.totalSteps;
              entry.stepType=_currentStepCtx.stepType;
              entry.stepLabel=_currentStepCtx.stepLabel;
              entry.selector=_currentStepCtx.selector;
              const av=_currentStepCtx.attemptedValue||'';
              entry.attemptedValue = av.length > 100 ? (av.slice(0,100)+'…') : av;
            }
            entry.errorCategory=classifyError(errMsg);
            entry.phase=classifyPhase(errMsg);
            // v1.2.5 item 2.3b: counts toward circuit breaker (BUU tried, couldn't make it work)
            consecutiveErrors++;
            emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:entry.failedStep,url:entry.url,ok,errs,skipped,elapsed:Date.now()-start,
              // v1.2.5 item 2.10: pass enrichment fields through to the live UI so the renderer can show e.g. status='skip' instead of misclassifying as 'FAILED'.
              status:entry.status,errorCategory:entry.errorCategory,phase:entry.phase,stepIndex:entry.stepIndex,stepType:entry.stepType});
          }
          }else{
            // ERR_HANDLE === 'skip' (legacy 'stop' handled by renderer-side upgrade per item 2.3)
            entry.status='skip';entry.error=e.message;entry.failedStep=done[done.length-1]||'?';entry.fieldsWritten=done.slice(0,-1).join(' | ');entry.durationMs=Date.now()-t0;
            // v1.2.5 item 2.10 (Phase 8): same enrichment as the retry-exhausted branch above.
            if(_currentStepCtx){
              entry.stepIndex='Step '+(_currentStepCtx.stepIndex+1)+' of '+_currentStepCtx.totalSteps;
              entry.stepType=_currentStepCtx.stepType;
              entry.stepLabel=_currentStepCtx.stepLabel;
              entry.selector=_currentStepCtx.selector;
              const av=_currentStepCtx.attemptedValue||'';
              entry.attemptedValue = av.length > 100 ? (av.slice(0,100)+'…') : av;
            }
            entry.errorCategory=classifyError(e.message);
            entry.phase=classifyPhase(e.message);
            skipped++;
            // v1.2.5 item 2.3b: counts toward circuit breaker
            consecutiveErrors++;
            emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:entry.failedStep,url:entry.url,ok,errs,skipped,elapsed:Date.now()-start,
              status:entry.status,errorCategory:entry.errorCategory,phase:entry.phase,stepIndex:entry.stepIndex,stepType:entry.stepType});
          }
        }
      }
      addLog(entry);

      // v1.2.5 item 2.3b: circuit breaker check. After threshold consecutive failures, stop the run
      // and preserve the checkpoint so user can resume. User-initiated skips (__NEXT_ROW__) don't
      // increment the counter, so they don't trip this.
      if(BREAKER_THRESHOLD > 0 && consecutiveErrors >= BREAKER_THRESHOLD){
        _breakerTripped=true;
        // Annotate the checkpoint with breaker info. Schema additions are forward-compatible — Phase 6 (item 2.7)
        // will generalize this with a richer lastError/lastStop schema, but this minimal write is enough today.
        try{
          if(fs.existsSync(CHECKPOINT)){
            const cp=JSON.parse(fs.readFileSync(CHECKPOINT,'utf8'));
            cp.lastError={phase:'circuit-breaker',consecutiveErrors,lastSuccessfulRow,rowIndex:ri,ts:new Date().toISOString()};
            fs.writeFileSync(CHECKPOINT,JSON.stringify(cp));
          }
        }catch(e){
          emit({type:'log',message:'Warning: could not annotate checkpoint with breaker info: '+e.message});
        }
        emit({type:'circuit-breaker',rowIndex:ri,totalRows,consecutiveErrors,lastSuccessfulRow,ok,errs,skipped,elapsed:Date.now()-start});
        _stopRequested=true;
        break;
      }

      // Row-pause point: if we're in step-row mode and not the last row, wait for user.
      // Pause comes BEFORE the inter-row delay so the wait isn't doubled while user is looking.
      if(currentMode==='step-row' && ri<totalRows && !_stopRequested){
        emit({type:'pause-row',rowIndex:ri,totalRows,ok,errs,skipped,elapsed:Date.now()-start,mode:currentMode});
        await waitForCommand();
        if(currentMode==='stop'){_userStopRequested=true;_stopRequested=true; break;}
      }

      if(ri<totalRows && !_stopRequested){const delay=Math.floor(Math.random()*(ROW_DELAY_MAX-ROW_DELAY_MIN+1))+ROW_DELAY_MIN;await page.waitForTimeout(delay);}
    }
  }finally{
    _hbState.phase='cleanup';
    flush();
    // v1.2.5 item 2.7: preserve checkpoint for any non-clean exit (breaker, user stop, fatal).
    // The runner's stop paths set _breakerTripped or _userStopRequested. The fatal path
    // (main().catch) writes lastError directly before exit and never reaches this finally.
    const _preserveCheckpoint = _breakerTripped || _userStopRequested;
    // Annotate user stops with lastStop. Breaker already wrote its own lastError above.
    if(_userStopRequested){
      try{
        if(fs.existsSync(CHECKPOINT)){
          const cp=JSON.parse(fs.readFileSync(CHECKPOINT,'utf8'));
          cp.lastStop={phase:'user-stop',rowIndex:ri,lastSuccessfulRow,ts:new Date().toISOString()};
          fs.writeFileSync(CHECKPOINT,JSON.stringify(cp));
        }
      }catch(e){
        emit({type:'log',message:'Warning: could not annotate checkpoint with stop info: '+e.message});
      }
    }
    if(!_preserveCheckpoint){
      try{fs.unlinkSync(CHECKPOINT);}catch{}
    }
    try{await runStep(page,LOGOUT_STEP,{},creds);}catch{}
    await browser.close();
    clearInterval(_heartbeat);
  }
  emit({type:'complete',totalRows:ri,ok,errs,skipped,elapsed:Date.now()-start,logPath:LOG_PATH});
}

main().catch(e=>{
  emit({type:'fatal',error:e.message});
  // v1.2.5 item 2.7: annotate checkpoint so the resume modal can show what went wrong.
  // The finally block in main() never ran, so we write directly here. Checkpoint is preserved
  // by virtue of NOT calling unlinkSync (the only deletion path lives in the finally block).
  try{
    if(fs.existsSync(CHECKPOINT)){
      const cp=JSON.parse(fs.readFileSync(CHECKPOINT,'utf8'));
      cp.lastError={phase:'fatal',message:e.message,stack:(e.stack||'').split('\\n').slice(0,5).join('\\n'),ts:new Date().toISOString()};
      fs.writeFileSync(CHECKPOINT,JSON.stringify(cp));
    }
  }catch{}
  try{flush();}catch{}
  process.exit(1);
});
`;
}

// ── AUTO UPDATE ───────────────────────────────────────────────────────────────
function fetchJSON(url, redirects) {
  redirects = redirects || 0;
  return new Promise((res, rej) => {
    if (redirects > 5) return rej(new Error('Too many redirects'));
    (url.startsWith('https') ? https : http).get(url, r => {
      if ([301,302,307,308].includes(r.statusCode) && r.headers.location) {
        r.resume();
        return res(fetchJSON(r.headers.location, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode + ' fetching ' + url)); }
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
      r.on('error', rej);
    }).on('error', rej);
  });
}
function downloadFile(url, dest, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    (url.startsWith('https') ? https : http).get(url, r => {
      // Follow redirects (GitHub release downloads always 302 to a CDN URL)
      if ([301,302,307,308].includes(r.statusCode) && r.headers.location) {
        r.resume();
        return resolve(downloadFile(r.headers.location, dest, redirects + 1));
      }
      if (r.statusCode !== 200) {
        r.resume();
        return reject(new Error('HTTP ' + r.statusCode + ' downloading ' + url));
      }
      const tot = parseInt(r.headers['content-length'] || '0');
      let recv = 0;
      const f = fs.createWriteStream(dest);
      r.on('data', c => { recv += c.length; if (tot > 0 && mainWindow) mainWindow.webContents.send('update-progress', Math.round(recv/tot*100)); });
      r.pipe(f);
      f.on('finish', () => f.close(err => {
        if (err) return reject(err);
        // Sanity check: refuse files smaller than 1 MB — almost certainly an error page, not a real installer
        try {
          const stat = fs.statSync(dest);
          if (stat.size < 1024 * 1024) { try { fs.unlinkSync(dest); } catch{} return reject(new Error('Downloaded file is only ' + stat.size + ' bytes — likely not a valid installer.')); }
        } catch(e) { return reject(e); }
        resolve();
      }));
      f.on('error', err => { try { fs.unlinkSync(dest); } catch{} reject(err); });
      r.on('error', reject);
    }).on('error', reject);
  });
}
function semverGt(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if((pa[i]||0)>(pb[i]||0)) return true; if((pa[i]||0)<(pb[i]||0)) return false; }
  return false;
}
async function checkForUpdates(manual) {
  if (VERSION_URL.includes('YOUR_HOST')) { if (manual) mainWindow.webContents.send('update-status', { type: 'not-configured' }); return; }
  try {
    const info = await fetchJSON(VERSION_URL);
    if (semverGt(info.version, CURRENT_VERSION)) mainWindow.webContents.send('update-available', info);
    else if (manual) mainWindow.webContents.send('update-status', { type: 'up-to-date', version: CURRENT_VERSION });
  } catch(e) { if (manual) mainWindow.webContents.send('update-status', { type: 'error', message: e.message }); }
}
ipcMain.handle('check-for-updates', () => checkForUpdates(true));
ipcMain.handle('install-update', async (_, { downloadUrl }) => {
  const updateDir = path.join(app.getPath('userData'), 'updates');
  if (!fs.existsSync(updateDir)) fs.mkdirSync(updateDir, { recursive: true });
  const tmp = path.join(updateDir, 'buu-update.exe');
  try {
    await downloadFile(downloadUrl, tmp);
    // Strip Zone.Identifier so SmartScreen doesn't block it
    try {
      const { execFileSync } = require('child_process');
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Unblock-File -Path '${tmp}'`
      ]);
    } catch {}
    shell.openPath(tmp);
    setTimeout(() => app.quit(), 2000);
    return { ok: true };
  }
  catch(e) { return { ok: false, error: e.message }; }
});

// ── FILE I/O ──────────────────────────────────────────────────────────────────
ipcMain.handle('open-spreadsheet', async () => {
  const lastDir = (readConfig() || {}).lastSpreadsheetDir;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open spreadsheet',
    filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile'],
    ...(lastDir ? { defaultPath: lastDir } : {})
  });
  if (r.canceled) return null;
  const fp = r.filePaths[0];
  try { writeConfig({ lastSpreadsheetDir: path.dirname(fp) }); } catch {}
  const XLSX = require('xlsx');
  const ext = fp.split('.').pop().toLowerCase();
  let headers = [], previewRows = [], totalRows = 0;
  if (ext === 'csv') {
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    previewRows = lines.slice(1, 9).map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
    totalRows = lines.length - 1;
  } else {
    const wb = XLSX.readFile(fp, { sheetRows: 10 });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    headers = (raw[0] || []).map(String).filter(Boolean);
    previewRows = raw.slice(1).filter(r => r.some(c => c !== ''));
    const wb2 = XLSX.readFile(fp);
    totalRows = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]]).length;
  }
  return { filePath: fp, name: path.basename(fp), headers, previewRows, totalRows };
});

ipcMain.handle('save-flow', async (_, { json, name }) => {
  const defaultName = (name || 'buu-flow') + '.json';
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Save flow',
    defaultPath: path.join(getFlowsDir(), defaultName),
    filters: [{ name: 'BUU Flow', extensions: ['json'] }]
  });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, json);
  return r.filePath;
});
ipcMain.handle('load-flow', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Load flow',
    defaultPath: getFlowsDir(),
    filters: [{ name: 'BUU Flow', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8');
});
ipcMain.handle('open-flows-folder', () => shell.openPath(getFlowsDir()));
ipcMain.handle('open-log-folder', () => shell.openPath(getLogsDir()));
ipcMain.handle('open-file', (_, p) => shell.openPath(p));
ipcMain.handle('get-version', () => CURRENT_VERSION);
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

// ── WINDOW ────────────────────────────────────────────────────────────────────
function getIconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'assets', 'icon.ico');
  return path.join(__dirname, '..', 'assets', 'icon.ico');
}

function createWindow() {
  const iconPath = getIconPath();
  mainWindow = new BrowserWindow({
    width: 1300, height: 900, minWidth: 1000, minHeight: 680,
    icon: iconPath,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    backgroundColor: '#0f0f11', show: false, title: 'Better Update Utility'
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); checkForUpdates(false); });
  mainWindow.setMenuBarVisibility(false);
}
// Single instance lock — prevent opening a second window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.setAppUserModelId('com.entomobands.better-update-utility');
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
