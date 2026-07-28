const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const CURRENT_VERSION = '3.1.6';
const SERVICE_NAME = 'BUU2';
// v2.0.0: BUU 2.0 is a SEPARATE installed app from BUU Legacy. It must not share data with
// Legacy — different credentials store, checkpoints, logs, config. We force a distinct
// userData directory so the two installs are fully isolated and can run side by side.
// Set BEFORE app is ready (see app.setPath call near startup).
// v2.0.0: BUU 2.0 has its OWN update channel so it never cross-wires with Legacy. Legacy
// reads version.json (1.3.x line); BUU 2.0 reads version-buu2.json (2.x line). The two apps
// never see each other's updates.
const VERSION_URL = 'https://raw.githubusercontent.com/EntomoBrandsMR/better-update-utility-release/main/version-buu2.json';

let mainWindow;
// R10 (v3.0.1): module scope on purpose. These were declared inside the single-instance
// `else` block, but createWindow()'s 'close' handler is a closure over MODULE scope — it
// could not see them, so EVERY close threw "forceClosing is not defined" and the
// unsaved-changes prompt never once worked. Boot smoke tests missed it because a
// force-kill never fires 'close'.
// v3.0.2: see coordinator.js — `if (mainWindow)` is not a guard, because a destroyed
// BrowserWindow stays truthy. Anything that fires during/after shutdown (worker exits,
// in-flight update fetches) crashed the main process with "Object has been destroyed".
function _send(channel, payload) {
  const w = mainWindow;
  if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed())) return false;
  try {
    const wc = w.webContents;
    if (!wc || wc.isDestroyed()) return false;
    wc.send(channel, payload);
    return true;
  } catch (e) { return false; }
}

let flowDirtyMain = false;
let forceClosing = false;
// R9/v3.0.1: MODULE scope on purpose. Same bug as forceClosing above — this was declared
// inside the single-instance `else` block, and a const gets no Annex B hoisting, so the
// module-scope save-flow handler threw "FLOW_SUBS is not defined" and Save flow silently
// did nothing (the dialog never opened). Never move these back inside a block.
const FLOW_SUBS = ['automation', 'once', 'general'];
// Map of runId -> { process, runId, profileId, logPath, startedAt, runnerLogStream, runnerPath, credPath }
// v1.3.4 Phase 3: cap is no longer a hard const of 1. It's a runtime ceiling that defaults to
// a hardware-derived suggestion (see computeHardwareCap) and can be overridden via config.
// The worker pool spawns up to this many concurrent workers. start-automation enforces it.
// Absolute safety ceiling regardless of config/hardware — prevents a typo'd config from
// trying to launch 10000 Chromiums. The hardware cap will almost always be lower.
// v2.1.0: raised 100->150. Stress test (#6) held 150 headless workers @ ~103MB each with
// 24GB free; the real binding limit is PestPac licenses (~131), not this machine.
const MAX_WORKERS_HARD_CEILING = 150;
// v1.3.4 Phase 3: estimate how many headless Chromium workers this machine can run.
// v2.1.0: re-derived from the stress test. Each headless worker measured ~103MB resident
// (not the old 600MB guess — that was 6x too conservative and capped us near 30). We budget
// ~150MB/worker for safety margin and use ~70% of free RAM so the machine stays responsive.
// Workers are IO-bound (waiting on PestPac network), so the CPU factor is generous. Returns >=1.
// R4 "comfortable" hardware cap: min(cores × multiplier, floor(freeGB × 0.5 / 0.35GB)).
// The multiplier is the tunable slider (default 3). ADVISORY only — the Workers slider
// may deliberately exceed it (UI turns amber past the cap). Old formula (0.70×freeRAM/
// 150MB, cores×6) retired with R4.
function computeHardwareCap(mult) {
  try {
    const freeGB = os.freemem() / (1024 * 1024 * 1024);
    const cpus = (os.cpus() || []).length || 2;
    const m2 = (mult && isFinite(mult)) ? Math.max(1, mult) : 3;
    return Math.max(1, Math.min(Math.round(cpus * m2), Math.floor((freeGB * 0.5) / 0.35), MAX_WORKERS_HARD_CEILING));
  } catch (e) {
    return 1; // safe fallback
  }
}
// The effective cap: config override if set and sane, else hardware suggestion.
function getMaxConcurrentRuns() {
  try {
    const cfg = readConfig();
    const override = cfg && parseInt(cfg.maxWorkers);
    if (override && override > 0) return Math.min(override, MAX_WORKERS_HARD_CEILING);
  } catch (e) {}
  return computeHardwareCap(COORD.scaleMultiplier);
}

// Phase 2: coordinator (COORD + coord*) lives in src/pool/coordinator.js; wired at EOF.
function countRowsSync(spreadsheetPath){
  try{
    const probe = require('xlsx');
    const ext = path.extname(spreadsheetPath).toLowerCase();
    if (ext === '.csv') {
      return Math.max(0, fs.readFileSync(spreadsheetPath,'utf8').split('\n').filter(Boolean).length - 1);
    }
    const wb = probe.readFile(spreadsheetPath);
    return probe.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).length;
  }catch(e){ return 0; }
}

// v3.0.2: HEADER WHITESPACE. A header entered as "Account Number " became the literal
// row key "Account Number ", so the {{Account Number}} anyone would actually type
// resolved to blank — silently, no error. Trim every key once at load.
// Paired with a matching trim of the token ref at resolution (engine/steps.js + worker
// resolvePreview), which makes the pair a STRICT SUPERSET: a flow built against the
// untrimmed header ({{Account Number }}) still resolves after this change.
// Clean sheets pay nothing — the remap only runs when a header is actually dirty.
function trimRowKeys(rows){
  if(!Array.isArray(rows) || !rows.length) return rows;
  let dirty = false;
  for(const k in rows[0]){ if(k !== String(k).trim()){ dirty = true; break; } }
  if(!dirty) return rows;
  return rows.map(function(r){ const o = {}; for(const k in r) o[String(k).trim()] = r[k]; return o; });
}
function loadRowsForJob(spreadsheetPath){
  const XLSX = require('xlsx');
  const ext = path.extname(spreadsheetPath).toLowerCase();
  if(ext === '.csv'){
    const wb = XLSX.readFile(spreadsheetPath, { raw:false });
    return trimRowKeys(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' }));
  }
  const wb = XLSX.readFile(spreadsheetPath);
  return trimRowKeys(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' }));
}

let keytar = null;
try { keytar = require('keytar'); } catch(e) {}

// ── PATHS ─────────────────────────────────────────────────────────────────────
// R8: everything USER-FACING lives next to the app under the fixed install root
// (C:\BUU when packaged): flows\, logs\, failures\. Internal state — journals,
// spill files, pidfile, config, credentials — stays in userData. Dev mode keeps
// userData for everything so repo runs never touch C:\.
function buuRoot() {
  return app.isPackaged ? path.dirname(process.execPath) : app.getPath('userData');
}
function getLogsDir() {
  const dir = path.join(buuRoot(), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getFlowsDir() {
  const dir = path.join(buuRoot(), 'flows');
  const fresh = !fs.existsSync(dir);
  if (fresh) fs.mkdirSync(dir, { recursive: true });
  // v2.0.0: one-time migration of Legacy's saved flows into BUU 2.0 (copy, not share).
  // Runs once — guarded by a .migrated marker — so after the copy the two apps stay fully
  // independent (editing a flow in 2.0 never touches Legacy's, and vice versa).
  migrateLegacyFlowsOnce(dir);
  // 3.0.7: seed flows bundled INTO the installer (Matthew: "every flow i make here on
  // my main computer is available wherever i install the BUU"). The build snapshots
  // the build machine's C:\BUU\flows into resources\flows-bundle (build/snapshot-
  // flows.js); here any bundled flow the local machine does NOT already have is
  // copied in. NEVER overwrites an existing file — local edits always win; to force
  // a re-seed of one flow, delete its .json and relaunch.
  seedBundledFlows(dir);
  return dir;
}
function seedBundledFlows(destDir) {
  try {
    if (!app.isPackaged) return; // dev runs never seed
    const bundle = path.join(process.resourcesPath, 'flows-bundle');
    if (!fs.existsSync(bundle)) return;
    let seeded = 0;
    const walk = (srcDir, dstDir) => {
      for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const s = path.join(srcDir, e.name);
        const d = path.join(dstDir, e.name);
        if (e.isDirectory()) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); walk(s, d); }
        else if (e.name.toLowerCase().endsWith('.json') && !fs.existsSync(d)) { fs.copyFileSync(s, d); seeded++; }
      }
    };
    walk(bundle, destDir);
    if (seeded) console.log('[seed] ' + seeded + ' bundled flow(s) copied into ' + destDir);
  } catch (e) { console.warn('[seed] bundled-flows seed failed: ' + e.message); }
}

// Copy Legacy's flow .json files into BUU 2.0's flows dir, exactly once. No-op for the Legacy
// build itself (its source dir == its dest dir). Marker file prevents re-copying so the user's
// own deletions/edits in 2.0 are never undone by a later launch.
function migrateLegacyFlowsOnce(destDir) {
  try {
    const marker = path.join(destDir, '.legacy-flows-migrated');
    if (fs.existsSync(marker)) return; // already migrated
    // Legacy's userData lives next to ours under %APPDATA% (roaming). Resolve its flows dir.
    const appData = app.getPath('appData'); // %APPDATA% (Roaming) — parent of all app userData dirs
    const legacyFlows = path.join(appData, 'better-update-utility', 'flows');
    // Guard: if this IS the Legacy app (same path), don't copy onto itself.
    if (path.normalize(legacyFlows) === path.normalize(destDir)) { return; }
    if (!fs.existsSync(legacyFlows)) {
      // No Legacy flows to copy (fresh machine, or Legacy never installed). Still drop the
      // marker so we don't re-scan every launch.
      fs.writeFileSync(marker, new Date().toISOString());
      return;
    }
    let copied = 0;
    for (const f of fs.readdirSync(legacyFlows)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const src = path.join(legacyFlows, f);
      const dst = path.join(destDir, f);
      try {
        if (!fs.existsSync(dst)) { fs.copyFileSync(src, dst); copied++; }
      } catch (e) { /* skip a single bad file, keep going */ }
    }
    fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), copied, from: legacyFlows }));
    console.log(`[migrate] copied ${copied} Legacy flow(s) into BUU 2.0`);
  } catch (e) {
    console.error('[migrate] flow migration failed (non-fatal):', e.message);
  }
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
ipcMain.handle('list-profiles', async () => readAllProfiles().map(({ id, name, loginUrl, username, platform }) => ({ id, name, loginUrl, username, platform })));

