// engine/steps.js — pool worker step handlers (runStep). SINGLE SOURCE, interpolated
// VERBATIM into the pool worker child script via ${STEPS_SRC}.
// SCOPE CONTRACT — the host that inlines this file must define, before this point:
//   RUN_CONTEXT, PAGE_LOAD_MODE, NAV_TIMEOUT, SELECTOR_TIMEOUT (config globals),
//   resolveStepLocator/findLocator (engine/locate.js), loginToPestPac (engine/login.js),
//   fs (node builtin, used by fileupload).
// Extracted verbatim from buildPoolWorker template — Phase 2 refactor, 2026-07-10.
// ifclick + dialog handlers intentionally survive Phase 2; they die with R2/R3.
// R6 system date tokens. {{TODAY}} is LIVE per resolution (crosses midnight mid-run);
// {{RUNDATE}} is frozen at pool start (runContext.runStartTs). Both accept ±N days:
// {{TODAY-1}}, {{RUNDATE+30}}. MM/DD/YYYY zero-padded, straight day arithmetic (the
// local-date constructor normalizes month/DST rollover). System tokens WIN over
// same-named columns; the save-time warning covers the collision. Returns null when
// ref is not a system date token so column resolution proceeds.
function buuSystemToken(ref, runContext){
  const m = /^(TODAY|RUNDATE)([+-]\d+)?$/.exec(String(ref||'').trim());
  if(!m) return null;
  let base;
  if(m[1] === 'TODAY') base = new Date();
  else {
    const ts = runContext && runContext.runStartTs;
    base = ts ? new Date(ts) : new Date();
  }
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (m[2] ? parseInt(m[2], 10) : 0));
  return String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0') + '/' + d.getFullYear();
}

