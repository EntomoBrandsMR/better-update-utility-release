// engine/login.js — canonical PestPac/Frankware login. SINGLE SOURCE, consumed two ways:
//   1. require()'d by the main process (license-cap checks etc.).
//   2. Interpolated VERBATIM (fs.readFileSync of this file) into spawned child runner
//      scripts via ${LOGIN_TO_PESTPAC_SRC} — the guarded exports at the bottom are
//      harmless in that context. This replaces the v2.2.2 dual-copy (native function +
//      hand-synced string literal) and removes the drift hazard entirely.
async function loginToPestPac(page, creds){
  await page.goto(creds.loginUrl||'https://login.pestpac.com/',{waitUntil:'load',timeout:30000});
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
// Phase 3 (spec locked + URL live-proven 2026-07-10): one-URL logout. Navigate to
// Mode=Logout and verify we landed on the login page; loop inside a 5s budget. Returns
// { ok, attempts, urls } — the caller emits one logout-attempt per URL touched.
async function logoutFromPestPac(page){
  const urls=[]; let ok=false; let attempts=0;
  const deadline=Date.now()+5000;
  while(!ok && Date.now()<deadline){
    attempts++;
    try{ await page.goto('https://app.pestpac.com/default.asp?Mode=Logout',{waitUntil:'domcontentloaded',timeout:4000}); }catch(e){}
    try{ urls.push(page.url()); }catch(e){ urls.push('(url unavailable)'); }
    try{
      ok = /login\.pestpac\.com/i.test(page.url()) || !!(await page.$('input[name="uid"]')) || !!(await page.$('input[name="username"]'));
    }catch(e){ ok=false; }
    if(!ok){ try{ await page.waitForTimeout(300); }catch(e){} }
  }
  return { ok, attempts, urls };
}
if (typeof module !== 'undefined' && module.exports) { module.exports = { loginToPestPac, logoutFromPestPac }; }