ipcMain.handle('save-profile', async (_, profile) => {
  if (keytar) {
    // keytar.setPassword rejects an empty string ("Password is required."), so an
    // empty secret (e.g. companyKey on a Frankware profile) must be DELETED, not set.
    // Storing empty here is what made Frankware profiles silently fail to save.
    for (const k of ['companyKey', 'username', 'password']) {
      const v = profile[k];
      if (v) await keytar.setPassword(SERVICE_NAME, `${profile.id}:${k}`, v);
      else   await keytar.deletePassword(SERVICE_NAME, `${profile.id}:${k}`).catch(() => {});
    }
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

// v2.2.3 Session 3E (B4): log retention. Delete per-worker .log streams, per-worker xlsx
// logs, and failure capture dirs older than maxAgeDays. Runs at app startup, asynchronously,
// so a slow disk doesn't block the UI. Journals live in userData directly (not under logs/),
// so they're outside the scope of this cleanup — they're kept until manually removed (they're
// the merged-log source of truth + resume metadata). Read-field results live next to the
// source spreadsheet (upcoming/results/), also outside scope.
//
// What this DELETES under <userData>/logs:
//   buu2-worker-*.log         per-worker debug streams
//   BUU2-log-*-w*.xlsx        per-worker xlsx logs
//   failures-pool*/           Session 3C diagnostic capture dirs (recursive)
// What this PRESERVES:
//   any file/dir not matching the patterns above (defensive — unknown files left alone)
//
// Config: cfg.logRetentionDays. Default 30. 0 disables.
function cleanupOldLogs(maxAgeDays){
  const days = Number.isFinite(maxAgeDays) ? maxAgeDays : 30;
  if (days <= 0) return;
  try {
    const dir = getLogsDir();
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let deletedFiles = 0, deletedDirs = 0;
    for (const e of entries) {
      const full = path.join(dir, e.name);
      let stat;
      try { stat = fs.statSync(full); } catch(_) { continue; }
      if (stat.mtimeMs >= cutoff) continue;
      if (e.isFile()) {
        const matches = /^buu2-worker-.*\.log$/i.test(e.name) || /^BUU2-log-.*\.xlsx$/i.test(e.name);
        if (!matches) continue;
        try { fs.unlinkSync(full); deletedFiles++; } catch(_) {}
      } else if (e.isDirectory()) {
        if (!/^failures-pool/.test(e.name)) continue;
        try { fs.rmSync(full, { recursive: true, force: true }); deletedDirs++; } catch(_) {}
      }
    }
    if (deletedFiles > 0 || deletedDirs > 0) {
      console.log('[cleanup] log retention removed ' + deletedFiles + ' file(s) and ' + deletedDirs + ' capture dir(s) older than ' + days + ' days');
    }
  } catch(e) {
    console.error('[cleanup] log retention failed:', e.message);
  }
}

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

// v1.3.4 Phase 3: worker-pool sizing. Returns the hardware-derived cap, the current config
// override (if any), the effective cap, and the raw inputs so the UI can explain the number.
ipcMain.handle('get-worker-caps', async () => {
  let cfgOverride = null;
  try { const c = readConfig(); if (c && parseInt(c.maxWorkers) > 0) cfgOverride = parseInt(c.maxWorkers); } catch(e){}
  return {
    hardwareCap: computeHardwareCap(COORD.scaleMultiplier),
    configOverride: cfgOverride,
    effectiveCap: getMaxConcurrentRuns(),
    hardCeiling: MAX_WORKERS_HARD_CEILING,
    freeMemGB: Math.round(os.freemem() / (1024*1024*1024) * 10) / 10,
    totalMemGB: Math.round(os.totalmem() / (1024*1024*1024) * 10) / 10,
    cpuCount: (os.cpus() || []).length,
    runningWorkers: COORD.workers.size,
  };
});

// Phase 2 refactor: canonical login moved to src/engine/login.js (single source; the
// v2.2.2 dual-copy + hand-sync rule is dead). File is read VERBATIM for template
// interpolation and require()'d for main-process use; alias preserves call sites.
const LOGIN_TO_PESTPAC_SRC = fs.readFileSync(path.join(__dirname, 'engine', 'login.js'), 'utf8');
const LOCATE_STACK_SRC = fs.readFileSync(path.join(__dirname, 'engine', 'locate.js'), 'utf8');
const STEPS_SRC = fs.readFileSync(path.join(__dirname, 'engine', 'steps.js'), 'utf8');
const { loginToPestPac: loginToPestPacInPage, logoutFromPestPac: logoutFromPestPacInPage, logoutFrom: logoutFromInPage } = require('./engine/login');
const mailer = require('./mailer'); // 3.x: MS Graph run-notification email (config in the vault)

// 3.x EMAIL CONFIG IPC — status/save/test for the Settings panel. Secrets go to the Windows
// Credential Vault via keytar (never the repo). status never returns the secret.
ipcMain.handle('email-config-status', async () => {
  try {
    const cfg = await mailer.getEmailConfig(keytar);
    const cid = String(cfg.clientId || '');
    return { ok: true, configured: true, fromMailbox: cfg.fromMailbox, tenantId: cfg.tenantId,
      clientIdMasked: cid ? (cid.slice(0, 8) + '…' + cid.slice(-4)) : '' };
  } catch (e) { return { ok: true, configured: false, error: e.message, defaultFrom: mailer.DEFAULT_FROM }; }
});
ipcMain.handle('email-config-save', async (_, cfg) => {
  try { await mailer.setEmailConfig(keytar, cfg || {}); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('email-send-test', async (_, { to }) => {
  try {
    const built = mailer.buildRunEmail({
      flowName: 'Email Test-flow', frequencyPhrase: 'once', scheduleTimeLabel: _fmtNowTimeLabel(),
      tz: 'America/New_York', startTs: Date.now() - 4000, endTs: Date.now(), ok: 1, err: 0, total: 1,
      trail: [{ n: 1, label: 'Confirm Microsoft Graph send', status: 'ok', ms: 900 }],
      poolId: 'email-test', recipients: to,
    });
    const r = await mailer.sendMail(keytar, { to, subject: 'BUU email test — ' + built.subject.replace(/^Success! /, ''), body: built.html, html: true });
    return { ok: true, sentTo: r.sentTo };
  } catch (e) { return { ok: false, error: e.message }; }
});
function _fmtNowTimeLabel() { try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date()); } catch (e) { return ''; } }

// ════════════════════════════════════════════════════════════════════════════
// v2.2.2 (Session 2A) — SHARED RUNTIME HELPERS (drift-proof, template-interpolated)
// ────────────────────────────────────────────────────────────────────────────
// Each constant below is the canonical source of a helper that previously lived
// duplicated across multiple spawned-child templates (buildRunner / buildPoolWorker /
// buildLogoutSweeper / buildOnceFlowRunner). Each template now interpolates the
// constant via ${NAME} instead of carrying its own copy. Same pattern as
// LOGIN_TO_PESTPAC_SRC above. Helpers chosen for extraction are the substantive
// shared ones (selector resolution, find-by-text); trivial one-liners like dec,
// emit, ms intentionally remain inline — extracting them adds churn for no
// behavioral payoff and they don't drift in practice.
//
// REQUIRE_FN_SRC: module resolution from spawned-child context. Both buildRunner
// and buildPoolWorker declare _nm separately (it captures NODE_PATH at child
// startup); _require itself depends on _nm being in scope. Templates that use
// _require must also declare _nm before interpolating REQUIRE_FN_SRC.
//
// FIND_LOCATOR_FN_SRC: iframe-walking selector resolver. Used by every
// step-engine template that needs to interact with PestPac form pages, which
// render content inside iframes. Canonical version is buildRunner's
// pretty-printed form with the detailed "Frames searched: [...]" error message.
//
// FIND_LOCATOR_MINIMAL_SRC: sweeper-only variant. Deliberately stripped (no
// iframe walk) because the sweeper's only step types are login/logout, both of
// which live in the top frame. Kept separate so the iframe-walking version
// never gets used by mistake in a context that doesn't need it.
//
// MATCHES_TEXT_FN_SRC / FIND_IN_CONTAINER_FN_SRC / RESOLVE_STEP_LOCATOR_FN_SRC:
// the find-by-text scoping stack (v1.3.0 Item 1). Only used by templates with a
// full step engine (buildRunner, buildPoolWorker) — sweeper and once-flow runner
// don't reference them, so they don't get interpolated there.
// ════════════════════════════════════════════════════════════════════════════
const REQUIRE_FN_SRC = `function _require(mod){
  try{return require(mod);}catch(e){
    try{return require(path.join(_nm,mod));}catch(e2){
      throw new Error('Cannot find: '+mod+' (tried NODE_PATH: '+_nm+')');
    }
  }
}`;


// Sweeper variant: NO iframe walk. Sweeper only handles login (top-frame form)
// and logout (top-frame masthead link), so iframe walking is dead work and the
// stripped version avoids any timing risk of polling iframes that don't exist.
const FIND_LOCATOR_MINIMAL_SRC = `async function findLocator(page, selector, opts){
  if(selector && selector.startsWith('xpath=')) return page.locator(selector);
  return page.locator(selector);
}`;




// v2.2.2 Session 2D: network-aware retry + error classification, factored out of
// buildRunner so the pool worker template can interpolate them too. probeNetwork +
// waitForNetwork were v1.2.5 item 2.8 (TCP probe + bounded wait with backoff so a
// disconnected PestPac doesn't burn the retry budget on dead-network failures).
// classifyError + classifyPhase were v1.2.5 item 2.10 (error categorization for
// the per-row Excel log's forensic columns).
//
// Requirements at the call site (template must satisfy before interpolating):
//   - PROBE_NETWORK_FN_SRC and WAIT_FOR_NETWORK_FN_SRC: the spawned-child must
//     declare `const net = require('net');` at top. waitForNetwork references
//     `currentMode` for the user-stop sentinel — must be declared (pool worker
//     has it from Session 2C; legacy single-runner already has it).
//   - CLASSIFY_ERROR_FN_SRC / CLASSIFY_PHASE_FN_SRC: no external dependencies.
const PROBE_NETWORK_FN_SRC = `function probeNetwork(){
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
}`;

const WAIT_FOR_NETWORK_FN_SRC = `async function waitForNetwork(){
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
}`;

const CLASSIFY_ERROR_FN_SRC = `function classifyError(errMsg){
  const m = String(errMsg || '');
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(m)) return 'internet-down';
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNREFUSED|ECONNRESET/i.test(m)) return 'pestpac-down';
  if (/ERR_|net::/i.test(m)) return 'unknown-network';
  if (/waitForSelector.*Timeout|waiting for selector/i.test(m)) return 'selector';
  if (/Timeout|timed out|TimeoutError/i.test(m)) return 'timeout';
  if (/Assert failed|HTTP 4\\\\d\\\\d|status code 4\\\\d\\\\d/i.test(m)) return 'validation';
  return 'unknown';
}`;

const CLASSIFY_PHASE_FN_SRC = `function classifyPhase(errMsg){
  const m = String(errMsg || '');
  if (/waitForSelector|waiting for selector|timeout.*selector/i.test(m)) return 'pre-action';
  if (/Assert failed/i.test(m)) return 'post-action';
  if (/Navigation failed|page\\\\.goto/i.test(m)) return 'action';
  return 'action';
}`;

// v2.2.1: log a coordinator-side license-reader session OUT before closing its browser.
// RULE: any session that logs in counts as a consumed license for as long as it stays logged
// in — there are NO exempt sessions. The elastic recheck (coordLicenseScale) and the Auto
// button (check-license-cap) previously did browser.close() WITHOUT logging out, leaving a
// live PestPac session each time (browser.close() ends local Chromium, NOT the server session).
// The License Manager exposes logout as a plain link href="/default.asp?Mode=Logout", so the
// most reliable logout is to navigate there directly (no fragile click), then verify we land
// back on the login page. Best-effort + verified; never throws (callers still close the browser).
// v3.x: delegates to the ONE canonical verified logout (engine/login.js). Kept as a named
// alias so the ctx.licenseReaderLogout wiring into the coordinator stays intact. Returns a
// boolean (was the seat confirmed freed?) for the existing callers.
async function licenseReaderLogout(page){
  try{ const r = await logoutFromPestPacInPage(page); return !!(r && r.ok); }catch(e){ return false; }
}

// v1.3.4 Phase 3: license-aware cap. Launches a headless browser with the given profile,
// (free - buffer) as a suggested cap. buffer defaults to 10 so some licenses stay open.
// Returns { ok, freeLicenses, suggested, error }. Read-only — navigates and scrapes only.
ipcMain.handle('check-license-cap', async (_, { profileId, buffer }) => {
  const BUF = (buffer != null) ? Math.max(0, parseInt(buffer)) : 10;
  const chromiumExe = getBundledChromiumPath();
  if (!chromiumExe) return { ok: false, error: 'Chromium not found.' };
  const all = readAllProfiles();
  const prof = all.find(p => p.id === profileId) || {};
  if (keytar) {
    prof.companyKey = await keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
    prof.username   = await keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
    prof.password   = await keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
  }
  let browser;
  try {
    const { chromium } = require('playwright-core');
    browser = await chromium.launch({ headless: true, executablePath: chromiumExe, args: ['--disable-gpu','--disable-dev-shm-usage'] });
    const page = await (await browser.newContext()).newPage();
    // v2.2.2: login via the shared canonical helper. Behavior identical to the inline
    // sequence this replaces, including the v2.1.1a MUI-backdrop wait and force-click
    // fallback for both the company-key and credential buttons, plus the v2.2.2 third
    // fallback to button[data-testid="LoginForm-loginBtn"] that the inline copy here
    // was missing (the sweeper/once-flow templates had it; this didn't).
    await loginToPestPacInPage(page, { loginUrl: prof.loginUrl, companyKey: prof.companyKey, username: prof.username, password: prof.password });
    // Navigate to the license page and read the free-licenses cell.
    await page.goto('https://app.pestpac.com/license.asp?Mode=View', { waitUntil: 'load', timeout: 30000 });
    // v2.2.1: read the PestPac FREE-licenses value robustly. The page has MULTIPLE license
    // tables (PestPac, Mobile App, RouteOp), each with its own "Number of free ... licenses:"
    // row, AND a "Number of licenses:" (total) and "Number of used licenses:" row. The old
    // startsWith('number of free licenses') match was returning the wrong cell (used/total).
    // Fix: scan ONLY the PestPac panel (#div_PestPac), require the label to match EXACTLY
    // "number of free licenses:" (so it can't hit "used", the bare total, or Mobile/RouteOp),
    // and read that row's value cell.
    const freeText = await page.evaluate(() => {
      const scope = document.querySelector('#div_PestPac') || document;
      const tds = Array.from(scope.querySelectorAll('td'));
      for (const td of tds) {
        const label = (td.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (label === 'number of free licenses:' || label === 'number of free licenses') {
          const sib = td.nextElementSibling;
          if (sib) return (sib.textContent || '').trim();
        }
      }
      return null;
    });
    await licenseReaderLogout(page); // v2.2.1: a read session is still a consumed license — log out before closing.
    await browser.close();
    if (freeText == null) return { ok: false, error: 'Could not find "Number of free licenses" on the license page.' };
    const free = parseInt(String(freeText).replace(/[^0-9]/g, ''));
    if (isNaN(free)) return { ok: false, error: 'Free-licenses value was not a number: "' + freeText + '"' };
    const suggested = Math.max(1, free - BUF);
    return { ok: true, freeLicenses: free, buffer: BUF, suggested };
  } catch (e) {
    try { if (browser) await browser.close(); } catch(_){}
    return { ok: false, error: e.message };
  }
});

// ════════════════════════════════════════════════════════════════════════════
// v2.0.0 — POOL IPC HANDLERS (renderer drives the coordinator)
// ════════════════════════════════════════════════════════════════════════════

// Submit a job into the (not-yet-started) pool. Returns the jobId. Jobs are staged, then
// 'pool-start' spawns workers to drain them. flowSteps is the full allSteps array.
ipcMain.handle('pool-submit-job', async (_, { label, flowName, flowSteps, spreadsheetPath, profileId, setupFlowId, teardownFlowId, errHandle, resumeFromRow, retryCount, retryRowIndexes, reauthIntervalMin }) => {
  if (COORD.active) return { ok: false, error: 'Pool is already running. Stop it before staging new jobs.' };
  // R15: spreadsheet-free once-flow — one synthetic pass; the pool runtime is reused
  // unchanged with totalRows 1 (its single journal row is the summary log).
  const sheetFree = !spreadsheetPath;
  const total = sheetFree ? 1 : countRowsSync(spreadsheetPath);
  if (total <= 0) return { ok: false, error: 'Could not read rows from ' + spreadsheetPath };
  const jobId = 'job' + Date.now() + '-' + Math.floor(Math.random()*1000);
  // v2.1.0 (#5) step-by-step -> pool handoff: if the user was stepping through this sheet in
  // the single-runner (manual) mode and switches to the pool, resumeFromRow carries the row
  // cursor over so the pool starts where the manual stepping left off instead of restarting
  // at row 1. Clamp to [1, total+1]; total+1 means "already past the end" (nothing to do).
  let startRow = parseInt(resumeFromRow);
  if (!Number.isFinite(startRow) || startRow < 1) startRow = 1;
  if (startRow > total + 1) startRow = total + 1;
  // v2.2.2 Session 2E: per-job runtime knobs, previously single-runner-only.
  // retryCount: bounded retries per row when errHandle='retry'. Default 2 matches the
  //   previous coordSpawnWorker hardcode.
  //   (Coordinator marks the job finished + drains the worker when it trips.)
  // retryRowIndexes: optional array of 1-based source row numbers — if set, the worker
  //   processes ONLY those rows (skips all others). Used for retry-failed mode.
  // reauthIntervalMin: optional re-auth interval in minutes; 0 = disabled.
  const _rc = parseInt(retryCount);
  const _ri = parseInt(reauthIntervalMin);
  const _retrySet = Array.isArray(retryRowIndexes)
    ? retryRowIndexes.map(n => parseInt(n)).filter(n => Number.isFinite(n) && n >= 1)
    : null;
  COORD.jobs.set(jobId, {
    jobId, label: label || path.basename(spreadsheetPath),
    // v3.0.3: the flow's display name (= filename stem) so run-end can write
    // lastGoodWorkers into the flow's own .json. Empty when the flow was never saved.
    flowName: flowName || '',
    flowSteps, spreadsheetPath, profileId,
    setupFlowId: setupFlowId || null, teardownFlowId: teardownFlowId || null,
    errHandle: errHandle || 'retry',
    totalRows: total, nextRow: startRow, startRow,
    // v2.2.2 Session 2E knobs (passed through to worker via coordSpawnWorker)
    retryCount: Number.isFinite(_rc) ? Math.max(0, _rc) : 2,
    retryRowIndexes: _retrySet,
    reauthIntervalMin: Number.isFinite(_ri) ? Math.max(0, _ri) : 0,
    done: 0, ok: 0, err: 0, finished: false,
    // v2.2.3 Session 3B (A5): track distinct rows that have completed via a Set so the
    // headline counter is reclaim-aware (j.done includes reclaim re-completions and would
    // exceed totalRows; distinctDone == completedRows.size is the trustworthy number).
    // Resume re-seeds this from the journal in coordResumeFromJournal.
    completedRows: new Set(),
    // Reclaim tally for the breakdown line — incremented in the 'reclaim' case + the crash
    // sum for the headline. Both reset on a fresh submit (resume doesn't persist these in
    // the journal meta today; tally restarts at zero on resume — documented in v2.2.3 doc).
  });
  coordEmitStatus();
  return { ok: true, jobId, totalRows: total, startRow };
});

// Remove a staged job (only when pool not running).
ipcMain.handle('pool-remove-job', async (_, { jobId }) => {
  if (COORD.active) return { ok: false, error: 'Cannot remove jobs while the pool is running.' };
  COORD.jobs.delete(jobId);
  coordEmitStatus();
  return { ok: true };
});

// Clear all staged jobs (only when pool not running).
ipcMain.handle('pool-clear-jobs', async () => {
  if (COORD.active) return { ok: false, error: 'Cannot clear jobs while the pool is running.' };
  COORD.jobs.clear();
  coordEmitStatus();
  return { ok: true };
});

// Start the pool: spawn up to `workerCount` workers to drain the staged jobs. Optionally
// enable the elastic license loop (recheck every intervalMin minutes, scale to free-buffer).
ipcMain.handle('pool-start', async (_, { workerCount, startWorkers, maxWorkers, hwSlider, ppSlider, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin, setupScope, startMode, diagnosticCapture, captureBucketCap, scaleMultiplier }) => {
  if (COORD.active) return { ok: false, error: 'Pool already running.' };
  // 3.0.4 (2a+2c): purge finished jobs from the previous run and re-validate that every
  // remaining job's spreadsheet still exists — BEFORE any state resets touch the jobs.
  { const _prep = coordPrepareLaunch(); if (!_prep.ok) return _prep; }
  // v2.1.1 (#8): setup/teardown scope. 'per-worker' (default) keeps the proven behavior where
  // each worker runs the once-flows for its own session. 'per-job' / 'global' run them ONCE,
  // executed by the coordinator via a dedicated headless session, with workers skipping them.
  COORD.setupScope = (setupScope === 'per-worker' || setupScope === 'global') ? setupScope : 'per-job'; // 3.x: default per-job (run setup/teardown once), per-worker only if explicitly chosen
  // v2.2.2 Session 2C: startMode replaces the single-runner's start-mode dropdown. Step modes
  // FORCE workers=1 and batchSize=1 regardless of configured target — the configured target
  // is remembered in startModeTarget and restored when the user clicks Run-All mid-step
  // (handled by pool-run-control). This honors Matthew's Q1: step-by-step uses one worker;
  // after testing, automation respects the worker pool settings.
  COORD.startMode = (startMode === 'step' || startMode === 'step-row') ? startMode : 'run-all';
  const _cfgWorkers = parseInt(workerCount) || 1;
  COORD.startModeTarget = { workers: _cfgWorkers };
  COORD.possibleLeaks = [];
  COORD.stopping = false;
  COORD._stopSweepFired = false;
  // Reset per-run job counters in case jobs were staged then this is a restart.
  // v2.1.0 (#5): reset nextRow to the job's startRow (the step-by-step handoff cursor), not a
  // hard 1 — otherwise switching from manual stepping to the pool would re-run completed rows.
  // startRow defaults to 1 for normal jobs, so existing behavior is unchanged.
  // v2.1.1 FIX: a fresh pool-start must CLEAR completedRows. Previously it preserved any existing
  // set (if(!completedRows)...), so a second run in the same app session — especially after a run
  // where every row skipped — saw all rows as "already done", handed out empty batches, and every
  // worker retired instantly ("workers appear then vanish, run stops"). Resume has its own path
  // (coordResumeFromJournal) that seeds completedRows deliberately; pool-start is always a fresh run.
  // v2.2.3 Session 3C: also reset Session 3B's reclaim tally on a fresh pool-start so a
  // second run in the same app session doesn't inherit stale reclaim counts from the prior run.
  for (const job of COORD.jobs.values()) { job.nextRow = job.startRow || 1; job.done = 0; job.ok = 0; job.err = 0; job.finished = false; job.completedRows = new Set(); }
  // v2.2.3 Session 3C (A1): diagnostic capture toggle + bucket cap. Default ON since
  // v2.2.3 exists specifically to make false-ok reporting visible; user can flip off for
  // a 'fast' run knowingly. Bucket cap (default 10) limits per-(status,errorCategory)
  // capture folders so a 10k-row run can't fill the disk.
  COORD.diagnosticCapture = (diagnosticCapture === false) ? false : true;
  COORD.captureBucketCap = Math.max(1, Math.min(1000, parseInt(captureBucketCap) || 10));
  COORD.active = true;
  coordOpenJournal();  // v2.0.0 resume: start the append-only journal for this run

  // v2.1.1 (#8): for 'per-job' / 'global' scope, run setup ONCE (coordinator-driven) before any
  // workers spawn. Awaited so workers never start processing rows before setup has completed.
  if(COORD.setupScope !== 'per-worker'){
    if(mainWindow) _send('pool-once-flow', { phase:'setup', state:'phase-start', scope:COORD.setupScope });
    try { await coordRunOnceFlows('setup'); coordMarkPhaseProgress('setupCompleted'); } catch(e) { console.error('[coord] setup once-flows error:', e.message); }
  }

  const hwCap = computeHardwareCap(COORD.scaleMultiplier);
  // v2.2.2 Session 2C: in step/step-row mode, force a single worker regardless of configured
  // count. The configured count is stored in COORD.startModeTarget and applied when the user
  // clicks Run-All mid-step (via pool-run-control).
  const _modeWorkerCount = (COORD.startMode === 'step' || COORD.startMode === 'step-row') ? 1 : (parseInt(workerCount) || 1);
  // R4: scaling state. The manual slider is authoritative (manual wins over auto) and
  // may deliberately exceed the comfortable hardware cap — so hwCap is out of this clamp.
  // v3.0.3: Start SEEDS, Max CLAMPS, heuristics decide in between.
  COORD.startWorkers = Math.max(1, Math.min(parseInt(startWorkers ?? workerCount) || 1, MAX_WORKERS_HARD_CEILING));
  COORD.maxWorkers   = Math.max(1, Math.min(parseInt(maxWorkers) || MAX_WORKERS_HARD_CEILING, MAX_WORKERS_HARD_CEILING));
  COORD.hwSlider     = Math.max(1, Math.min(5, parseInt(hwSlider) || 4));   // 4 = 100%
  COORD.ppSlider     = Math.max(1, Math.min(5, parseInt(ppSlider) || 4));   // 4 = 100%
  COORD.scaleMultiplier = 3; // the comfortable-cap BASE; hwSlider scales it, so this is fixed
  // v3.0.3: was hardcoded `= true`, so the Auto-scale checkbox never disabled anything and
  // the pressure block ran on every pool regardless of the box.
  COORD.autoScale = (elastic !== false);
  COORD.licenseCap = Infinity;
  COORD._rowTimes = []; COORD._tp = null; COORD._tpBest = null;
  COORD._tpW = null; COORD._tpStableSince = null; COORD._climbLastW = null; COORD._climbDir = undefined;
  COORD.throughput = null; COORD.capReason = 'settling';
  COORD.hwCapAdvisory = computeHardwareCap(COORD.scaleMultiplier);
  let target = Math.max(1, Math.min(_modeWorkerCount, COORD.maxWorkers, MAX_WORKERS_HARD_CEILING));
  COORD.desiredWorkers = target;

  // Spawn initial workers (bounded by total rows available — no point spawning idle workers).
  // v2.1.0 (#5): "available" accounts for the startRow handoff cursor and any pre-completed rows.
  let totalRemaining = 0; for (const j of COORD.jobs.values()) totalRemaining += Math.max(0, (j.totalRows - (j.nextRow - 1)) - (j.completedRows ? j.completedRows.size : 0));
  target = Math.min(target, Math.max(1, totalRemaining));
  for (let i = 0; i < target; i++) { await coordSpawnWorker(); }

  // Elastic license loop.
  // Phase 3 (D4): NOT started while stepping — the timer used to scale up workers (each
  // burning a login/license) while the user was still verifying row 1. It starts at
  // Release (pool-run-control 'run-all') from the params stashed on COORD here.
  // v3.0.3: license counting runs whenever we have a profile to read it with. It is NOT
  // gated on the Auto-scale checkbox — unticking a box must never silently stop us
  // counting PestPac seats or honouring the buffer.
  COORD.elasticParams = (licenseProfileId)
    ? { licenseProfileId, licenseBuffer, hwCap, intervalMs: Math.max(1, parseInt(licenseIntervalMin) || 5) * 60 * 1000 }
    : null;
  // R4: ONE evaluation timer — coordEvalScale composes license cap (when elastic),
  // PestPac pressure, and the manual slider. Runs for every non-step pool so pressure
  // sensing works without elastic. Still gated off in step modes (D4); Release starts it.
  if (COORD.startMode !== 'step' && COORD.startMode !== 'step-row') {
    COORD.licenseTimer = setInterval(() => coordEvalScale(), Math.max(1, parseInt(licenseIntervalMin) || 2) * 60 * 1000);
  }
  coordEmitStatus();
  return { ok: true, started: COORD.workers.size, desiredWorkers: COORD.desiredWorkers };
});

// Stop the pool: tell every worker to drain (clean — finishes current batch, runs teardown,
// logs out, exits). Force-kills any that don't exit within 2 minutes.
ipcMain.handle('pool-stop', async () => {
  if (!COORD.active) return { ok: true, stopped: 0 };
  if (COORD.licenseTimer) { clearInterval(COORD.licenseTimer); COORD.licenseTimer = null; }
  COORD.stopping = true; // Phase 3 (D2): gates stall-guard respawn; arms the prompt logout sweep
  // Drain all jobs so any subsequent request-batch gets 'drain'.
  for (const job of COORD.jobs.values()) { job.nextRow = job.totalRows + 1; job.finished = true; }
  // Proactively send drain to idle/running workers.
  for (const w of COORD.workers.values()) {
    // Phase 3 (D2): 'stop' abandons the current row at the next step boundary;
    // 'drain' resolves any pending row request so idle workers exit immediately.
    try { w.process.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n'); } catch {}
    try { w.process.stdin.write(JSON.stringify({ cmd: 'drain' }) + '\n'); } catch {}
    w.status = 'draining';
  }
  // Phase 3 (D2): force-kill fuse is 10s (was 180s). Stop now abandons the current row
  // at the next STEP boundary and logout is a 5s one-URL navigation, so a healthy worker
  // exits in a few seconds. Anything still alive at 10s is wedged mid-action; kill it and
  // let the logout sweep (fired promptly on last-worker-exit, backstopped below) free the
  // session. A killed process cannot log itself out — the sweep is the guarantee layer.
  const _ids = Array.from(COORD.workers.keys());
  setTimeout(() => {
    for (const id of _ids) {
      const w = COORD.workers.get(id);
      if (w && w.process) { try { w.process.kill(); } catch {} }
    }
    // Backstop sweep for the killed-mid-action case (sweepRunning + _stopSweepFired
    // make this a no-op when the prompt last-worker-exit sweep already ran).
    setTimeout(() => coordRunLogoutSweep('pool-stop'), 2000);
  }, 10000);
  coordEmitStatus();
  return { ok: true, stopped: COORD.workers.size };
});

// v2.2.2 Session 2C: pool step-by-step control channel. Routes renderer commands
// (next-step / next-row / run-all / stop) to the active pool worker's stdin. In step
// or step-row mode the pool is forced to 1 worker so there's exactly one target. On
// 'run-all', this transitions the pool out of step mode and scales up to the
// configured worker target stored in COORD.startModeTarget at pool-start.
ipcMain.handle('pool-run-control', async (_, _rcPayload) => {
  const { cmd } = _rcPayload || {};
  if (!COORD.active) return { ok: false, error: 'Pool not running.' };
  if (!['next-step','next-row','run-all','stop','mode','redo-step','last-step','skip-step','restart-row','flow-update'].includes(cmd) && !(cmd && cmd.startsWith('mode:'))) {
    return { ok: false, error: 'Unknown command: ' + cmd };
  }
  // 'stop' here means user clicked Stop during a step pause. Treat it like pool-stop —
  // tell each worker to drain (workers honor it at the next decision point) AND release
  // any pending pause so the worker can reach the drain check.
  if (cmd === 'stop') {
    if (COORD.licenseTimer) { clearInterval(COORD.licenseTimer); COORD.licenseTimer = null; }
    for (const job of COORD.jobs.values()) { job.nextRow = job.totalRows + 1; job.finished = true; }
    for (const w of COORD.workers.values()) {
      try { w.process.stdin.write(JSON.stringify({ cmd:'stop' }) + '\n'); } catch {}
      try { w.process.stdin.write(JSON.stringify({ cmd:'drain' }) + '\n'); } catch {}
      w.status = 'draining';
    }
    coordEmitStatus();
    return { ok: true };
  }
  // 'run-all' transitions out of step mode. Switch coord state, restore configured batch
  // size, tell the live worker(s) to switch to run-all, then scale to configured target.
  if (cmd === 'run-all') {
    COORD.startMode = 'run-all';
    for (const w of COORD.workers.values()) {
      try { w.process.stdin.write(JSON.stringify({ cmd:'run-all' }) + '\n'); } catch {}
    }
    // R4 (D4 gate): start the ONE evaluation timer now that the user has Released.
    if (!COORD.licenseTimer) {
      const _iv = (COORD.elasticParams && COORD.elasticParams.intervalMs) || 2 * 60 * 1000;
      COORD.licenseTimer = setInterval(() => coordEvalScale(), _iv);
    }
    const tgt = (COORD.startModeTarget && COORD.startModeTarget.workers) || 1;
    COORD.startWorkers = Math.max(1, Math.min(tgt, MAX_WORKERS_HARD_CEILING));
    COORD.desiredWorkers = Math.min(COORD.startWorkers, COORD.maxWorkers || MAX_WORKERS_HARD_CEILING);
    await coordScaleTo(COORD.desiredWorkers);
    coordEmitStatus();
    return { ok: true, desiredWorkers: COORD.desiredWorkers };
  }
  // 'next-step' / 'next-row' release the current pause without changing mode. Forward to
  // the live worker. In step modes there's exactly one worker, but if multiple are alive
  // (e.g. mid Run-All transition) we forward to all — only the one actually paused will
  // act on it.
  for (const w of COORD.workers.values()) {
    // R5b: flow-update carries the new steps (+ optional cursor) through to the worker.
    const _msg = cmd === 'flow-update' ? { cmd, steps: _rcPayload.steps, cursor: _rcPayload.cursor } : { cmd };
    try { w.process.stdin.write(JSON.stringify(_msg) + '\n'); } catch {}
  }
  return { ok: true };
});

// v2.1.1: manual logout sweep — lets the user force a License-Manager cleanup at any time
// (e.g. they see stuck BUU sessions). Safe to call even when no pool is running.
ipcMain.handle('pool-logout-sweep', async () => {
  coordRunLogoutSweep('manual');
  return { ok: true, started: true };
});

// Set the worker target while running: spawn more, or mark surplus for retirement.
// R4: live scaling-settings updates from the sidebar sliders. Applies mid-run; changes
// take effect immediately via an evaluation when the pool is active (non-step).
ipcMain.handle('pool-set-scaling', async (_, d) => {
  d = d || {};
  // v3.0.3: every knob is live. Max especially â€” Matthew's override is lowering it BELOW
  // the live count mid-run, which must drain workers, not wait for the next launch.
  if (d.maxWorkers != null)   COORD.maxWorkers   = Math.max(1, Math.min(MAX_WORKERS_HARD_CEILING, parseInt(d.maxWorkers) || 1));
  if (d.startWorkers != null) COORD.startWorkers = Math.max(1, Math.min(MAX_WORKERS_HARD_CEILING, parseInt(d.startWorkers) || 1));
  if (d.hwSlider != null)     COORD.hwSlider     = Math.max(1, Math.min(5, parseInt(d.hwSlider) || 4));
  if (d.ppSlider != null)     COORD.ppSlider     = Math.max(1, Math.min(5, parseInt(d.ppSlider) || 4));
  if (d.autoScale != null)    COORD.autoScale    = !!d.autoScale;
  // hwCapAdvisory must be RECOMPUTED here: it was only ever refreshed on a slider move, so
  // the renderer's amber cache went stale during a run and lied (slider 4 showed amber
  // while the real cap was 21).
  COORD.hwCapAdvisory = computeHardwareCap(COORD.scaleMultiplier || 3);
  if (d.intervalMin != null && COORD.licenseTimer) {
    clearInterval(COORD.licenseTimer);
    COORD.licenseTimer = setInterval(() => coordEvalScale(), Math.max(1, parseInt(d.intervalMin) || 2) * 60 * 1000);
  }
  if (COORD.active && COORD.startMode !== 'step' && COORD.startMode !== 'step-row') { try { await coordEvalScale(); } catch (e) {} }
  return { ok: true, hwCap: COORD.hwCapAdvisory || computeHardwareCap(3), hwEffective: Math.max(1, Math.round((COORD.hwCapAdvisory || computeHardwareCap(3)) * ((COORD.hwSlider || 4) / 4))) };
});

ipcMain.handle('pool-set-workers', async (_, { workerCount }) => {
  if (!COORD.active) return { ok: false, error: 'Pool not running.' };
  const hwCap = computeHardwareCap(COORD.scaleMultiplier);
  const target = Math.max(0, Math.min(parseInt(workerCount) || 0, MAX_WORKERS_HARD_CEILING)); // R4: slider may exceed the (advisory) hardware cap
  COORD.startWorkers = Math.max(1, target || 1); // v3.0.3: legacy path â€” seeds Start, Max still clamps
  COORD.desiredWorkers = Math.min(target, COORD.maxWorkers || MAX_WORKERS_HARD_CEILING);
  await coordScaleTo(target);
  return { ok: true, desiredWorkers: target, liveWorkers: COORD.workers.size };
});

// v2.1.1 (#6): gracefully stop ONE worker. The worker finishes its current row, runs teardown,
// VERIFIES logout, then exits — it is never force-killed here (that risks a stuck session, the
// exact thing the logout work prevents). Rows in its batch that it never reported are reclaimed
// into the job's requeue so another worker picks them up — nothing is lost. We also lower the
// desired-worker target by one so the elastic loop doesn't immediately respawn a replacement.
ipcMain.handle('pool-stop-worker', async (_, { workerId }) => {
  const w = COORD.workers.get(workerId);
  if (!w) return { ok: false, error: 'Worker not found (it may have already finished).' };
  if (w.stopping) return { ok: true, alreadyStopping: true };
  w.stopping = true;
  // Reclaim un-reported rows from this worker's current batch into the job's requeue.
  const job = COORD.jobs.get(w.jobId);
  if (job && Array.isArray(w.batch) && w.batch.length) {
    if (!job.requeue) job.requeue = [];
    for (const r of w.batch) {
      if (!(job.completedRows && job.completedRows.has(r))) job.requeue.push(r);
    }
    job.finished = false; // there is work to redo, so the job isn't finished
  }
  // Lower the target so a replacement isn't auto-spawned for this intentional stop.
  COORD.desiredWorkers = Math.max(0, COORD.desiredWorkers - 1);
  // Tell the worker to drain (finish current row -> teardown -> verified logout -> exit).
  try { w.process.stdin.write(JSON.stringify({ cmd: 'drain' }) + '\n'); } catch {}
  w.status = 'draining';
  coordEmitStatus();
  return { ok: true, workerId, requeued: (job && job.requeue ? job.requeue.length : 0) };
});

ipcMain.handle('pool-get-status', async () => {
  coordEmitStatus();
  // 3.0.4 (2a): pendingJobs counts only jobs a launch would actually RUN (finished jobs
  // are purged at pool-start). The renderer's stage-if-none check must use this — using
  // the raw jobs count made a leftover finished job suppress staging of the new flow
  // (07-16: the crash-loop pool launched with ONLY a stale job whose sheet was gone).
  const pendingJobs = Array.from(COORD.jobs.values()).filter(j => !j.finished).length;
  return { active: COORD.active, liveWorkers: COORD.workers.size, desiredWorkers: COORD.desiredWorkers, jobs: COORD.jobs.size, pendingJobs };
});

// v2.0.0 resume: list orphan pool runs (journal exists with remaining work).
ipcMain.handle('pool-find-orphans', async () => {
  return coordFindOrphanPools();
});

// v2.0.0 resume: rebuild the pool from an orphan journal and restart it. Reconstructs each
// job from the meta sidecar, loads the completed-row sets from the journal, then APPENDS to
// the SAME journal (so the resumed run keeps one continuous record).
ipcMain.handle('pool-resume', async (_, { poolId, workerCount, startWorkers, maxWorkers, hwSlider, ppSlider, elastic, licenseProfileId, licenseBuffer, licenseIntervalMin }) => {
  if (COORD.active) return { ok: false, error: 'Pool already running.' };
  const metaPath = coordJournalMetaPath(poolId);
  const jp = coordJournalPath(poolId);
  if (!fs.existsSync(metaPath)) return { ok: false, error: 'Resume metadata not found for ' + poolId };
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch(e){ return { ok:false, error:'Could not read resume metadata: '+e.message }; }

  // R1: completed rows come from the ONE journal reader (ok-wins; requeued lines are
  // in-flight, not completions — those rows re-run on resume, which is the safe default).
  const completedByJob = require('./journal').readJournalRowStates(poolId).completedByJob;

  // Rebuild COORD.jobs from meta, pre-seeding completedRows.
  // v2.2.2 Session 2F: also restores per-job retry knobs (Session 2E) so resume preserves the
  // SAME runtime config the original run used. Missing fields default to safe values (older
  // journals predating 2E/2F resume with retry=2/etc).
  COORD.jobs.clear();
  for (const j of meta.jobs){
    COORD.jobs.set(j.jobId, {
      jobId: j.jobId, label: j.label, flowSteps: j.flowSteps,
      spreadsheetPath: j.spreadsheetPath, profileId: j.profileId,
      setupFlowId: j.setupFlowId, teardownFlowId: j.teardownFlowId,
      errHandle: j.errHandle, totalRows: j.totalRows,
      // v2.2.2 Session 2F: restore Session 2E knobs from meta (defaults if missing).
      retryCount: Number.isFinite(j.retryCount) ? j.retryCount : 2,
      retryRowIndexes: Array.isArray(j.retryRowIndexes) ? j.retryRowIndexes : null,
      reauthIntervalMin: Number.isFinite(j.reauthIntervalMin) ? j.reauthIntervalMin : 0,
      startRow: Number.isFinite(j.startRow) ? j.startRow : 1,
      nextRow: Number.isFinite(j.startRow) ? j.startRow : 1, done: 0, ok: 0, err: 0, finished: false,
      completedRows: completedByJob[j.jobId] || new Set(),
      // v2.2.3 Session 3B (A5): reclaim tally is in-memory only — resumed runs start at zero.
    });
  }
  // Seed counters from the completed sets so the UI shows real progress immediately.
  for (const job of COORD.jobs.values()){ job.done = job.completedRows.size; }

  // v2.2.2 Session 2F: restore pool-level configuration from meta (defaults preserve old behavior).
  COORD.setupScope = meta.setupScope || 'per-job'; // 3.x default per-job
  COORD.startMode = meta.startMode || 'run-all';
  COORD.startModeTarget = meta.startModeTarget || { workers: 1 };
  // v2.2.3 Session 3C (A1): restore diagnostic-capture config from meta. Default ON if missing
  // (older journals predating 3C resume with capture enabled, which is the desired behavior for
  // any resume — you want to keep diagnosing).
  COORD.diagnosticCapture = (meta.diagnosticCapture === false) ? false : true;
  COORD.captureBucketCap = Number.isFinite(meta.captureBucketCap) ? meta.captureBucketCap : 10;
  COORD.active = true;
  // Re-open the SAME journal in append mode (continue the continuous record).
  COORD.poolId = poolId;
  try { COORD.journalStream = fs.createWriteStream(jp, { flags: 'a' }); } catch(e){ COORD.journalStream = null; }

  // v2.2.2 Session 2F: respect phaseProgress from the meta. If coordinator-driven setup already
  // ran in the original session, skip it on resume. Teardown still runs at the end. Per-worker
  // scope is unaffected (each new worker runs its own setup/teardown by design).
  const _resumePhase = (meta.phaseProgress || {});
  if(COORD.setupScope !== 'per-worker' && !_resumePhase.setupCompleted){
    if(mainWindow) _send('pool-once-flow', { phase:'setup', state:'phase-start', scope:COORD.setupScope });
    try { await coordRunOnceFlows('setup'); coordMarkPhaseProgress('setupCompleted'); } catch(e) { console.error('[coord] resume setup once-flows error:', e.message); }
  } else if(COORD.setupScope !== 'per-worker' && _resumePhase.setupCompleted){
    console.log('[coord] resume: skipping setup (already completed in original session)');
  }

  const hwCap = computeHardwareCap(COORD.scaleMultiplier);
  let totalRemaining = 0; for (const j of COORD.jobs.values()) totalRemaining += Math.max(0, j.totalRows - j.completedRows.size);
  let target = Math.max(1, Math.min(parseInt(workerCount) || 1, MAX_WORKERS_HARD_CEILING, Math.max(1, totalRemaining)));
  COORD.startWorkers = Math.max(1, Math.min(parseInt(startWorkers ?? workerCount) || 1, MAX_WORKERS_HARD_CEILING));
  COORD.maxWorkers   = Math.max(1, Math.min(parseInt(maxWorkers) || MAX_WORKERS_HARD_CEILING, MAX_WORKERS_HARD_CEILING));
  COORD.hwSlider     = Math.max(1, Math.min(5, parseInt(hwSlider) || 4));
  COORD.ppSlider     = Math.max(1, Math.min(5, parseInt(ppSlider) || 4));
  COORD.autoScale    = (elastic !== false);
  COORD.scaleMultiplier = 3;
  COORD._rowTimes = []; COORD._tp = null; COORD._tpBest = null;
  COORD._tpW = null; COORD._tpStableSince = null; COORD._climbLastW = null; COORD._climbDir = undefined;
  COORD.throughput = null; COORD.licenseCap = Infinity;
  COORD.desiredWorkers = target;
  for (let i = 0; i < target; i++) { await coordSpawnWorker(); }

  // R14: the resume eval timer is ALWAYS-ON (pressure sensing works without elastic),
  // matching pool-start; elastic only gates the license part via elasticParams — which
  // resume now sets, so a resumed elastic pool license-caps again.
  // v3.0.3: license counting runs whenever we have a profile to read it with. It is NOT
  // gated on the Auto-scale checkbox — unticking a box must never silently stop us
  // counting PestPac seats or honouring the buffer.
  COORD.elasticParams = (licenseProfileId)
    ? { licenseProfileId, licenseBuffer, hwCap, intervalMs: Math.max(1, parseInt(licenseIntervalMin) || 2) * 60 * 1000 }
    : null;
  COORD.licenseTimer = setInterval(() => coordEvalScale(), Math.max(1, parseInt(licenseIntervalMin) || 2) * 60 * 1000);
  coordEmitStatus();
  return { ok: true, resumed: true, totalRemaining, started: COORD.workers.size };
});

// v2.0.0 resume: discard an orphan pool (delete its journal + meta).
ipcMain.handle('pool-discard-orphan', async (_, { poolId }) => {
  try { fs.unlinkSync(coordJournalPath(poolId)); } catch {}
  try { fs.unlinkSync(coordJournalMetaPath(poolId)); } catch {}
  return { ok: true };
});



function resolveOnceFlowByName(name) {
  if (!name) return null;
  const base = getFlowsDir();
  // 3.x: search SUBFOLDERS first, flat root last (matches read-flow-by-name). This resolves a
  // setup/teardown reference to the user's edited subfolder copy, and — critically — keeps
  // working after the startup dedup removes the flat root duplicates.
  for (const sub of ['automation', 'once', 'general', '']) {
    const dir = path.join(base, sub);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!/\.json$/i.test(f)) continue;
      // v1.2.8.1 hotfix: match by filename stem only.
      if (f.replace(/\.json$/i, '') !== name) continue;
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* skip malformed */ }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// v2.0.0 — POOL WORKER TEMPLATE (batch-pulling, persistent)
// Differs from buildRunner: the worker does NOT own the row loop. It logs in once, then
// repeatedly: emit {type:'request-batch'} → wait for stdin {cmd:'batch',rows:[...]} or
// {cmd:'drain'} → process those specific row indexes → repeat. On 'drain' it runs teardown
// + logout and exits. The coordinator (main) owns the queue and hands out batches.
// Reuses the same per-step engine semantics as buildRunner (token resolve, iframe-aware
// locators, find-by-text, retry). Each processed row is reported via {type:'row-result'}.
// ════════════════════════════════════════════════════════════════════════════

const __POOL_INLINE_SRC = { REQUIRE_FN_SRC, LOGIN_TO_PESTPAC_SRC, LOCATE_STACK_SRC, STEPS_SRC, PROBE_NETWORK_FN_SRC, WAIT_FOR_NETWORK_FN_SRC, CLASSIFY_ERROR_FN_SRC, CLASSIFY_PHASE_FN_SRC };
function buildPoolWorker(cfg){
  const {
    flowSteps, setupSteps = [], teardownSteps = [], spreadsheetPath, logPath,
    chromiumExePath, errHandle = 'retry', selectorTimeout = 30,
    pageLoadMode = 'domcontentloaded', retryCount = 2, runContext = {},
    // v2.2.2 Session 2E: per-job runtime knobs.
    reauthIntervalMin = 0,
    // v2.2.3 Session 3C (A1): diagnostic capture. captureDir is the directory where per-row
    // failure folders go (one per captured row). bucketCap=10 means at most 10 captures per
    // (status, errorCategory) bucket — prevents 10k-row runs from filling the disk.
    diagnosticCapture = true, captureDir = null, captureBucketCap = 10,
  } = cfg;
    const __inj = [
    (JSON.stringify(logPath)),
    (JSON.stringify(errHandle)),
    (parseInt(selectorTimeout) * 1000),
    (JSON.stringify(pageLoadMode)),
    (parseInt(retryCount)),
    ((parseInt(reauthIntervalMin) || 0) * 60 * 1000),
    (JSON.stringify(chromiumExePath)),
    (JSON.stringify(flowSteps)),
    (JSON.stringify(setupSteps)),
    (JSON.stringify(teardownSteps)),
    (JSON.stringify(runContext)),
    (JSON.stringify(cfg.startMode || 'run-all')),
    (diagnosticCapture ? 'true' : 'false'),
    (captureDir ? JSON.stringify(captureDir) : 'null'),
    (parseInt(captureBucketCap) || 10),
    (JSON.stringify(runContext.runId||'')),
  ];
  let __src = fs.readFileSync(path.join(__dirname, 'pool', 'worker.js'), 'utf8');
  __src = __src.replace(/\/\*__BUU_INLINE ([A-Z_]+)__\*\//g, function(_, n){
    if (!(n in __POOL_INLINE_SRC)) throw new Error("unknown inline: " + n);
    return __POOL_INLINE_SRC[n];
  });
  __src = __src.replace(/\/\*__BUU_CFG_(\d+)__\*\/null/g, function(_, n){
    if (+n >= __inj.length) throw new Error("cfg marker out of range: " + n);
    return String(__inj[+n]);
  });
  return __src;
}

// ── LOGOUT SWEEPER (v2.1.1) ───────────────────────────────────────────────────
// The second, authoritative logout layer. After the pool finishes (or is stopped), the
// coordinator spawns this headless sweeper. It logs in, opens PestPac's License Manager
// (license.asp?Mode=View) which lists EVERY logged-in session, finds every row whose user is
// EXACTLY "BUU" (never a substring — real employees must never be logged out), ticks their
// LogOutUser{N} checkbox, clicks #butLogOut, and verifies the BUU count dropped to zero.
// This reclaims licenses even from workers that hard-crashed and never logged themselves out,
// which is what makes "there cannot be failure to log out" actually deliverable.
function buildLogoutSweeper({ chromiumExePath, loginSteps, runContext }) {
  return `
const { chromium } = require('playwright-core');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const CHROMIUM_EXE = ${JSON.stringify(chromiumExePath)};
const LOGIN_STEPS = ${JSON.stringify(loginSteps)};
const RUN_CONTEXT = ${JSON.stringify(runContext || {})};
const CRED_PATH = process.argv[2];
const BUU_USER = 'BUU'; // exact-match key for our sessions
const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\\n');}
function ms(s){return Math.round(parseFloat(s||1)*1000);}

// v2.2.2 (Session 2A): sweeper uses the stripped (no-iframe) minimal variant.
${FIND_LOCATOR_MINIMAL_SRC}
// Minimal step engine — only the step types login uses (navigate/type/click/select/wait).
async function runStep(page, step, creds){
  const r=v=>{ if(!v)return''; return v.replace(/{{CRED:companyKey}}/g,creds.companyKey||'').replace(/{{CRED:username}}/g,creds.username||'').replace(/{{CRED:password}}/g,creds.password||''); };
  switch(step.type){
    case 'navigate':{const u=r(step.url); if(u){ await page.goto(u,{waitUntil:'domcontentloaded',timeout:30000}); } break;}
    case 'type':{ const loc=await findLocator(page,step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().fill(''); await loc.first().fill(r(step.value)); break; }
    case 'click':{ const loc=await findLocator(page,step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().click(); break; }
    case 'select':{ const loc=await findLocator(page,step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().selectOption({label:r(step.value)}); break; }
    case 'wait':{ await page.waitForTimeout(ms(step.waitSec||1)); break; }
    case 'pestpac-login':{ await loginToPestPac(page,creds); break; }
  }
}
// v2.2.2: shared canonical login (was a copy of the hardened sequence; now sourced from LOGIN_TO_PESTPAC_SRC).
${LOGIN_TO_PESTPAC_SRC}

// Count + log out every BUU session on the License Manager page. Returns {before, after, loggedOut}.
async function sweepOnce(page){
  await page.goto('https://app.pestpac.com/license.asp?Mode=View',{waitUntil:'domcontentloaded',timeout:30000});
  // Each session row: first <td sortdata="USER"> contains the username; a checkbox input[name="LogOutUserN"].
  // Tick only rows whose username cell text is EXACTLY "BUU".
  const before = await page.evaluate((BUU)=>{
    let n=0; const rows=document.querySelectorAll('tr.records-table-data');
    rows.forEach(tr=>{ const td=tr.querySelector('td[sortdata]'); if(!td)return; const user=(td.getAttribute('sortdata')||td.textContent||'').trim(); if(user===BUU){ n++; const cb=tr.querySelector('input[type=checkbox][name^="LogOutUser"]'); if(cb && !cb.checked) cb.click(); } });
    return n;
  }, BUU_USER);
  if(before===0) return { before:0, after:0, loggedOut:0 };
  // Click the master Log Out button.
  try{ await page.click('#butLogOut',{timeout:10000}); }catch(e){ try{ await page.evaluate(()=>{ if(typeof butLogOut_OnClick==='function') butLogOut_OnClick(); }); }catch(_){} }
  // butLogOut may raise a confirm() dialog — auto-accept.
  page.on('dialog', async d=>{ try{ await d.accept(); }catch(_){} });
  await page.waitForTimeout(3000);
  // Re-read the page to confirm BUU sessions are gone.
  await page.goto('https://app.pestpac.com/license.asp?Mode=View',{waitUntil:'domcontentloaded',timeout:30000});
  const after = await page.evaluate((BUU)=>{
    let n=0; document.querySelectorAll('tr.records-table-data').forEach(tr=>{ const td=tr.querySelector('td[sortdata]'); if(!td)return; const user=(td.getAttribute('sortdata')||td.textContent||'').trim(); if(user===BUU) n++; });
    return n;
  }, BUU_USER);
  return { before, after, loggedOut: Math.max(0, before-after) };
}

async function main(){
  const creds=dec(fs.readFileSync(CRED_PATH,'utf8'))[0]||{};
  const browser = await chromium.launch({ headless:true, executablePath:CHROMIUM_EXE, args:['--disable-gpu','--disable-dev-shm-usage'] });
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', async d=>{ try{ await d.accept(); }catch(_){} });
  emit({type:'sweep-login'});
  try{
    if(LOGIN_STEPS && LOGIN_STEPS.length){ for(const s of LOGIN_STEPS){ await runStep(page,s,creds); } }
    else { await loginToPestPac(page,creds); }
  }catch(e){ emit({type:'sweep-fatal',error:'sweep login failed: '+e.message}); try{await browser.close();}catch(_){} process.exit(1); }
  // Sweep up to 3 passes (a session can take a moment to release).
  let result={before:0,after:0,loggedOut:0};
  for(let pass=1; pass<=3; pass++){
    try{ result = await sweepOnce(page); }catch(e){ emit({type:'sweep-error',pass,error:e.message}); }
    emit({type:'sweep-pass', pass, before:result.before, after:result.after, loggedOut:result.loggedOut});
    if(result.after===0) break;
    await page.waitForTimeout(2000);
  }
  // Log THIS sweeper's own session out too (canonical verified logout, engine/login.js).
  let _selfOut=false;
  try{ const _r = await logoutFromPestPac(page); _selfOut = !!(_r && _r.ok); }catch(e){}
  emit({type:'sweep-done', remaining:result.after, loggedOut:result.loggedOut, selfLoggedOut:_selfOut});
  try{ await browser.close(); }catch(e){}
  process.exit(result.after===0 ? 0 : 2);
}
main().catch(e=>{ emit({type:'sweep-fatal',error:e.message}); process.exit(1); });
`;
}

// ── ONCE-FLOW RUNNER (v2.1.1 #8) ──────────────────────────────────────────────
// Runs a setup OR teardown once-flow a single time in its own headless session, for the
// 'per-job' / 'global' setup-scope modes (where workers do NOT run the once-flows themselves).
// Logs in, runs the steps with the given RUN_CONTEXT, then VERIFIES logout (same as workers).
function buildOnceFlowRunner({ chromiumExePath, loginSteps, onceSteps, runContext }) {
  return `
const { chromium } = require('playwright-core');
const fs = require('fs');
const crypto = require('crypto');
const CHROMIUM_EXE = ${JSON.stringify(chromiumExePath)};
const LOGIN_STEPS = ${JSON.stringify(loginSteps || [])};
const ONCE_STEPS = ${JSON.stringify(onceSteps || [])};
const RUN_CONTEXT = ${JSON.stringify(runContext || {})};
const CRED_PATH = process.argv[2];
const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\\n');}
function ms(s){return Math.round(parseFloat(s||1)*1000);}
// v2.2.2: shared canonical login (was the 4th and final inline copy; now sourced from LOGIN_TO_PESTPAC_SRC).
${LOGIN_TO_PESTPAC_SRC}
async function runStep(page, step, creds){
  const r=v=>{ if(!v)return''; return v.replace(/{{CRED:companyKey}}/g,creds.companyKey||'').replace(/{{CRED:username}}/g,creds.username||'').replace(/{{CRED:password}}/g,creds.password||'').replace(/{{([^}]+)}}/g,function(_,ref){ if(ref==='TODAY')return RUN_CONTEXT.today||''; if(ref==='RUNID')return RUN_CONTEXT.runId||''; if(ref==='PROFILE_USERNAME')return RUN_CONTEXT.profileUsername||''; return ''; }); };
  switch(step.type){
    case 'navigate':{const u=r(step.url); if(!u) throw new Error('Navigate URL empty'); await page.goto(u,{waitUntil:'domcontentloaded',timeout:60000}); break;}
    case 'click':{ const loc=page.locator(step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().click(); break; }
    case 'type':{ const loc=page.locator(step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().fill(''); await loc.first().fill(r(step.value)); break; }
    case 'select':{ const loc=page.locator(step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); await loc.first().selectOption({label:r(step.value)}); break; }
    case 'checkbox':{ const loc=page.locator(step.selector); await loc.first().waitFor({state:'visible',timeout:30000}); if(step.checkAction==='uncheck')await loc.first().uncheck(); else await loc.first().check(); break; }
    case 'wait':{ if(step.waitType==='element'){ await page.locator(step.waitSel||'').first().waitFor({state:'visible',timeout:30000}); } else { await page.waitForTimeout(ms(step.waitSec||1)); } break; }
    case 'pestpac-login':{ await loginToPestPac(page,creds); break; }
    case 'pestpac-logout':{ break; } // logout handled centrally below
  }
}
async function main(){
  const creds=dec(fs.readFileSync(CRED_PATH,'utf8'))[0]||{};
  const browser = await chromium.launch({ headless:true, executablePath:CHROMIUM_EXE, args:['--disable-gpu','--disable-dev-shm-usage'] });
  const page = await (await browser.newContext()).newPage();
  page.on('dialog', async d=>{ try{ await d.accept(); }catch(_){} });
  emit({type:'once-login', phase:RUN_CONTEXT.phase});
  try{
    if(LOGIN_STEPS && LOGIN_STEPS.length){ for(const s of LOGIN_STEPS){ await runStep(page,s,creds); } }
    else { await loginToPestPac(page,creds); }
  }catch(e){ emit({type:'once-fatal',error:'login failed: '+e.message}); try{await browser.close();}catch(_){} process.exit(1); }
  let _ok=true, _err='';
  for(let i=0;i<ONCE_STEPS.length;i++){ try{ await runStep(page,ONCE_STEPS[i],creds); }catch(e){ _ok=false; _err='step '+(i+1)+': '+e.message; break; } }
  emit({type:'once-steps-done', ok:_ok, error:_err, phase:RUN_CONTEXT.phase});
  // Verified logout via the ONE canonical routine (engine/login.js), platform-aware.
  let _out=false;
  try{ const _r = await logoutFrom(page, creds); _out = !!(_r && _r.ok); }catch(e){ _out=false; }
  emit({type:'once-done', ok:_ok, loggedOut:_out, phase:RUN_CONTEXT.phase});
  try{ await browser.close(); }catch(e){}
  process.exit(_ok?0:2);
}
main().catch(e=>{ emit({type:'once-fatal',error:e.message}); process.exit(1); });
`;
}

function fetchJSON(url, redirects) {
  redirects = redirects || 0;
  return new Promise((res, rej) => {
    if (redirects > 5) return rej(new Error('Too many redirects'));
    // 3.0.5: 15s timeout — this had NO timeout at all, so a hung socket meant the
    // update check silently never answered (reads as "check fails" with no error).
    // Errors now name the URL so the failure is diagnosable from the dialog alone.
    const req = (url.startsWith('https') ? https : http).get(url, r => {
      if ([301,302,307,308].includes(r.statusCode) && r.headers.location) {
        r.resume();
        return res(fetchJSON(r.headers.location, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode + ' fetching ' + url)); }
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(new Error('Bad JSON from ' + url + ': ' + e.message)); } });
      r.on('error', e => rej(new Error('Connection error reading ' + url + ': ' + e.message)));
    }).on('error', e => rej(new Error('Could not reach ' + url + ': ' + e.message)));
    req.setTimeout(15000, () => { req.destroy(new Error('Timed out after 15s fetching ' + url)); });
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
      r.on('data', c => { recv += c.length; if (tot > 0 && mainWindow) _send('update-progress', Math.round(recv/tot*100)); });
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
// 3.0.6: RETRY TRANSIENT RESETS. Matthew's screenshot (07-17): first open =>
// "Update check failed: read ECONNRESET", second open => works. The corporate
// firewall/SSL-inspection box resets the FIRST connection to a cold host; the next
// attempt succeeds. One reset was treated as final — which also killed the SILENT
// startup check, so the update bar only appeared on the second open. Retry up to 3
// attempts (2s apart) on transient network errors before reporting anything.
function _isTransientNetErr(e) {
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|Timed out/i.test((e && e.message) || '');
}
async function checkForUpdates(manual) {
  if (VERSION_URL.includes('YOUR_HOST')) { if (manual) _send('update-status', { type: 'not-configured' }); return; }
  let lastErr = null;
  for (let a = 1; a <= 3; a++) {
    try {
      const info = await fetchJSON(VERSION_URL);
      if (semverGt(info.version, CURRENT_VERSION)) _send('update-available', info);
      else if (manual) _send('update-status', { type: 'up-to-date', version: CURRENT_VERSION });
      return;
    } catch (e) {
      lastErr = e;
      if (!_isTransientNetErr(e) || a === 3) break;
      console.warn('[update] check attempt ' + a + ' failed transiently (' + e.message + ') — retrying in 2s');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (manual) _send('update-status', { type: 'error', message: lastErr.message });
}
ipcMain.handle('check-for-updates', () => checkForUpdates(true));
ipcMain.handle('install-update', async (_, { downloadUrl }) => {

  // v3.0.3: an update quit is not a user close. Deal with unsaved work UP FRONT —
  // before spending a 200MB download — then tell the close gate to stand down, or the
  // installer launches, finds BUU still alive behind an unsaved-changes prompt, and
  // quietly does nothing.
  if (flowDirtyMain) {
    const _r = await dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
      title: 'Unsaved changes',
      message: 'Save your flow before updating?',
      detail: 'Installing the update restarts BUU. Unsaved changes to your flow would be lost.',
    });
    if (_r.response === 2) return { ok: false, cancelled: true };
    if (_r.response === 0) {
      _send('save-flow-then-close');
      return { ok: false, savingFirst: true };
    }
    flowDirtyMain = false; // "Don't Save" — discard, and stop the gate re-asking at quit
  }
  // 3.0.5 SAFETY NET (belt to the installer's braces): before ANY in-app update,
  // copy flows + schedules (small JSONs) into userData, which no installer touches.
  // The NSIS park should make this redundant — after 07-17 (flows/schedules wiped by
  // a manual install) redundancy on user data is the point, not waste.
  try {
    const bak = path.join(app.getPath('userData'), 'update-backup');
    try { fs.rmSync(bak, { recursive: true, force: true }); } catch (e) {}
    fs.mkdirSync(bak, { recursive: true });
    for (const d of ['flows', 'schedules']) {
      const src = path.join(buuRoot(), d);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(bak, d), { recursive: true });
    }
    console.log('[update] flows+schedules backed up to ' + bak);
  } catch (e) { console.warn('[update] pre-update backup failed (continuing): ' + e.message); }
  const updateDir = path.join(app.getPath('userData'), 'updates');
  if (!fs.existsSync(updateDir)) fs.mkdirSync(updateDir, { recursive: true });
  const tmp = path.join(updateDir, 'buu-update.exe');
  try {
    // 3.0.6: same first-connection-reset retry as the check (ECONNRESET on cold path).
    try { await downloadFile(downloadUrl, tmp); }
    catch (e) {
      if (!_isTransientNetErr(e)) throw e;
      console.warn('[update] download failed transiently (' + e.message + ') — retrying once in 2s');
      await new Promise(r => setTimeout(r, 2000));
      await downloadFile(downloadUrl, tmp);
    }
    // Strip Zone.Identifier so SmartScreen doesn't block it
    try {
      const { execFileSync } = require('child_process');
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Unblock-File -Path '${tmp}'`
      ]);
    } catch {}
    // v3.0.3: forceClosing MUST be set before quitting, or the R10 close gate blocks
    // the update restart. This one missing line made the in-app updater unusable.
    forceClosing = true;
    // 3.x FIX: the installer launch was fire-and-forget. shell.openPath() returns an ERROR
    // STRING (it does not throw) and that return was ignored, so a failed launch still let
    // the app quit 2s later — leaving the user with the app closed and NO installer running
    // (the "downloads but never installs" bug). Launch as a DETACHED child so the installer
    // survives this app quitting, VERIFY it started, and only quit on a confirmed launch.
    let launched = false, launchErr = '';
    try {
      const child = spawn(tmp, [], { detached: true, stdio: 'ignore' });
      child.on('error', () => {}); // never let a spawn error bubble as an unhandled rejection
      child.unref();
      launched = true;
    } catch (e) { launchErr = e.message; }
    if (!launched) {
      // Fallback to the shell association; openPath returns '' on success, else an error string.
      const openErr = await shell.openPath(tmp);
      if (openErr) { launchErr = openErr; } else { launched = true; }
    }
    if (!launched) {
      forceClosing = false; // stand down — do NOT quit; the update did not start
      return { ok: false, error: 'Downloaded, but could not launch the installer: ' + (launchErr || 'unknown') + '. It is saved at ' + tmp };
    }
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
    // v3.0.2: trim BEFORE these headers become chips/tokens. The CSV branch above
    // already trimmed; XLSX never did, so the two disagreed.
    headers = (raw[0] || []).map(h => String(h).trim()).filter(Boolean);
    previewRows = raw.slice(1).filter(r => r.some(c => c !== ''));
    const wb2 = XLSX.readFile(fp);
    totalRows = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]]).length;
  }
  return { filePath: fp, name: path.basename(fp), headers, previewRows, totalRows };
});

// v2.2.3 Session 3F (B2): working-data convention enforcement. Move a completed spreadsheet
// from <parent>/ (typically upcoming/) into <parent>/Finished/. One-click archive so the user
// stops hand-moving files mid-process — the design-doc rule that motivated B2. If Finished/
// doesn't exist yet, create it. If a file with the same name already exists in Finished/,
// suffix the destination with a timestamp so we never silently overwrite.
ipcMain.handle('archive-spreadsheet', async (_, { spreadsheetPath }) => {
  try {
    if (!spreadsheetPath || typeof spreadsheetPath !== 'string') return { ok: false, error: 'No path provided' };
    if (!fs.existsSync(spreadsheetPath)) return { ok: false, error: 'Source file not found: ' + spreadsheetPath };
    const srcDir = path.dirname(spreadsheetPath);
    const baseName = path.basename(spreadsheetPath);
    const archiveDir = path.join(srcDir, 'Finished');
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    let destName = baseName;
    let dest = path.join(archiveDir, destName);
    if (fs.existsSync(dest)) {
      // Suffix with timestamp to avoid overwriting an earlier archive of the same name.
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, baseName.length - ext.length);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      destName = stem + '_' + ts + ext;
      dest = path.join(archiveDir, destName);
    }
    fs.renameSync(spreadsheetPath, dest);
    return { ok: true, archivedTo: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-flow', async (_, { json, name, sub }) => {
  const defaultName = (name || 'buu-flow') + '.json';
  ensureFlowSubdirs(getFlowsDir());
  // R9: default into the folder matching the flow type (once / automation / general).
  const _sub = FLOW_SUBS.includes(sub) ? sub : 'general';
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Save flow',
    defaultPath: path.join(getFlowsDir(), app.isPackaged ? _sub : '', defaultName), // dev saves flat (shared with installed app)
    filters: [{ name: 'BUU Flow', extensions: ['json'] }]
  });
  if (r.canceled) return null;
  // v1.2.8.1 hotfix: the filename is the source of truth for a flow's display name.
  // Earlier behavior set `name` from a fallback chain that defaulted to 'buu-flow' when
  // both the in-memory flowName and the flowNotes UI field were empty — which is every
  // time the user creates a fresh flow, because there's no UI to enter a name. The
  // resulting JSON had `name: "buu-flow"` regardless of what filename the user picked
  // in the Save dialog, so the dropdown showed every once-flow as "buu-flow".
  //
  // Fix: derive `name` from the chosen filename's stem and rewrite the JSON before
  // writing. This is one-way: the renderer-supplied name in JSON is discarded.
  try {
    const parsed = JSON.parse(json);
    parsed.name = path.basename(r.filePath, '.json');
    // v3.0.3: lastGoodWorkers is written by the pool in the BACKGROUND directly into the
    // flow file; the renderer NEVER carries it in its flow object (by design — it cannot
    // clobber what it never holds). But saveFlow rebuilds the whole JSON from renderer
    // memory, so an overwrite here would silently DELETE the key. Carry the on-disk value
    // across. Save-As to a new filename finds no existing file and correctly starts fresh.
    try {
      if (fs.existsSync(r.filePath)) {
        const prev = JSON.parse(fs.readFileSync(r.filePath, 'utf8'));
        if (prev && prev.lastGoodWorkers != null) parsed.lastGoodWorkers = prev.lastGoodWorkers;
      }
    } catch (e2) { /* unreadable prior file — nothing to preserve */ }
    json = JSON.stringify(parsed, null, 2);
  } catch (e) {
    // If JSON is unparseable we have bigger problems, but don't lose the save —
    // write whatever the renderer sent and let load surface the error later.
    console.warn('[save-flow] could not rewrite name field:', e.message);
  }
  fs.writeFileSync(r.filePath, json);
  return r.filePath;
});
// R5b Tier 1: silent flow read by display name (the filename is the source of truth
// for flow names since v1.2.8.1). Returns { json, mtime, path } or null. The pool
// launch path uses this so what RUNS is always the saved file, deterministically.
ipcMain.handle('read-flow-by-name', async (_, { name }) => {
  try {
    const safe = String(name || '').replace(/[\\/:*?"<>|]/g, '_');
    if (!safe) return null;
    // 3.x FIX: search SUBFOLDERS FIRST, flat root LAST. Saving files a flow into a subfolder
    // (automation/general/once), so the subfolder copy is always the freshest; the old
    // root-first order made a stale bundled root duplicate win over the user's edited
    // subfolder copy — the flow that RAN was not the flow that was SAVED. Root is now only a
    // last-resort fallback for genuine flat stragglers with no subfolder copy.
    for (const sub of ['automation', 'once', 'general', '']) {
      const fp = path.join(getFlowsDir(), sub, safe + '.json');
      if (fs.existsSync(fp)) return { json: fs.readFileSync(fp, 'utf8'), mtime: fs.statSync(fp).mtimeMs, path: fp };
    }
    return null;
  } catch (e) { return null; }
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

// v1.2.8: scan the flows directory for once-flows. Returns [{name, filePath, runMode}].
// Used by the renderer to populate setup/teardown dropdowns.
// Tolerant of malformed JSON: bad files are skipped (logged once per call), not surfaced
// as errors — the renderer dropdown should always work even if a stray file is corrupt.
ipcMain.handle('list-once-flows', async () => {
  const dir = getFlowsDir();
  ensureFlowSubdirs(dir);
  let entries = [];
  // R9: the setup/teardown picker reads flows\once\ plus any flat stragglers at the
  // root (pre-R9 saves, or files dropped in by hand).
  // 3.0.4: also scan automation\ — an automation flow is a once flow with the flag, and
  // legacy saves may have filed one there; the runMode==='once' filter below still rules.
  for (const d of [path.join(dir, 'once'), path.join(dir, 'automation'), dir]) {
    let names = [];
    try { names = fs.readdirSync(d).filter(f => f.toLowerCase().endsWith('.json')); } catch (e) { continue; }
    for (const f of names) entries.push({ filename: f, dir: d });
  }
  const results = [];
  const errors = [];
  for (const ent of entries) {
    const filename = ent.filename;
    const fp = path.join(ent.dir, filename);
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      // Pre-v1.1 flows have no runMode; they're implicitly 'per-row' and excluded here.
      if (data.runMode === 'once') {
        // v1.2.8.1 hotfix: prefer filename over data.name. Older saves stamped `name` as
        // the literal string 'buu-flow' for every flow (no UI to enter a name; fallback
        // chain bottomed out at the literal). Filename is the user's intentional choice
        // from the Save dialog and is always meaningful.
        results.push({
          name: filename.replace(/\.json$/i, ''),
          filename,
          filePath: fp,
          runMode: 'once',
          // 3.0.4: surface the automation flag so the schedules picker can filter.
          // Matthew: "once is ment for build up and tear down, automation is a once
          // flow with the automation checkbox checked" — the FLAG is the truth, not
          // the subfolder a file happens to live in.
          automation: !!data.automation
        });
      }
    } catch (e) {
      errors.push({ filename, error: e.message });
    }
  }
  if (errors.length) {
    console.warn('[list-once-flows] skipped malformed files:', errors);
  }
  return { ok: true, flows: results, skipped: errors.length };
});

// v1.2.8: given a flow JSON (or its parsed form), check that referenced setup/teardown
// flows exist on disk and have runMode === 'once'. Returns [{field, ref, status, msg}].
// status is 'ok' | 'missing' | 'wrong-mode' | 'not-applicable'.
// Used by renderer's pre-run validation to catch dangling references.
ipcMain.handle('validate-flow-references', async (_, { flow }) => {
  const issues = [];
  // Once-flows shouldn't have either field set; renderer already flags that as an error
  // before we get here, but be safe.
  if (flow && flow.runMode === 'once') {
    return { ok: true, issues: [] };
  }
  const checkOne = (field, ref) => {
    if (!ref) {
      issues.push({ field, ref: null, status: 'not-applicable', msg: '' });
      return;
    }
    // 3.x: resolve subfolder-first (same lookup as the run path) so validation matches what
    // actually runs, and doesn't false-report "missing" after the flat-root dedup.
    const found = resolveOnceFlowByName(ref);
    if (!found) {
      issues.push({ field, ref, status: 'missing', msg: 'Flow "' + ref + '" not found in flows directory.' });
      return;
    }
    if (found.runMode !== 'once') {
      issues.push({ field, ref, status: 'wrong-mode', msg: 'Flow "' + ref + '" exists but is not a once-flow (runMode = ' + (found.runMode || 'per-row') + ').' });
      return;
    }
    issues.push({ field, ref, status: 'ok', msg: '' });
  };
  checkOne('setupFlowId', flow ? flow.setupFlowId : null);
  checkOne('teardownFlowId', flow ? flow.teardownFlowId : null);
  return { ok: true, issues };
});
ipcMain.handle('open-flows-folder', () => shell.openPath(getFlowsDir()));
ipcMain.handle('open-log-folder', () => shell.openPath(getLogsDir()));
ipcMain.handle('open-file', (_, p) => shell.openPath(p));
ipcMain.handle('get-version', () => CURRENT_VERSION);
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

// ── TASKBAR PIN (v2.1.0 #1) ───────────────────────────────────────────────────
// On first packaged launch, offer to pin BUU 2.0 to the taskbar. Windows has no official
// pin API, so we use the classic Shell.Application verb on the Start-Menu shortcut. That verb
// is localized and was removed/blocked on many Windows 11 builds (22H2+), so this is strictly
// best-effort: it must NEVER block startup, throw, or nag. We ask at most once and persist the
// outcome in config (pinPromptDone), so a "No" — or a build where pinning is impossible — is
// remembered and never asked again. Detection: scan the User Pinned\TaskBar folder for a .lnk
// whose target resolves to our exe.

// The actual helper script. It prints a single status token on the last line:
function buildPinHelperScript(exePath, appName) {
  const esc = s => String(s).replace(/'/g, "''");
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$exe = '${esc(exePath)}'`,
    `$appName = '${esc(appName)}'`,
    '$exeLeaf = Split-Path $exe -Leaf',
    '$pinDir = Join-Path $env:APPDATA "Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"',
    '$sh = New-Object -ComObject WScript.Shell',
    '# 1) Detection: is a shortcut targeting our exe already pinned?',
    'if (Test-Path $pinDir) {',
    '  $existing = Get-ChildItem -Path $pinDir -Filter *.lnk -ErrorAction SilentlyContinue',
    '  foreach ($lnk in $existing) {',
    '    $t = $sh.CreateShortcut($lnk.FullName).TargetPath',
    '    if ($t -and ($t -ieq $exe -or (Split-Path $t -Leaf) -ieq $exeLeaf)) { Write-Output "already-pinned"; exit 0 }',
    '  }',
    '}',
    '# 2) Find the Start-Menu shortcut to pin (pinning a .lnk is more reliable than the raw exe).',
    '$startMenu = [Environment]::GetFolderPath("Programs")',
    '$lnkPath = $null',
    'if (Test-Path $startMenu) {',
    '  $cand = Get-ChildItem -Path $startMenu -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |',
    '    Where-Object { $t = $sh.CreateShortcut($_.FullName).TargetPath; $t -and ((Split-Path $t -Leaf) -ieq $exeLeaf) } |',
    '    Select-Object -First 1',
    '  if ($cand) { $lnkPath = $cand.FullName }',
    '}',
    '$target = if ($lnkPath) { $lnkPath } else { $exe }',
    '# 3) Invoke the localized "Pin to taskbar" shell verb via Shell.Application.',
    '$shell = New-Object -ComObject Shell.Application',
    '$folder = $shell.Namespace((Split-Path $target -Parent))',
    '$item = $folder.ParseName((Split-Path $target -Leaf))',
    '$verb = $null',
    'foreach ($v in $item.Verbs()) {',
    '  $n = $v.Name -replace "&",""',
    '  if ($n -match "taskbar" -or $n -match "Taskbar") { $verb = $v; break }',
    '}',
    'if ($verb) { $verb.DoIt(); Start-Sleep -Milliseconds 600; Write-Output "pinned"; exit 0 }',
    'Write-Output "cannot-pin"; exit 0',
  ].join("\r\n");
}

function recordPinOutcome(outcome) {
  try { writeConfig({ pinPromptDone: true, pinOutcome: outcome, pinPromptAt: new Date().toISOString() }); } catch {}
}

async function maybePinToTaskbar() {
  try {
    // Dev runs have no installed exe/Start-Menu shortcut — skip entirely.
    if (!app.isPackaged || process.platform !== 'win32') return;
    const cfg = readConfig();
    if (cfg && cfg.pinPromptDone) return; // already asked once (Yes, No, or impossible) — never nag.

    const exePath = process.execPath; // the installed BUU 2.0 .exe
    // Ask permission (non-blocking to the app — we await the dialog, but the window is already shown).
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Pin to taskbar', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      title: 'Pin BUU 2.0?',
      message: 'Pin BUU 2.0 to your taskbar?',
      detail: 'This adds a one-click shortcut on your Windows taskbar. You can unpin it any time by right-clicking the icon.',
      noLink: true,
    });
    if (response !== 0) { recordPinOutcome('declined'); return; } // remembered — won't ask again.

    // Write the helper to a temp .ps1 and run it detached. -File avoids -Command quoting issues.
    const ps1 = path.join(os.tmpdir(), `buu-pin-${Date.now()}.ps1`);
    try { fs.writeFileSync(ps1, buildPinHelperScript(exePath, 'BUU 2.0'), 'utf8'); }
    catch (e) { recordPinOutcome('error'); return; }

    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        const out = String(stdout || '').trim().split(/\r?\n/).pop() || '';
        const outcome = err ? 'error' : (out || 'unknown');
        recordPinOutcome(outcome);
        try { fs.unlinkSync(ps1); } catch {}
        try { console.log('[main] taskbar pin outcome: ' + outcome); } catch {}
      }
    );
  } catch (e) {
    // Absolutely never let pinning break startup.
    try { recordPinOutcome('error'); } catch {}
  }
}

// ── WINDOW ────────────────────────────────────────────────────────────────────
function getIconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'assets', 'icon.ico');
  return path.join(__dirname, '..', 'assets', 'icon.ico');
}

