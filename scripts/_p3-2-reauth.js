// _p3-2-reauth.js — Phase 3 fix 2 (D7): reauth per Matthew's locked spec —
// (a) timer refresh = full logout THEN login at a row boundary;
// (b) failure recovery = on any row error, probe for the login screen (no navigation);
//     if logged out, re-login and retry the row ONCE. Kills the 3,557-row fail-through.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (w.includes('after session-recovery re-login')) { console.log('already done'); process.exit(0); }

// (a) timer refresh: logout then login
w = repRx(w, /      \/\/ v2\.2\.2 Session 2E: proactive re-auth at row boundary\.[\s\S]*?\r?\n      \}\r?\n/, [
  '      // Phase 3 (D7 spec): TIMER REFRESH = full logout THEN login at the row boundary.',
  "      // Purpose is beating PestPac's inactivity auto-logout with a genuinely fresh",
  '      // session — a refresh, not a probe. Failure recovery below is the safety net.',
  '      if (nextReauthAt > 0 && Date.now() >= nextReauthAt) {',
  "        emit({type:'log', message:'Session refresh (timer) before row '+rowNum+': logout then login'});",
  '        try {',
  "          if((creds.platform||'pestpac')!=='frankware'){ try{ await logoutFromPestPac(page); }catch(e){} }",
  '          await loginToPestPac(page, creds);',
  '          nextReauthAt = Date.now() + REAUTH_INTERVAL_MS;',
  "          emit({type:'log', message:'Session refresh complete. Continuing.'});",
  '        } catch (e) {',
  "          emit({type:'log', message:'Session refresh failed: '+e.message+' — continuing; failure recovery will catch a dead session.'});",
  '        }',
  '      }',
  ''
].join('\n'), 'timer block');

// (b) failure recovery: insert before the entry build
const recovery = [
  '      // Phase 3 FAILURE RECOVERY (D7): a dead session makes every row fail identically —',
  '      // per-row retries re-run steps against the login page and can never succeed (the',
  '      // 3,557-row fail-through). On any row error, probe for the login screen WITHOUT',
  '      // navigating (current URL + login-field presence). If logged out: re-login and',
  '      // retry this row ONCE.',
  "      if(res && res.status==='error'){",
  '        let _authDead=false;',
  '        try{',
  "          const _u=page.url();",
  "          if(/login\\.pestpac\\.com/i.test(_u)) _authDead=true;",
  "          else if((creds.platform||'pestpac')==='frankware' && /\\/login/i.test(_u)) _authDead=true;",
  "          else if(await page.$('input[name=\"uid\"]')) _authDead=true;",
  "          else if(await page.$('input[name=\"username\"]')) _authDead=true;",
  '        }catch(e){}',
  '        if(_authDead){',
  "          emit({type:'log', message:'Row '+rowNum+' failed on a dead session (login screen detected). Re-logging in and retrying the row once.'});",
  '          try{',
  '            await loginToPestPac(page, creds);',
  '            if (REAUTH_INTERVAL_MS > 0) nextReauthAt = Date.now() + REAUTH_INTERVAL_MS;',
  '            const _res2 = await processRow(page, row, creds, rowNum);',
  "            if(_res2){ if(_res2.status==='error') _res2.error = (_res2.error||'')+' (after session-recovery re-login)'; res = _res2; }",
  '          }catch(e){',
  "            if(e && e.message === '__STOP__'){",
  '              _draining = true;',
  "              emit({type:'row-result', row:rowNum, status:'stopped', error:'User stop during step-through', durationMs:Date.now()-t0});",
  '              _currentRowNum = null; _currentRow = null;',
  '              break;',
  '            }',
  "            emit({type:'log', message:'Session-recovery re-login failed: '+e.message+' — keeping the original row error.'});",
  '          }',
  '        }',
  '      }',
  ''
].join('\n');
w = repRx(w, /(      const entry=\{ row:rowNum,)/, recovery + '$1', 'recovery insert');
fs.writeFileSync(wp, w, 'utf8');
console.log('reauth done');
