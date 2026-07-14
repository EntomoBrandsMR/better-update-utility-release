// _p4-r12-errorstrip.js — Phase 4 R12: error strip on the run screen.
// Last 25 errors, newest first: row · step-context · [reason] · one-line error; click an
// entry for the full detail (error text, worker, time). Lives right under the worker
// grid; clears when a new pool goes active. Replaces the deleted Run Log tab. Data feed
// is R11a's pool-row-error (errors only — no per-row floods).
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

// ── coordinator: carry the step context ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('step: msg.phase')) {
  c = rep(c, "ctx.mainWindow.webContents.send('pool-row-error', { workerId: w.workerId, jobId: w.jobId, row: msg.row, error: msg.error || '', reason: msg.errorCategory || undefined });",
    "ctx.mainWindow.webContents.send('pool-row-error', { workerId: w.workerId, jobId: w.jobId, row: msg.row, error: msg.error || '', reason: msg.errorCategory || undefined, step: msg.phase || undefined });", 'step field');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator done');
} else console.log('coordinator already done');

// ── index.html ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('errStrip')) {
  // strip elements after the worker grid element line
  h = repRx(h, /(^.*id="workerGrid"[^\n]*\r?\n)/m, [
    '$1    <!-- R12: error strip — last N errors, newest first, click for detail. Replaces the',
    '         Run Log tab deleted in the Phase 2 teardown. Fed by pool-row-error (R11a). -->',
    '    <div id="errStripHd" style="display:none;font-size:11px;font-weight:600;color:var(--red);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.06em">Recent errors</div>',
    '    <div id="errStrip" style="display:none;flex-direction:column;gap:4px"></div>',
    ''
  ].join('\n'), 'strip html');
  // subscriber push + machinery
  h = rep(h, "if(API.onPoolRowError) API.onPoolRowError(function(d){", [
    '// R12: error-strip ring buffer (newest first, cap 25).',
    'let _errStrip = [];',
    'let _errStripActive = false;',
    'function renderErrorStrip(){',
    "  const hd=document.getElementById('errStripHd'), el=document.getElementById('errStrip');",
    '  if(!hd||!el) return;',
    "  if(!_errStrip.length){ hd.style.display='none'; el.style.display='none'; el.innerHTML=''; return; }",
    "  hd.style.display=''; hd.textContent='Recent errors ('+_errStrip.length+(_errStrip.length>=25?', latest 25':'')+')';",
    "  el.style.display='flex';",
    '  el.innerHTML=_errStrip.map(function(e,i){',
    "    const one=(e.error||'').split('\\n')[0].slice(0,110);",
    "    return '<div class=\"card\" style=\"padding:6px 10px;border:1px solid var(--bdr2);border-radius:8px;background:var(--surf2);cursor:pointer\" onclick=\"toggleErrDetail('+i+')\">'",
    "      +'<div style=\"display:flex;gap:10px;font-size:11px;align-items:baseline\"><span style=\"font-weight:700;color:var(--red)\">row '+e.row+'</span>'",
    "      +(e.step?'<span style=\"color:var(--t3)\">'+esc(String(e.step)).slice(0,40)+'</span>':'')",
    "      +(e.reason?'<span style=\"color:var(--amber)\">['+esc(e.reason)+']</span>':'')",
    "      +'<span style=\"color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1\">'+esc(one)+'</span></div>'",
    "      +'<div id=\"errDetail-'+i+'\" style=\"display:none;font-size:11px;color:var(--t2);margin-top:5px;white-space:pre-wrap;font-family:monospace\">'+esc(e.error||'')+(e.workerId?'\\nworker: '+esc(String(e.workerId)):'')+(e.ts?'\\nat: '+e.ts:'')+'</div></div>';",
    "  }).join('');",
    '}',
    "function toggleErrDetail(i){ const d=document.getElementById('errDetail-'+i); if(d) d.style.display = d.style.display==='none'?'':'none'; }",
    '',
    'if(API.onPoolRowError) API.onPoolRowError(function(d){',
    "  _errStrip.unshift({ row:d.row, step:d.step, reason:d.reason, error:d.error, workerId:d.workerId, ts:new Date().toLocaleTimeString() });",
    '  if(_errStrip.length>25) _errStrip.length=25;',
    '  renderErrorStrip();'
  ].join('\n'), 'machinery');
  // clear on a fresh pool going active (transition tracked in renderCoordStatus)
  h = rep(h, "      if(st && !st.active && stepPaneSticky) forceHidePause(); // R5: pool died/ended", [
    "      if(st && !st.active && stepPaneSticky) forceHidePause(); // R5: pool died/ended",
    '      // R12: clear the error strip when a NEW pool goes active.',
    '      if(st && st.active && !_errStripActive){ _errStripActive=true; _errStrip=[]; renderErrorStrip(); }',
    '      if(st && !st.active) _errStripActive=false;'
  ].join('\n'), 'clear hook');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done');
} else console.log('index already done');