function createWindow() {
  const iconPath = getIconPath();
  // v1.3.x: size the window relative to the user's actual screen instead of a fixed pixel
  // size. Use 85% of the primary display's work area (screen minus taskbar), so the window
  // is proportionally large on any monitor and never opens bigger than the display. Floors
  // keep it usable on very small screens. workAreaSize is valid here because createWindow
  // runs from app.whenReady().
  const { width: scrW, height: scrH } = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.max(1000, Math.round(scrW * 0.85));
  const winH = Math.max(680, Math.round(scrH * 0.85));
  mainWindow = new BrowserWindow({
    width: winW, height: winH, minWidth: 1000, minHeight: 680,
    icon: iconPath,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    backgroundColor: '#0f0f11', show: false, title: 'BUU 2.0'
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // v3.0.2: right-click menu. Electron ships NO default context menu — without this,
  // right-click does nothing anywhere in the app (which is exactly what it did).
  // editFlags come from Chromium, so each item is enabled only when it's genuinely
  // available (canPaste is false when the clipboard has nothing pasteable, etc.).
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const ef = params.editFlags || {};
    const selected = (params.selectionText || '').trim().length > 0;
    if (!params.isEditable && !selected) return; // nothing sensible to offer
    const template = [
      { role: 'cut', enabled: !!ef.canCut },
      { role: 'copy', enabled: !!ef.canCopy },
      { role: 'paste', enabled: !!(params.isEditable && ef.canPaste) },
      { type: 'separator' },
      { role: 'selectAll', enabled: !!ef.canSelectAll },
    ];
    try { Menu.buildFromTemplate(template).popup({ window: mainWindow }); } catch (e) {}
  });
  // R10: intercept close while a flow has unsaved changes.
  mainWindow.on('close', (e) => {
    if (forceClosing || !flowDirtyMain) return;
    e.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
      title: 'Unsaved changes', message: 'This flow has unsaved changes.', detail: 'Save before closing BUU?',
    }).then(r => {
      if (r.response === 0) { try { _send('save-flow-then-close'); } catch (e2) {} }
      else if (r.response === 1) { forceClosing = true; mainWindow.close(); }
      // Cancel: stay open.
    }).catch(() => {});
  });
  // v1.3.1 Item 6 (real fix): the per-class CSS font bumps didn't visibly change anything
  // because nearly every element in index.html pins its own px font-size, so bumping `body`
  // never cascaded. Native Chromium zoom scales the ENTIRE rendered UI uniformly — fonts,
  // padding, icons — regardless of inheritance. This is the reliable "make everything bigger"
  // lever. Applied on did-finish-load because setZoomFactor before the page loads gets reset.
  // 1.35 = 35% larger. Adjust this single number to taste.
  mainWindow.webContents.on('did-finish-load', () => {
    try { mainWindow.webContents.setZoomFactor(1.35); } catch (e) {}
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    checkForUpdates(false);
    // v2.1.0 (#1): offer to pin to the taskbar on first packaged launch. Delayed so the window
    // is settled and we don't stack a dialog on top of the update banner. Best-effort, never blocks.
    setTimeout(() => { maybePinToTaskbar(); }, 1500);
  });
  mainWindow.setMenuBarVisibility(false);
}
// Single instance lock — prevent opening a second window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // v2.0.0: force a stable distinct app name so userData resolves to a BUU-2-specific folder
  // (%APPDATA%\BUU 2.0) in BOTH dev and packaged runs — fully isolated from Legacy's data.
  try { app.setName('BUU 2.0'); } catch(e){}
  app.on('second-instance', () => {
  // Phase 3 (D1): a second launch used to only focus the existing window — with lingering
  // processes common, fresh launches were rare and the update prompt almost never appeared.
  // Re-check on every second launch so updates surface even without a clean restart.
  try { checkForUpdates(false); } catch {}
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.setAppUserModelId('com.entomobands.buu-2');
  // Phase 3 CRASH SAFETY: launch recovery. (1) Kill orphaned workers from a dead run —
// pidfile entries whose PID still resolves to our own exe name (guards PID reuse; the
// workers run under the app's exe via ELECTRON_RUN_AS_NODE, which is exactly why they
// blend into Task Manager and lingered invisibly — D1). (2) Merge worker spill files
// into pool journals before any Resume offer, so crash-finished rows are not re-run.
// R10: unsaved-changes prompt on app close. The renderer keeps us informed of dirty
// state; close is intercepted once and prompted natively (Save / Don’t Save / Cancel).
// Save round-trips through the renderer — the save dialog lives there.
// (R10 close-prompt state moved to module scope — see the declarations near mainWindow.)
ipcMain.on('flow-dirty-state', (_, v) => { flowDirtyMain = !!v; });
ipcMain.on('flow-close-now', () => { forceClosing = true; try { mainWindow.close(); } catch (e) {} });
ipcMain.handle('confirm-unsaved', async () => {
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
    title: 'Unsaved changes', message: 'This flow has unsaved changes.', detail: 'Save them before switching flows?',
  });
  return r.response;
});

