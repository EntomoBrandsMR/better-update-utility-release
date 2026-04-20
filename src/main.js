const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const CURRENT_VERSION = '1.0.0';
const SERVICE_NAME = 'CRMAutomator';
const VERSION_URL = 'https://YOUR_HOST/crm-automator/version.json';

let mainWindow;
let keytar = null;
try { keytar = require('keytar'); } catch(e) { console.warn('keytar unavailable, using encrypted fallback'); }

// ── ENCRYPTED FALLBACK STORE ──────────────────────────────────────────────────
function credFilePath() { return path.join(app.getPath('userData'), 'credentials.enc'); }
const CRED_KEY = crypto.scryptSync('crm-automator-v1', 'crm-salt-2024', 32);

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
function writeAllProfiles(arr) {
  fs.writeFileSync(credFilePath(), encStore(arr));
}

// ── CREDENTIAL IPC ────────────────────────────────────────────────────────────
ipcMain.handle('list-profiles', async () => {
  const all = readAllProfiles();
  return all.map(({ id, name, loginUrl }) => ({ id, name, loginUrl }));
});

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
    const companyKey = await keytar.getPassword(SERVICE_NAME, `${id}:companyKey`) || p.companyKey || '';
    const username   = await keytar.getPassword(SERVICE_NAME, `${id}:username`)   || p.username   || '';
    const password   = await keytar.getPassword(SERVICE_NAME, `${id}:password`)   || p.password   || '';
    return { ...p, companyKey, username, password };
  }
  return p;
});

ipcMain.handle('delete-profile', async (_, id) => {
  if (keytar) {
    for (const k of ['companyKey','username','password'])
      await keytar.deletePassword(SERVICE_NAME, `${id}:${k}`).catch(() => {});
  }
  writeAllProfiles(readAllProfiles().filter(p => p.id !== id));
  return { ok: true };
});

// ── WINDOW ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300, height: 900, minWidth: 1000, minHeight: 680,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#222', height: 40 },
    backgroundColor: '#f5f5f4', show: false
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); checkForUpdates(false); });
}

// ── AUTO-UPDATE ───────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    (url.startsWith('https') ? https : http).get(url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    (url.startsWith('https') ? https : http).get(url, res => {
      const total = parseInt(res.headers['content-length'] || '0');
      let recv = 0;
      res.on('data', chunk => {
        file.write(chunk); recv += chunk.length;
        if (total > 0 && mainWindow) mainWindow.webContents.send('update-progress', Math.round(recv/total*100));
      });
      res.on('end', () => { file.end(); resolve(); });
    }).on('error', reject);
  });
}
function semverGt(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if((pa[i]||0)>(pb[i]||0)) return true; if((pa[i]||0)<(pb[i]||0)) return false; }
  return false;
}
async function checkForUpdates(manual) {
  if (VERSION_URL.includes('YOUR_HOST')) { if(manual) mainWindow.webContents.send('update-status',{type:'not-configured'}); return; }
  try {
    const info = await fetchJSON(VERSION_URL);
    if (semverGt(info.version, CURRENT_VERSION)) mainWindow.webContents.send('update-available', info);
    else if (manual) mainWindow.webContents.send('update-status', { type:'up-to-date', version: CURRENT_VERSION });
  } catch(e) { if(manual) mainWindow.webContents.send('update-status', { type:'error', message: e.message }); }
}
ipcMain.handle('check-for-updates', () => checkForUpdates(true));
ipcMain.handle('install-update', async (_, { downloadUrl }) => {
  const tmp = path.join(os.tmpdir(), 'crm-automator-update.exe');
  try { await downloadFile(downloadUrl, tmp); execFile(tmp, ['/S'], { detached:true }); setTimeout(() => app.quit(), 1500); return { ok:true }; }
  catch(e) { return { ok:false, error: e.message }; }
});

// ── FILE I/O ──────────────────────────────────────────────────────────────────
ipcMain.handle('open-spreadsheet', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title:'Open spreadsheet', filters:[{name:'Spreadsheets',extensions:['xlsx','xls','csv']}], properties:['openFile'] });
  if (r.canceled) return null;
  return { filePath: r.filePaths[0], buffer: fs.readFileSync(r.filePaths[0]).toString('base64'), name: path.basename(r.filePaths[0]) };
});
ipcMain.handle('save-flow', async (_, { json }) => {
  const r = await dialog.showSaveDialog(mainWindow, { title:'Save flow', defaultPath:'crm-flow.json', filters:[{name:'JSON',extensions:['json']}] });
  if (r.canceled) return null; fs.writeFileSync(r.filePath, json); return r.filePath;
});
ipcMain.handle('load-flow', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title:'Load flow', filters:[{name:'JSON',extensions:['json']}], properties:['openFile'] });
  if (r.canceled) return null; return fs.readFileSync(r.filePaths[0], 'utf8');
});
ipcMain.handle('save-log', async (_, { buffer, suggestedName }) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title:'Save run log', defaultPath: suggestedName || `crm-log-${new Date().toISOString().slice(0,10)}.xlsx`,
    filters:[{name:'Excel',extensions:['xlsx']}]
  });
  if (r.canceled) return null; fs.writeFileSync(r.filePath, Buffer.from(buffer)); return r.filePath;
});
ipcMain.handle('save-script', async (_, { script, type }) => {
  const r = await dialog.showSaveDialog(mainWindow, { title:'Save script', defaultPath:`crm-automation-${type}.js`, filters:[{name:'JavaScript',extensions:['js']}] });
  if (r.canceled) return null; fs.writeFileSync(r.filePath, script); return r.filePath;
});
ipcMain.handle('get-version',    ()       => CURRENT_VERSION);
ipcMain.handle('open-external',  (_, url) => shell.openExternal(url));
ipcMain.handle('get-userdata',   ()       => app.getPath('userData'));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
