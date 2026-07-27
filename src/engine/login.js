// engine/login.js — canonical login + logout for every platform. SINGLE SOURCE, consumed two ways:
//   1. require()'d by the main process (license-cap checks, sweeper, etc.).
//   2. Interpolated VERBATIM (fs.readFileSync of this file) into spawned child runner
//      scripts via ${LOGIN_TO_PESTPAC_SRC} — the guarded exports at the bottom are
//      harmless in that context. This is the ONE place login/logout is implemented; every
//      caller (workers, license checker, setup/teardown, once-flows, sweeper, logout step)
//      calls loginToPestPac / logoutFrom / logoutFromPestPac from here. Do NOT add a second copy.
async function loginToPestPac(page, creds){
  await page.goto(creds.loginUrl||'https://login.pestpac.com/',{waitUntil:'load',timeout:30000});
  if((creds.platform||'pestpac')==='fieldwork'){
    // Fieldwork: single Rails-style login page, email + password, no company key.
    // Selectors confirmed by Matthew 2026-07-17: #email, #sign-in-password, submit
    // #sign-in-submit. Success = we leave the sign-in page.
    await page.waitForSelector('#email',{timeout:20000});
    await page.fill('#email',creds.username||'');
    await page.fill('#sign-in-password',creds.password||'');
    try{ await page.click('#sign-in-submit',{timeout:15000}); }
    catch(e){ await page.press('#sign-in-password','Enter'); }
    await page.waitForFunction(()=>!/\/(sign_in|login)\b/i.test(location.pathname),null,{timeout:30000});
    return;
  }
  if((creds.platform||'pestpac')==='frankware'){
    // Frankware: single Rails login page, no company key, submit via Enter.
    await page.waitForSelector('input[name="session[login]"]',{timeout:20000});
    await page.fill('input[name="session[login]"]',creds.username||'');
    await page.fill('input[name="session[password]"]',creds.password||'');
    await page.press('input[name="session[password]"]','Enter');
    await page.waitForFunction(()=>!location.pathname.includes('/login'),null,{timeout:30000});
    return;
  }
  await page.waitForSelector('input[name="uid"]',{timeout:15000});
  await page.fill('input[name="uid"]',creds.companyKey||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{timeout:15000}); }catch(e){ await page.click('button[data-testid="CompanyKeyForm-loginBtn"]',{force:true}); }
  await page.waitForSelector('input[name="username"]',{timeout:15000});
  await page.fill('input[name="username"]',creds.username||'');
  await page.fill('input[name="password"]',creds.password||'');
  try{ await page.waitForSelector('.MuiBackdrop-root',{state:'hidden',timeout:12000}); }catch(e){}
  try{ await page.click('button[data-testid="loginBtn"]',{timeout:15000}); }
  catch(e){ try{ await page.click('button[data-testid="loginBtn"]',{force:true,timeout:8000}); }
            catch(_){ try{ await page.click('button[data-testid="LoginForm-loginBtn"]',{force:true,timeout:8000}); }catch(__){} } }
  await page.waitForSelector('a[href*="AutoLogin"]',{timeout:30000});
}

// ── VERIFIED LOGOUT ──────────────────────────────────────────────────────────
// RULE (Matthew, 2026-07-27): any session that logs in consumes a PestPac license
// until THAT session is logged out on the server. browser.close() ends local Chromium,
// NOT the server session. So logout must be PROVEN, not assumed: after issuing logout we
// try to load an authenticated page; if the server bounces us to the login screen the
// seat is truly freed. We retry (incl. a masthead UI-click fallback) inside a bounded
// budget. These never throw — the caller still closes the browser — but they return
// { ok } so the caller can flag a session it could NOT confirm logged out (a real leak).

// PestPac proof-of-death: an authed navigation that lands on the login screen == dead.
async function _pestpacSessionDead(page){
  try{ await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'domcontentloaded',timeout:8000}); }catch(e){}
  try{
    if(/login\.pestpac\.com/i.test(page.url())) return true;
    if(await page.$('input[name="uid"]')) return true;
    if(await page.$('input[name="username"]')) return true;
  }catch(e){}
  return false;
}

// Canonical PestPac logout. Verified + retried. Returns { ok, attempts, urls }.
async function logoutFromPestPac(page){
  const urls=[]; let ok=false; let attempts=0;
  const MAX=3;
  while(!ok && attempts<MAX){
    attempts++;
    // 1) issue the one-URL logout.
    try{ await page.goto('https://app.pestpac.com/default.asp?Mode=Logout',{waitUntil:'domcontentloaded',timeout:6000}); }catch(e){}
    try{ urls.push(page.url()); }catch(e){ urls.push('(url unavailable)'); }
    // 2) from the 2nd attempt on, add the masthead user-menu logout link as a fallback.
    if(attempts>=2){
      try{ await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'domcontentloaded',timeout:8000}); }catch(e){}
      try{ await page.click('div.select',{timeout:3000}); }catch(e){}
      try{ await page.click('a.logout',{timeout:3000}); await page.waitForTimeout(800); }catch(e){}
    }
    // 3) PROOF OF DEATH — an authed nav must bounce us to the login screen.
    ok = await _pestpacSessionDead(page);
    if(!ok){ try{ await page.waitForTimeout(400); }catch(e){} }
  }
  return { ok, attempts, urls };
}

// Fieldwork logout — operator login (no shared seat pool), but still log out cleanly.
async function logoutFromFieldwork(page){
  const urls=[]; let ok=false; let attempts=0;
  while(!ok && attempts<3){
    attempts++;
    try{ await page.goto('https://app.fieldworkhq.com/log_out',{waitUntil:'domcontentloaded',timeout:6000}); }catch(e){}
    try{ urls.push(page.url()); }catch(e){ urls.push('(url unavailable)'); }
    try{ ok = /\/(sign_in|login)\b/i.test(page.url()) || !!(await page.$('#sign-in-password')) || !!(await page.$('#email')); }catch(e){ ok=false; }
    if(!ok){ try{ await page.waitForTimeout(400); }catch(e){} }
  }
  return { ok, attempts, urls };
}

// Frankware logout — operator login (no shared seat pool). Best-effort click of the
// sign-out control, verified by a return to the login page; browser close by the caller
// is the final guarantee. No hard-coded sign_out URL is invented (origin varies).
async function logoutFromFrankware(page){
  const urls=[]; let ok=false; let attempts=0;
  while(!ok && attempts<2){
    attempts++;
    try{ await page.click('a[href*="sign_out"], a[href*="logout"], [data-method="delete"][href*="sign_out"]',{timeout:3000}); await page.waitForTimeout(800); }catch(e){}
    try{ urls.push(page.url()); ok = /\/login\b/i.test(page.url()) || !!(await page.$('input[name="session[login]"]')); }catch(e){ ok=false; }
    if(!ok){ try{ await page.waitForTimeout(300); }catch(e){} }
  }
  return { ok, attempts, urls };
}

// Platform-aware dispatcher — the ONE entry point callers with creds should use.
async function logoutFrom(page, creds){
  const plat=(creds&&creds.platform)||'pestpac';
  if(plat==='fieldwork') return logoutFromFieldwork(page);
  if(plat==='frankware') return logoutFromFrankware(page);
  return logoutFromPestPac(page);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loginToPestPac, logoutFrom, logoutFromPestPac, logoutFromFieldwork, logoutFromFrankware };
}