// R9: flow folders. flows\once\ (setup/teardown once-flows), flows\automation\
// (ONLY flows the user explicitly flags — nothing is auto-flagged), flows\general\
// (everything else). Startup migration sorts flat legacy flows by runMode.
// (FLOW_SUBS moved to module scope — see the declaration near mainWindow. It is read by
// the module-scope save-flow / list-flows handlers, which a block-scoped const broke.)
function ensureFlowSubdirs(dir) {
  for (const s2 of FLOW_SUBS) { const p2 = path.join(dir, s2); if (!fs.existsSync(p2)) { try { fs.mkdirSync(p2, { recursive: true }); } catch (e) {} } }
}
function migrateFlowsIntoFolders() {
  try {
    // PACKAGED ONLY: dev shares userData with the installed app — never re-sort its live flat flows.
    if (!app.isPackaged) return;
    const dir = getFlowsDir();
    ensureFlowSubdirs(dir);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.toLowerCase().endsWith('.json'));
    let moved = 0, deduped = 0;
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      let sub = 'general';
      try { const d = JSON.parse(fs.readFileSync(fp, 'utf8')); if (d.runMode === 'once') sub = 'once'; } catch (err) {}
      const dst = path.join(dir, sub, e.name);
      try {
        if (!fs.existsSync(dst)) { fs.renameSync(fp, dst); moved++; }
        else {
          // 3.x: duplicate — subfolders are canonical. Keep the NEWER copy in the subfolder,
          // then delete the redundant flat root copy so the resolver never sees a stale dup.
          // (Root duplicates from the shipped flows-bundle were shadowing the user's edits.)
          try { if (fs.statSync(fp).mtimeMs > fs.statSync(dst).mtimeMs) fs.copyFileSync(fp, dst); } catch (e2) {}
          fs.unlinkSync(fp); deduped++;
        }
      } catch (err) {}
    }
    if (moved || deduped) console.log('[r9] sorted ' + moved + ' flat flow(s) into folders; removed ' + deduped + ' flat duplicate(s)');
  } catch (e) {}
}

