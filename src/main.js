const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const CURRENT_VERSION = '1.1.7';
const SERVICE_NAME = 'BetterUpdateUtility';
const VERSION_URL = 'https://raw.githubusercontent.com/EntomoBrandsMR/better-update-utility-release/main/version.json';

let mainWindow;
let automationProcess = null;
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
ipcMain.handle('start-automation', async (_, { stepsJson, spreadsheetPath, profileId, headless, runId, resumeFromRow, errHandle, rowDelayMin, rowDelayMax }) => {
  const steps = JSON.parse(stepsJson);
  const logPath = path.join(getLogsDir(), `BUU-log-${new Date().toISOString().slice(0,10)}-${runId}.xlsx`);
  const checkpointPath = path.join(app.getPath('userData'), `checkpoint-${runId}.json`);
  const runnerPath = path.join(os.tmpdir(), `buu-runner-${runId}.js`);
  const credPath = path.join(os.tmpdir(), `buu-cred-${runId}.enc`);

  // Write credentials to temp encrypted file
  const all = readAllProfiles();
  const prof = all.find(p => p.id === profileId) || {};
  if (keytar) {
    prof.companyKey = await keytar.getPassword(SERVICE_NAME, `${profileId}:companyKey`) || prof.companyKey || '';
    prof.username   = await keytar.getPassword(SERVICE_NAME, `${profileId}:username`)   || prof.username   || '';
    prof.password   = await keytar.getPassword(SERVICE_NAME, `${profileId}:password`)   || prof.password   || '';
  }
  fs.writeFileSync(credPath, encStore([prof]));

  // Write runner script
  const script = buildRunner(steps, logPath, checkpointPath, resumeFromRow || 0, headless, errHandle || 'stop', rowDelayMin || 1, rowDelayMax || 3);
  fs.writeFileSync(runnerPath, script);

  // Pass bundled chromium path to runner
  const chromiumExe = getBundledChromiumPath();
  if (!chromiumExe) {
    mainWindow?.webContents.send('automation-event', {
      type: 'error',
      message: `Browser engine not found. Expected at: ${path.join(process.resourcesPath || '', 'chromium', 'chrome.exe')}. Please reinstall the application.`
    });
    mainWindow?.webContents.send('automation-event', { type: 'done', code: 1, logPath });
    try { fs.unlinkSync(credPath); } catch {}
    return { ok: false, error: 'Chromium not found' };
  }
  const env = { ...process.env };
  if (chromiumExe) env.BUU_CHROMIUM_PATH = chromiumExe;

  // Point NODE_PATH so runner can find playwright-core etc
  // When packaged, node_modules live next to app.asar in resources
  const nodeModulesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : path.join(__dirname, '..', 'node_modules');
  env.NODE_PATH = nodeModulesPath;
  env.BUU_NODE_MODULES = nodeModulesPath;

  automationProcess = spawn(process.execPath, [runnerPath, spreadsheetPath, credPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  automationProcess.stdout.on('data', data => {
    String(data).split('\n').filter(Boolean).forEach(line => {
      try { mainWindow?.webContents.send('automation-event', JSON.parse(line)); } catch {}
    });
  });
  automationProcess.stderr.on('data', data => {
    mainWindow?.webContents.send('automation-event', { type: 'stderr', message: String(data) });
  });
  automationProcess.on('close', code => {
    mainWindow?.webContents.send('automation-event', { type: 'done', code, logPath });
    automationProcess = null;
    try { fs.unlinkSync(runnerPath); } catch {}
    try { fs.unlinkSync(credPath); } catch {}
  });

  return { ok: true, logPath };
});

ipcMain.handle('stop-automation', () => {
  if (automationProcess) { automationProcess.kill(); automationProcess = null; }
  return { ok: true };
});

ipcMain.handle('get-checkpoint', (_, runId) => {
  const p = path.join(app.getPath('userData'), `checkpoint-${runId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
});

// ── RUNNER SCRIPT BUILDER ─────────────────────────────────────────────────────
function buildRunner(steps, logPath, checkpointPath, resumeFrom, headless, errHandle, rowDelayMin, rowDelayMax) {
  return `
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const CRED_KEY = crypto.scryptSync('better-update-utility-v1','buu-salt-2024',32);
function dec(raw){const{iv,d}=JSON.parse(raw);const dc=crypto.createDecipheriv('aes-256-cbc',CRED_KEY,Buffer.from(iv,'hex'));return JSON.parse(Buffer.concat([dc.update(Buffer.from(d,'hex')),dc.final()]).toString('utf8'));}
function emit(o){process.stdout.write(JSON.stringify(o)+'\\n');}
function saveChk(row){try{fs.writeFileSync(CHECKPOINT,JSON.stringify({rowIndex:row,ts:new Date().toISOString()}));}catch{}}

const ALL_STEPS = ${JSON.stringify(steps)};
const LOGIN_STEPS = ALL_STEPS.filter(s => s.locked);
const DATA_STEPS  = ALL_STEPS.filter(s => !s.locked);
// Logout handled via PestPac menu — no URL needed

let logEntries=[], flushTimer=null;
function addLog(e){logEntries.push(e);if(logEntries.length%100===0)flush();else{clearTimeout(flushTimer);flushTimer=setTimeout(flush,3000);}}
function flush(){
  if(!logEntries.length)return;
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
    ]),'Summary');
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(logEntries),'All rows');
    if(errs.length)XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(errs),'Errors only');
    if(skipped.length)XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(skipped),'Skipped');
    XLSX.writeFile(wb,LOG_PATH);
  }catch(e){emit({type:'log-error',message:e.message});}
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

