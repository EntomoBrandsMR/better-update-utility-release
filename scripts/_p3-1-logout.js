// _p3-1-logout.js — Phase 3 fix 1: NEW one-URL logout (spec locked + URL live-proven
// 2026-07-10) replaces the 4-step dance + 150s budget. Attempt surfacing to worker cards
// (amber >2 attempts, red = unverified logout) + end-of-run leak summary.
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
function cutFromTo(s, startNeedle, endNeedle, label) {
  const i = s.indexOf(startNeedle);
  if (i < 0) throw new Error('start missing: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  const k = s.indexOf(endNeedle, i);
  if (k < 0) throw new Error('end missing: ' + label);
  let le = s.indexOf('\n', k); if (le < 0) le = s.length; else le++;
  return { out: s.slice(0, ls) + s.slice(le), at: ls };
}

// ── engine/login.js: add logoutFromPestPac ──
const lp = path.join(root, 'src', 'engine', 'login.js');
let l = fs.readFileSync(lp, 'utf8');
if (!l.includes('logoutFromPestPac')) {
  const fn = [
    '// Phase 3 (spec locked + URL live-proven 2026-07-10): one-URL logout. Navigate to',
    '// Mode=Logout and verify we landed on the login page; loop inside a 5s budget. Returns',
    '// { ok, attempts, urls } — the caller emits one logout-attempt per URL touched.',
    'async function logoutFromPestPac(page){',
    '  const urls=[]; let ok=false; let attempts=0;',
    '  const deadline=Date.now()+5000;',
    '  while(!ok && Date.now()<deadline){',
    '    attempts++;',
    "    try{ await page.goto('https://app.pestpac.com/default.asp?Mode=Logout',{waitUntil:'domcontentloaded',timeout:4000}); }catch(e){}",
    "    try{ urls.push(page.url()); }catch(e){ urls.push('(url unavailable)'); }",
    '    try{',
    "      ok = /login\\.pestpac\\.com/i.test(page.url()) || !!(await page.$('input[name=\"uid\"]')) || !!(await page.$('input[name=\"username\"]'));",
    '    }catch(e){ ok=false; }',
    '    if(!ok){ try{ await page.waitForTimeout(300); }catch(e){} }',
    '  }',
    '  return { ok, attempts, urls };',
    '}',
    ''
  ].join('\n');
  l = rep(l, "if (typeof module !== 'undefined' && module.exports) { module.exports = { loginToPestPac }; }",
    fn + "if (typeof module !== 'undefined' && module.exports) { module.exports = { loginToPestPac, logoutFromPestPac }; }", 'exports');
  l = l.replace('// Phase 3 note: the new one-URL logout lands in this file when Phase 3 starts.\n', '');
  fs.writeFileSync(lp, l, 'utf8');
  console.log('login.js: logoutFromPestPac added');
} else console.log('login.js already done');

// ── worker.js: swap the dance for the new logout ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (w.includes('_logoutDeadline')) {
  const { out } = cutFromTo(w, '// v2.1.1: VERIFIED logout. A single click is not trusted',
    "emit({type:'logged-out', ok:_loggedOut, attempts:_attempt});", 'old dance');
  w = out;
  const nw = [
    '  // Phase 3 NEW LOGOUT — one URL (Mode=Logout), verify login page, 5s total budget,',
    '  // every URL touched is logged. Replaces the 4-step dance + 150s budget (KB item 34;',
    '  // the 28-stuck-sessions incident). Frankware has no Mode=Logout: single flow-step',
    '  // attempt with a 5s cap, then a URL probe.',
    '  let _loggedOut=false, _attempt=0;',
    "  if((creds.platform||'pestpac')==='frankware'){",
    '    try{',
    '      await Promise.race([',
    '        runStep(page, LOGOUT_STEP, {}, creds),',
    "        new Promise((_,rej)=>setTimeout(()=>rej(new Error('logout step timeout')), 5000)),",
    '      ]);',
    '    }catch(e){}',
    '    _attempt=1;',
    "    let _u=''; try{ _u=page.url(); }catch(e){}",
    '    _loggedOut = /\\/login/i.test(_u);',
    "    emit({type:'logout-attempt', attempt:1, ok:_loggedOut, url:_u});",
    '  } else {',
    '    const _r = await logoutFromPestPac(page);',
    '    _loggedOut=_r.ok; _attempt=_r.attempts;',
    '    for(let _i=0;_i<_r.urls.length;_i++){',
    "      emit({type:'logout-attempt', attempt:_i+1, ok:(_i===_r.urls.length-1)&&_r.ok, url:_r.urls[_i]});",
    '    }',
    '  }',
    "  emit({type:'logged-out', ok:_loggedOut, attempts:_attempt});"
  ].join('\n');
  w = repRx(w, /  emit\(\{type:'logging-out'\}\);\r?\n/, "  emit({type:'logging-out'});\n" + nw + '\n', 'insert new logout');
  if (/_logoutDeadline|_isLoggedOut/.test(w)) throw new Error('old dance leftovers');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker.js: new logout in');
} else console.log('worker already done');