// R8: one-time migration from the old %APPDATA%\buu-2 layout into the install root.
// Copy (not move) so a rollback to a pre-R8 build still finds its data.
function migrateAppDataToBuuRoot() {
  try {
    if (!app.isPackaged) return;
    const rootDir = buuRoot();
    const ud = app.getPath('userData');
    if (path.resolve(rootDir) === path.resolve(ud)) return;
    for (const d of ['flows', 'logs']) {
      const src = path.join(ud, d), dst = path.join(rootDir, d);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.cpSync(src, dst, { recursive: true }); console.log('[r8] migrated ' + d + ' -> ' + dst); } catch (e) { console.warn('[r8] migration of ' + d + ' failed: ' + e.message); }
      }
    }
  } catch (e) {}
}

function sweepOrphanWorkers() {
  try {
    const pf = path.join(app.getPath('userData'), 'worker-pids.json');
    let pids = [];
    try { pids = (JSON.parse(fs.readFileSync(pf, 'utf8')).pids || []); } catch (e) {}
    if (pids.length) {
      const { execSync } = require('child_process');
      const me = path.basename(process.execPath).toLowerCase();
      let killed = 0;
      for (const pid of pids) {
        if (!pid || pid === process.pid) continue;
        try {
          const out = execSync('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
          const mm = out.match(/^"([^"]+)"/m);
          if (mm && mm[1].toLowerCase() === me) { process.kill(pid); killed++; }
        } catch (e) {}
      }
      if (killed) console.log('[crash-safety] killed ' + killed + ' orphaned worker process(es) from a previous run');
    }
    try { fs.writeFileSync(pf, JSON.stringify({ pids: [] })); } catch (e) {}
  } catch (e) {}
  try {
    const merged = require('./journal').mergeSpillFiles();
    if (merged) console.log('[crash-safety] merged ' + merged + ' spilled row result(s) into pool journals');
  } catch (e) {}
}