async function runStep(page,step,row,creds){
  const r=v=>{if(!v)return'';return v.replace(/{{CRED:companyKey}}/g,creds.companyKey||'').replace(/{{CRED:username}}/g,creds.username||'').replace(/{{CRED:password}}/g,creds.password||'').replace(/{{([^}]+)}}/g,(_,col)=>row[col]!==undefined?String(row[col]):'');};
  const ms=s=>Math.round(parseFloat(s||1)*1000);
  switch(step.type){
    case 'navigate':await page.goto(r(step.url),{waitUntil:step.waitAfter==='networkidle'?'networkidle':'load',timeout:30000});break;
    case 'click':await page.waitForSelector(step.selector,{timeout:15000});await page.click(step.selector);if(step.waitFor)await page.waitForSelector(step.waitFor,{timeout:15000});break;
    case 'type':await page.waitForSelector(step.selector,{timeout:15000});if(step.clearFirst!=='no')await page.fill(step.selector,'');if(parseInt(step.typeDelay||0)>0)await page.type(step.selector,r(step.value),{delay:parseInt(step.typeDelay)});else await page.fill(step.selector,r(step.value));break;
    case 'select':await page.waitForSelector(step.selector,{timeout:15000});await page.selectOption(step.selector,{label:r(step.value)});break;
    case 'checkbox':await page.waitForSelector(step.selector,{timeout:15000});if(step.checkAction==='check')await page.check(step.selector);else if(step.checkAction==='uncheck')await page.uncheck(step.selector);else if(step.checkAction==='toggle')await page.click(step.selector);else if(step.checkAction==='conditional'){const tv=(step.truthyVals||'yes,true,1,x').split(',').map(v=>v.trim().toLowerCase());if(tv.includes(String(r(step.condCol)).trim().toLowerCase()))await page.check(step.selector);else await page.uncheck(step.selector);}break;
    case 'clear':await page.waitForSelector(step.selector,{timeout:15000});await page.fill(step.selector,'');break;
    case 'wait':if(step.waitType==='random'){const mn=ms(step.waitMin||1),mx=ms(step.waitMax||3);await page.waitForTimeout(Math.floor(Math.random()*(mx-mn+1))+mn);}else if(step.waitType==='element')await page.waitForSelector(step.waitSel||'',{timeout:30000});else if(step.waitType==='navigation')await page.waitForNavigation({timeout:30000});else await page.waitForTimeout(ms(step.waitSec||1));break;
    case 'assert':await page.waitForSelector(step.selector,{timeout:15000});if(step.expected){const t=await page.locator(step.selector).textContent();if(!t.includes(step.expected))throw new Error('Assert failed: expected "'+step.expected+'" got "'+t+'"');}break;
    case 'pestpac-login':{
      // Full PestPac login sequence in one step
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
    case 'textedit':{
      await page.waitForSelector(step.selector,{timeout:15000});
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

  const chromiumExePath = process.env.BUU_CHROMIUM_PATH || '';
  const launchOpts = {
    headless: HEADLESS,
    executablePath: chromiumExePath || undefined,
  };
  if (!chromiumExePath) {
    emit({ type: 'fatal', error: 'BUU_CHROMIUM_PATH not set — bundled browser not found. Please reinstall the application.' });
    process.exit(1);
  }
  if (!require('fs').existsSync(chromiumExePath)) {
    emit({ type: 'fatal', error: 'Bundled browser not found at: ' + chromiumExePath + '. Please reinstall the application.' });
    process.exit(1);
  }
  emit({ type: 'log', message: 'Using browser: ' + chromiumExePath });
  const browser = await chromium.launch(launchOpts);
  const page=await(await browser.newContext()).newPage();
  let ri=0,ok=0,errs=0,skipped=0,start=Date.now();

  // Login is handled by pestpac-login step in the flow steps array

  try{
    for await(const row of streamRows(SPREADSHEET)){
      ri++;
      if(ri<=RESUME_FROM)continue;
      saveChk(ri);
      const t0=Date.now();
      const entry={row:ri,timestamp:new Date().toISOString(),url:row.URL||row.url||'',status:'ok',error:'',failedStep:'',fieldsWritten:'',durationMs:0};
      let done=[];

      const attempt=async()=>{done=[];for(const s of DATA_STEPS){await runStep(page,s,row,creds);done.push(s._label||s.type);}};

      try{
        await attempt();
        entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;ok++;
        emit({type:'row-done',rowIndex:ri,totalRows,status:'ok',url:entry.url,fieldsWritten:entry.fieldsWritten,durationMs:entry.durationMs,ok,errs,skipped,elapsed:Date.now()-start});
      }catch(e){
        if(ERR_HANDLE==='retry'){
          emit({type:'row-retry',rowIndex:ri,error:e.message});
          try{
            await attempt();
            entry.fieldsWritten=done.join(' | ');entry.durationMs=Date.now()-t0;entry.status='ok (retry)';ok++;
            emit({type:'row-done',rowIndex:ri,totalRows,status:'ok-retry',url:entry.url,fieldsWritten:entry.fieldsWritten,durationMs:entry.durationMs,ok,errs,skipped,elapsed:Date.now()-start});
          }catch(e2){
            entry.status='error';entry.error='Retry failed: '+e2.message;entry.failedStep=done[done.length-1]||'?';entry.fieldsWritten=done.slice(0,-1).join(' | ');entry.durationMs=Date.now()-t0;errs++;
            emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:entry.failedStep,url:entry.url,ok,errs,skipped,elapsed:Date.now()-start});
            if(ERR_HANDLE==='stop'){addLog(entry);flush();await browser.close();process.exit(1);}
          }
        }else{
          entry.status=ERR_HANDLE==='skip'?'skip':'error';entry.error=e.message;entry.failedStep=done[done.length-1]||'?';entry.fieldsWritten=done.slice(0,-1).join(' | ');entry.durationMs=Date.now()-t0;
          if(entry.status==='skip')skipped++;else errs++;
          emit({type:'row-error',rowIndex:ri,totalRows,error:entry.error,failedStep:entry.failedStep,url:entry.url,ok,errs,skipped,elapsed:Date.now()-start});
          if(ERR_HANDLE==='stop'){addLog(entry);flush();await browser.close();process.exit(1);}
        }
      }
      addLog(entry);
      if(ri<totalRows){const delay=Math.floor(Math.random()*(ROW_DELAY_MAX-ROW_DELAY_MIN+1))+ROW_DELAY_MIN;await page.waitForTimeout(delay);}
    }
  }finally{
    flush();
    try{fs.unlinkSync(CHECKPOINT);}catch{}
    // Logout is handled by the locked pestpac-logout step at end of flow
    await browser.close();
  }
  emit({type:'complete',totalRows:ri,ok,errs,skipped,elapsed:Date.now()-start,logPath:LOG_PATH});
}