// ── coordinator.js: attempt tracking + leak list ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('possibleLeaks')) {
  c = rep(c, "sweepRunning: false,", "sweepRunning: false,\n  possibleLeaks: [],   // Phase 3: workerIds that exited without VERIFIED logout (license may be held)", 'COORD field');
  c = repRx(c, /    case 'logged-out':\r?\n      w\.loggedOut = !!msg\.ok;\r?\n      break;/,
    [
      "    case 'logout-attempt':",
      '      w.logoutAttempts = msg.attempt;',
      '      break;',
      "    case 'logged-out':",
      '      w.loggedOut = !!msg.ok;',
      '      w.logoutAttempts = msg.attempts || w.logoutAttempts || 0;',
      '      if(!msg.ok && !COORD.possibleLeaks.includes(w.workerId)) COORD.possibleLeaks.push(w.workerId);',
      '      break;'
    ].join('\n'), 'logged-out case');
  c = rep(c, 'step: w.step, totalSteps: w.totalSteps, loggedOut: w.loggedOut,',
    'step: w.step, totalSteps: w.totalSteps, loggedOut: w.loggedOut, logoutAttempts: w.logoutAttempts||0,', 'status payload');
  c = repRx(c, /(if\(ctx\.mainWindow\) ctx\.mainWindow\.webContents\.send\('pool-complete', \{\r?\n)(      jobs:)/,
    '$1      possibleLeaks: COORD.possibleLeaks.slice(),\n$2', 'complete payload');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator.js done');
} else console.log('coordinator already done');

// ── main.js: reset the leak list at pool-start ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('COORD.possibleLeaks = [];')) {
  m = rep(m, 'COORD.startModeTarget = { workers: _cfgWorkers };',
    'COORD.startModeTarget = { workers: _cfgWorkers };\n  COORD.possibleLeaks = [];', 'reset leaks');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main.js done');
} else console.log('main already done');

// ── index.html: card badge + end-of-run leak summary ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('logoutBadge')) {
  h = rep(h, '    // Live detail line:',
    [
      '    // Phase 3: logout surfacing — red when a worker shut down without VERIFIED logout',
      '    // (session may still hold a PestPac license); amber when logout took >2 attempts.',
      "    let logoutBadge='';",
      "    if(w.status==='shut-down' && w.loggedOut===false) logoutBadge='<span style=\"font-size:9px;font-weight:700;color:var(--red)\" title=\"Logout never verified - this session may still hold a PestPac license\">LEAK?</span>';",
      "    else if((w.logoutAttempts||0)>2) logoutBadge='<span style=\"font-size:9px;font-weight:700;color:var(--amber)\" title=\"Logout took '+w.logoutAttempts+' attempts\">LOGOUT x'+w.logoutAttempts+'</span>';",
      '    // Live detail line:'
    ].join('\n'), 'badge calc');
  h = rep(h, "'+ph.label+'</div>'+stopBtn", "'+ph.label+'</div>'+logoutBadge+stopBtn", 'badge render');
  h = rep(h, "  document.getElementById('runStatusMsg').textContent='Pool complete';",
    [
      "  document.getElementById('runStatusMsg').textContent='Pool complete';",
      '  // Phase 3: end-of-run license-leak summary.',
      '  if(d && Array.isArray(d.possibleLeaks) && d.possibleLeaks.length){',
      "    addLiveLog('WARNING: '+d.possibleLeaks.length+' worker(s) exited without verified logout - possible PestPac license leak: '+d.possibleLeaks.map(function(x){return String(x).slice(-6);}).join(', ')+'. The logout sweep is the failsafe; check License Manager if it reports lingering sessions.','warn');",
      '  }'
    ].join('\n'), 'complete summary');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index.html done');
} else console.log('index already done');