app.whenReady().then(() => {
  migrateAppDataToBuuRoot();
  migrateFlowsIntoFolders();
  sweepOrphanWorkers();
  // R16: the scheduler. Fires spreadsheet-free (once) flows at their zone-computed
  // times; launch goes through the renderer as a dumb pipe into the existing pool
  // IPC. Schedules persist under <buuRoot>/schedules/ (userData in dev).
  try { require('./scheduler').initScheduler({
    app, ipcMain,
    buuRoot,
    COORD,
    keytar, // 3.x: scheduler sends run-notification emails via mailer.js, which reads config from the vault
    getWindow: () => mainWindow,
    readFlowByName: (name) => {
      try {
        const safe = String(name || '').replace(/[\\/:*?"<>|]/g, '_');
        if (!safe) return null;
        // 3.x FIX: subfolders first, flat root last (see read-flow-by-name) so a scheduled
        // run executes the user's EDITED subfolder copy, not a stale bundled root duplicate.
        for (const sub of ['automation', 'once', 'general', '']) {
          const fp = path.join(getFlowsDir(), sub, safe + '.json');
          if (fs.existsSync(fp)) return { json: fs.readFileSync(fp, 'utf8'), path: fp };
        }
      } catch (e) {}
      return null;
    },
  }); } catch (e) { console.error('[r16] scheduler init failed:', e.message); }
    createWindow();
    // v2.2.3 Session 3E (B4): log retention. Runs asynchronously after window creation so a
    // slow disk doesn't delay startup. Reads logRetentionDays from config; default 30.
    setImmediate(() => {
      try {
        const cfg = readConfig();
        const n = Number.isFinite(cfg.logRetentionDays) ? cfg.logRetentionDays : 30;
        cleanupOldLogs(n);
      } catch(e) { /* never block startup on cleanup */ }
    });
  });
}
// Phase 3 (D1): nothing ever killed workers on app quit — closing BUU mid-run orphaned
// N worker processes (each holding a Chromium tree + a PestPac license) under the app's
// own exe name. Kill them all on the way out; the pidfile sweep on next launch is the
// backstop for anything this misses (e.g. a hard crash where before-quit never fires).
app.on('before-quit', () => {
  try { if (COORD.licenseTimer) { clearInterval(COORD.licenseTimer); COORD.licenseTimer = null; } } catch {}
  try { for (const w of COORD.workers.values()) { try { if (w.process) w.process.kill(); } catch {} } } catch {}
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });


// ── Phase 2 wiring: coordinator module (see src/pool/coordinator.js) ──
const __coordCtx = {
  SERVICE_NAME,
  MAX_WORKERS_HARD_CEILING,
  loadRowsForJob,
  getLogsDir,
  getFlowsDir, // v3.0.3: coordSaveLastGoodW writes lastGoodWorkers into the flow's own .json
  encStore,
  readAllProfiles,
  readConfig,
  getBundledChromiumPath,
  licenseReaderLogout,
  // 3.x CRITICAL: the coordinator's elastic license checker (coordLicenseScale) needs the
  // canonical login. The v2.2.2 refactor moved login into engine/login.js but never passed it
  // here, so coordLicenseScale threw "loginToPestPacInPage is not defined" on EVERY eval —
  // the license cap silently never applied and the buffer was never enforced (the pool ran up
  // to the hardware/max limit). Wiring it restores the license cap.
  loginToPestPacInPage,
  logoutFromInPage,
  resolveOnceFlowByName,
  buildPoolWorker,
  buildLogoutSweeper,
  buildOnceFlowRunner,
  get mainWindow() { return mainWindow; },
  get keytar() { return keytar; },
};
const { COORD, coordJournalPath, coordJournalMetaPath, coordOpenJournal, coordMarkPhaseProgress, coordJournalAppend, coordJournalAppendDialog, coordCloseJournal, coordJournalDonePath, coordMarkJournalDone, coordFindOrphanPools, coordNextBatch, coordAllDrained, coordEmitStatus, coordPickJobForWorker, coordSpawnWorker, coordHandleWorkerMessage, coordCheckComplete, coordWriteReadResults, coordAppendScrape, coordRunLogoutSweep, coordMostRecentJournalPoolId, coordScaleTo, coordLicenseScale, coordEvalScale, coordRunOnceFlow, coordRunOnceFlows, coordPrepareLaunch } = require('./pool/coordinator')(__coordCtx);