main().catch(e=>{emit({type:'fatal',error:e.message});process.exit(1);});
`;
}

// ── AUTO UPDATE ───────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((res, rej) => {
    (url.startsWith('https') ? https : http).get(url, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
    }).on('error', rej);
  });
}
function downloadFile(url, dest) {
  return new Promise((res, rej) => {
    const f = fs.createWriteStream(dest);
    (url.startsWith('https') ? https : http).get(url, r => {
      const tot = parseInt(r.headers['content-length'] || '0');
      let recv = 0;
      r.on('data', c => { f.write(c); recv += c.length; if (tot > 0 && mainWindow) mainWindow.webContents.send('update-progress', Math.round(recv/tot*100)); });
      r.on('end', () => { f.end(); res(); });
    }).on('error', rej);
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
  const tmp = path.join(os.tmpdir(), 'buu-update.exe');
  try {
    await downloadFile(downloadUrl, tmp);
    // Strip Zone.Identifier alternate data stream so SmartScreen doesn't block it
    try {
      const { execFileSync } = require('child_process');
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Remove-Item -Path '${tmp}:Zone.Identifier' -ErrorAction SilentlyContinue`
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
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open spreadsheet',
    filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile']
  });
  if (r.canceled) return null;
  const fp = r.filePaths[0];
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