async function runStep(page, step, row, creds){

  // R3: per-step dialog checkboxes on action steps. Armed BEFORE the action so even a
  // dialog fired mid-action is handled; stays armed for the WHOLE step (chained dialogs);
  // harmless when no dialog fires; never blocks; always disarmed in the finally below.
  // Mutually exclusive accept/decline — accept wins if a hand-edited flow sets both.
  let _r3Handler = null;
  if ((step.dialogAccept || step.dialogDecline) && { click:1, type:1, select:1, checkbox:1, navigate:1 }[step.type]) {
    const _accept = !!step.dialogAccept;
    _r3Handler = async function(dialog){ try { if (_accept) await dialog.accept(); else await dialog.dismiss(); } catch (e) {} };
    page.on('dialog', _r3Handler);
  }
  try {
  const r=v=>{ if(!v)return''; return v.replace(/{{CRED:companyKey}}/g,creds.companyKey||'').replace(/{{CRED:username}}/g,creds.username||'').replace(/{{CRED:password}}/g,creds.password||'').replace(/{{([^}]+)}}/g,function(_,ref){ ref=String(ref).trim(); /* v3.0.2: header/token whitespace — trimmed headers and trimmed refs must agree, and this keeps flows written against an untrimmed header working */ const _sys=buuSystemToken(ref, typeof RUN_CONTEXT!=='undefined'?RUN_CONTEXT:null); if(_sys!==null)return _sys; if(ref==='RUNID')return RUN_CONTEXT.runId||''; if(ref==='PROFILE_USERNAME')return RUN_CONTEXT.profileUsername||''; return row[ref]!==undefined?String(row[ref]):''; }); };
  const ms=s=>Math.round(parseFloat(s||1)*1000);
  switch(step.type){
    case 'navigate':{const u=r(step.url); if(!u) throw new Error('Navigate URL empty'); await page.goto(u,{waitUntil:PAGE_LOAD_MODE,timeout:NAV_TIMEOUT}); break;}
    // R2 UNIFIED CLICK — three sections, all defaulted to pre-R2 behavior:
    //   When to act: 'appears' (default) | 'enabled'; waitTimeoutSec overrides the
    //     pool-wide SELECTOR_TIMEOUT for THIS step when set (kills the hardcoded 30s).
    //   If not found: 'error' (default) | 'skip' — skip probes within presenceSec
    //     (default 1s) and continues, recording the branch on the row (absorbs If-click).
    //   After click: 'none' (default) | 'element' | 'url' | 'load'. Legacy step.waitFor
    //     is honored as after='element', so pre-R2 Click steps run unchanged unmigrated.
    case 'ifclick': step = Object.assign({}, step, { type:'click', notFound:'skip' }); // legacy alias — falls through
    case 'click':{
      const waitMs = (step.waitTimeoutSec != null && step.waitTimeoutSec !== '' && isFinite(parseFloat(step.waitTimeoutSec)))
        ? Math.max(250, Math.round(parseFloat(step.waitTimeoutSec)*1000)) : SELECTOR_TIMEOUT;
      const notFound = step.notFound === 'skip' ? 'skip' : 'error';
      let loc = null;
      if(notFound === 'skip'){
        const presenceMs = Math.max(250, Math.round(parseFloat(step.presenceSec||1)*1000));
        try{ loc = await findLocator(page, step.selector, {timeout: presenceMs}); }catch(e){ loc = null; }
        if(loc){ try{ await loc.first().waitFor({state:'visible', timeout: Math.max(1000, presenceMs)}); }catch(e){ loc = null; } }
        if(!loc){ row.__stepNote = 'not present'; break; }
        row.__stepNote = 'clicked';
      } else {
        loc = await resolveStepLocator(page, step, r, waitMs);
        await loc.first().waitFor({state:'visible', timeout: waitMs});
      }
      if(step.whenMode === 'enabled'){
        const _end = Date.now() + waitMs;
        while(true){
          let _en = false; try{ _en = await loc.first().isEnabled(); }catch(e){}
          if(_en) break;
          if(Date.now() >= _end) throw new Error('element never became enabled within '+waitMs+'ms');
          await page.waitForTimeout(150);
        }
      }
      await loc.first().click();
      const after = step.after || (step.waitFor ? 'element' : 'none');
      // 3.0.4 (item 4): past this point the CLICK ITSELF SUCCEEDED — a timeout in the
      // after-check below is a VALIDATION failure, not an action failure. Mark it
      // (err.__afterCheck) so retry logic can refuse to blindly re-run the row:
      // re-clicking a Save multiplies side effects (07-17: a false-negative after:'url'
      // on Save Note wrote 3 duplicate notes per run, one per retry).
      try{
        if(after === 'element'){
          const _sel = step.afterSelector || step.waitFor;
          if(_sel){ const wl = await findLocator(page, _sel, {timeout: waitMs}); await wl.first().waitFor({state:'visible', timeout: waitMs}); }
        } else if(after === 'url'){
          const _u0 = page.url();
          await page.waitForURL(u => u.toString() !== _u0, {timeout: waitMs});
        } else if(after === 'load'){
          await page.waitForLoadState('load', {timeout: waitMs});
        }
      }catch(afterErr){
        const _em = String((afterErr && afterErr.message) || afterErr);
        if(/timeout|timed out/i.test(_em)){
          const e2 = new Error('After-'+after+' check timed out (the click action itself SUCCEEDED): '+_em);
          e2.__afterCheck = true;
          throw e2;
        }
        throw afterErr;
      }
      break;
    }
    case 'type':{ const loc=await resolveStepLocator(page,step,r); await loc.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); if(step.clearFirst!=='no') await loc.first().fill(''); const val=r(step.value); const delay=parseInt(step.typeDelay||0); if(delay>0) await loc.first().pressSequentially(val,{delay:delay}); else await loc.first().fill(val); if(step.pressAfter && ['Tab','Enter','Escape','ArrowDown','ArrowUp','Space'].indexOf(step.pressAfter)>=0){ await loc.first().press(step.pressAfter==='Space'?' ':step.pressAfter); } /* R7 */ break; }
    case 'select':{ const loc=await resolveStepLocator(page,step,r); await loc.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); await loc.first().selectOption({label:r(step.value)}); break; }
    case 'checkbox':{ const loc=await resolveStepLocator(page,step,r); await loc.first().waitFor({state:'visible',timeout:SELECTOR_TIMEOUT}); if(step.checkAction==='check')await loc.first().check(); else if(step.checkAction==='uncheck')await loc.first().uncheck(); else if(step.checkAction==='toggle')await loc.first().click(); else if(step.checkAction==='conditional'){ const tv=(step.truthyVals||'yes,true,1,x').split(',').map(v=>v.trim().toLowerCase()); if(tv.includes(String(r(step.condCol)).trim().toLowerCase()))await loc.first().check(); else await loc.first().uncheck(); } break; }
    case 'wait':if(step.waitType==='random'){const mn=ms(step.waitMin||1),mx=ms(step.waitMax||3);await page.waitForTimeout(Math.floor(Math.random()*(mx-mn+1))+mn);}else if(step.waitType==='element'){const loc=await findLocator(page,step.waitSel||'',{timeout:30000});await loc.first().waitFor({state:'visible',timeout:30000});}else if(step.waitType==='navigation')await page.waitForNavigation({timeout:30000});else await page.waitForTimeout(ms(step.waitSec||1));break;
    case 'pestpac-login':{ await loginToPestPac(page,creds); break; }
    case 'pestpac-logout':{ await page.goto('https://app.pestpac.com/search/default.asp',{waitUntil:'load',timeout:15000}); await page.waitForSelector('div.select',{timeout:10000}); await page.click('div.select'); await page.waitForSelector('a.logout',{timeout:5000}); await page.click('a.logout'); await page.waitForTimeout(1500); break; }
    case 'fileupload':{
      // Resolve the file path for this row (column path, or fixed folder + filename column).
      let filePath='';
      if(step.pathSource==='fixed'){ const base=(step.baseFolder||'').replace(/[\\/]+$/,''); const fn=r(step.fileNameColumn||''); filePath = fn ? (base + '\\' + fn) : ''; }
      else { filePath = r(step.pathColumn||''); }
      if(!filePath){ throw new Error('File upload: no file path resolved for this row'); }
      if(!fs.existsSync(filePath)){ throw new Error('File upload: file not found: '+filePath); }
      const loc=await resolveStepLocator(page,step,r); await loc.first().setInputFiles(filePath); break;
    }
    case 'readfield':{
      // v2.2.0: read a field's current value/label and store it under step.colName so (a) later
      // steps can use {{colName}} via the row resolver and (b) the coordinator can write it to the
      // dedicated results workbook. value+label for <select>; text for inputs/spans.
      const colName=(step.colName||'').trim(); if(!colName) break;
      const mode=step.readMode||'both';
      let value=null, label=null, found=false;
      const sel=step.selector||'';
      for(const f of page.frames()){
        try{
          const handle=await f.$(sel); if(!handle) continue;
          const info=await f.evaluate(el=>{
            const tag=(el.tagName||'').toLowerCase();
            if(tag==='select'){ const o=el.options&&el.selectedIndex>=0?el.options[el.selectedIndex]:null; return {value:el.value, label:o?(o.textContent||'').trim():''}; }
            if(tag==='input'||tag==='textarea'){ return {value:el.value, label:el.value}; }
            const t=(el.textContent||'').trim(); return {value:t, label:t};
          }, handle);
          value=info.value; label=info.label; found=true; break;
        }catch(e){ /* not in this frame */ }
      }
      if(!found){ if(step.readOnMissing==='error') throw new Error('Read field: selector not found: '+sel); value=''; label=''; }
      const out = mode==='value' ? (value||'') : (mode==='text' ? (label||'') : (label||value||''));
      // Store for later-step token use and for reporting.
      row[colName]=out;
      row[colName+'__raw']=(value||'');
      row[colName+'__label']=(label||'');
      if(!row.__reads) row.__reads={};
      row.__reads[colName]={ value:(value||''), label:(label||''), out:out };
      break;
    }
    case 'fw-scrape-orders':{
      // Frankware-only: scrape the full paginated Orders table for ONE account and stash one
      // record per order in row.__scrape (the coordinator appends them to the run CSV, deduped).
      // Frankware's "entries" count and Next button are unreliable, so termination is the EMPTY
      // PAGE. Balance is rendered NEGATIVE when owed; we keep the sign and parse to a number.
      const url=r(step.url); if(!url) throw new Error('Frankware scrape: orders URL is empty');
      // Stamp values accept {{Token}} syntax (resolved through r(), exactly like the URL field)
      // OR a bare column name. The v2.2.7 bug read row['{{Old Acct #}}'] literally; now a token
      // is resolved via r() and a bare name falls back to a direct row[column] lookup.
      const stampVal = function(f){ if(!f) return ''; var t=String(f).trim(); if(t.indexOf('{{')>=0) return r(t); return (row[t]!==undefined ? String(row[t]) : ''); };
      const prop = stampVal(step.propCol);
      const loc  = stampVal(step.locCol);
      const inv  = stampVal(step.invCol);
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:NAV_TIMEOUT});
      const rowSel='#tab-orders .dataTables_scrollBody table.dataTable tbody tr';
      const num=s=>{ const t=(s==null?'':String(s)).replace(/[$,]/g,'').trim(); if(t===''||t==='-') return ''; const n=parseFloat(t); return isNaN(n)?'':n; };
      const settle=async()=>{ try{ await page.waitForFunction(()=>{ var p=document.querySelector('#tab-orders .dataTables_processing'); var b=document.getElementById('busy'); var ph=!p||getComputedStyle(p).visibility==='hidden'; var bh=!b||getComputedStyle(b).display==='none'; return ph&&bh; },null,{timeout:20000}); }catch(e){} };
      let hasAny=true;
      try{ await page.waitForSelector(rowSel,{timeout:20000}); }catch(e){ hasAny=false; }
      const orders=[]; const seen={}; let prevFirst=null; const MAX_PAGES=500;
      if(hasAny){
        for(let pg=0; pg<MAX_PAGES; pg++){
          await settle();
          const pageRows=await page.$$eval(rowSel, trs => trs.map(tr => {
            const td=tr.querySelectorAll('td');
            const cell=i => td[i] ? (td[i].textContent||'').trim() : '';
            return { orderId:cell(0), service:cell(1), status:cell(2), price:cell(4), balance:cell(5), writeOff: tr.classList.contains('write-off') ? 'Yes':'No' };
          }));
          if(!pageRows.length) break;                 // empty page = end of data
          const firstId=pageRows[0].orderId;
          if(prevFirst!==null && firstId===prevFirst) break;   // page did not advance
          prevFirst=firstId;
          let added=0;
          for(const pr of pageRows){
            if(pr.orderId && seen[pr.orderId]) continue;       // intra-account dupe guard
            if(pr.orderId) seen[pr.orderId]=1;
            added++;
            orders.push({ prop:prop, loc:loc, inv:inv, orderId:pr.orderId, service:pr.service, status:pr.status, price:num(pr.price), balance:num(pr.balance), writeOff:pr.writeOff });
          }
          if(!added) break;                           // whole page already seen
          const next=await page.$('#tab-orders .dataTables_paginate a.next.paginate_button');
          if(!next) break;
          try{ await next.click(); }catch(e){ break; }
          await page.waitForTimeout(300);
        }
      }
      row.__scrape=orders;
      break;
    }
    case 'fieldwork-cancel-scrape':{
      // Fieldwork-only (3.1.0): read the Service History tab, emit ONE record per CANCELLED
      // service (keyed off a.edit_cancellation_details — the only marker present on cancels).
      // Extraction JS is the spec's validated parser, run in-page. Records land in
      // row.__scrape with row.__scrapeKind so the coordinator writes Fieldwork columns.
      // ALWAYS emits at least the per-location log record (even zero cancellations) so the
      // operator can tell "scraped, none found" from "never scraped".
      const stampVal = function(f){ if(!f) return ''; var t=String(f).trim(); if(t.indexOf('{{')>=0) return r(t); return (row[t]!==undefined ? String(row[t]) : ''); };
      const acct = stampVal(step.acctCol);
      const loc  = stampVal(step.locCol);
      const url  = r(step.url); if(!url) throw new Error('Fieldwork scrape: history URL is empty');
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:NAV_TIMEOUT});
      // give the server-rendered history nodes a beat to be present (they load with the page).
      try{ await page.waitForSelector('a.edit_cancellation_details, .panel-heading, #email, #sign-in-password',{timeout:15000}); }catch(e){}
      const scan = await page.evaluate(() => {
        const onLogin = !!document.querySelector('#sign-in-password, #email') || /\/sign_in\b/i.test(location.pathname);
        // 3.1.1: KEY OFF THE LINK, not a wrapper. Fieldwork renders cancellations in
        // more than one container (div.service-history-group OR div.tab-content, ...),
        // so the old "scan inside div.service-history-group" missed every cancellation
        // outside that wrapper (54% of Matthew's real run). a.edit_cancellation_details
        // is present on EVERY cancellation regardless of container — find them all, then
        // derive service_type/frequency/row by DOM proximity from each link.
        const panelCount = document.querySelectorAll('.panel-heading').length; // service blocks present
        const links = [...document.querySelectorAll('a.edit_cancellation_details')];
        const out = [];
        for (const link of links) {
          const tr = link.closest('tr');
          const td = tr ? [...tr.querySelectorAll('td')].map(x => (x.textContent||'').trim().replace(/\s+/g,' ')) : [];
          const table = link.closest('table');
          let frequency = '';
          if (table) { const th = table.querySelector('thead th[colspan]'); if (th) frequency = (th.textContent||'').trim().replace(/\s+/g,' '); }
          // service_type = nearest .panel-heading preceding this service's table (walk up+left).
          let service_type = '';
          let node = table || link;
          while (node && !service_type) {
            let sib = node.previousElementSibling;
            while (sib) {
              if (sib.classList && sib.classList.contains('panel-heading')) { service_type = (sib.textContent||'').trim().replace(/\s+/g,' '); break; }
              const inner = sib.querySelector && sib.querySelector('.panel-heading');
              if (inner) { service_type = (inner.textContent||'').trim().replace(/\s+/g,' '); break; }
              sib = sib.previousElementSibling;
            }
            node = node.parentElement;
          }
          out.push({
            service_type: service_type,
            frequency:    frequency,
            status: td[0]||'', reason: td[1]||'', technician: td[2]||'',
            cancel_date: td[3]||'', cancelled_at: td[4]||'', amount: td[5]||'',
            data_id:          link.getAttribute('data-id')||'',
            data_reason:      link.getAttribute('data-reason')||'',
            data_cancel_date: link.getAttribute('data-cancel-date')||''
          });
        }
        // total_groups now = service blocks on the page (panel-headings), used only to
        // tell "scraped, none" from "empty page" in the log; cancellations = out.length.
        return { onLogin, total_groups: panelCount, cancelled: out };
      });
      // Session-expiry guard (spec §5): no history groups AND a login form => STOP the run,
      // do NOT count these locations as done. A distinctive error so the operator re-auths.
      if(scan.total_groups===0 && scan.onLogin){
        throw new Error('__FIELDWORK_SESSION_EXPIRED__: hit the Fieldwork login screen — session expired. Log back in and resume; the remaining locations were NOT scraped.');
      }
      let src=''; try{ src=page.url(); }catch(e){}
      const recs = scan.cancelled.map(c => Object.assign({
        __k:'fieldwork', account_number:acct, location_number:loc, source_url:src
      }, c));
      // per-location log record (always) — groups_found / cancellations_found / status.
      recs.push({ __k:'fieldwork-log', account_number:acct, location_number:loc,
        groups_found:scan.total_groups, cancellations_found:scan.cancelled.length,
        status:(scan.total_groups>0?'scraped':'scraped-empty'), source_url:src });
      row.__scrape=recs;
      row.__scrapeKind='fieldwork-cancellations';
      break;
    }
    // v2.2.2 Session 2B: textedit ported from buildRunner. Multi-mode in-place text manipulation
    // on the field at step.selector. Reads current value, transforms per editMode, writes back.
    // editModes: find-replace / exact-remove / partial-remove-word / partial-remove-piece /
    //            partial-replace-piece / remove-after / remove-before / trim /
    //            remove-extra-spaces / regex. Bug fix on port: the regex editMode previously
    //            referenced undefined "replace" — corrected to "replaceStr".
    case 'dialog':{ const matchText=step.dialogMatch||''; const dialogAction=step.dialogAction||'accept'; if(page._buuDialogListener){ try{page.off('dialog',page._buuDialogListener);}catch(_){} page._buuDialogListener=null; } const handler=async dialog=>{ try{page.off('dialog',handler);}catch(_){} if(page._buuDialogListener===handler)page._buuDialogListener=null; const msg=dialog.message(); const matches=!matchText||msg.toLowerCase().includes(matchText.toLowerCase()); try{ if(matches){ if(dialogAction==='dismiss')await dialog.dismiss(); else await dialog.accept(); } else { await dialog.dismiss(); } }catch(e){} }; page._buuDialogListener=handler; page.on('dialog',handler); break; }
  }
  } finally {
    if (_r3Handler) { try { page.off('dialog', _r3Handler); } catch (e) {} }
  }
}
if (typeof module !== "undefined" && module.exports) { module.exports = { runStep, buuSystemToken }; }
