// _p4-r16-renderer.js — R16 renderer: Schedules nav + panel + editor + subscribers.
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
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (h.includes('panel-schedules')) { console.log('already done'); process.exit(0); }

// 1) nav item
h = repRx(h, /(<span class="nb" id="nb-run"[^\n]*\r?\n  <\/div>)(\r?\n  <div class="sb-sep"><\/div>\r?\n  <!-- v2\.1\.0)/, [
  '$1',
  '  <div class="nav" id="nav-schedules" onclick="go(\'schedules\')">',
  '    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>',
  '    Schedules',
  '    <span class="nb" id="nb-schedules" style="display:none;background:var(--surf3);color:var(--t2)">0</span>',
  '  </div>$2'
].join('\n'), 'nav');

// 2) go() refresh hook
h = rep(h, "  document.getElementById('mainContent').scrollTop = 0;",
  "  if (id === 'schedules') { try { schRefreshOptions(); schRenderList(); } catch (e) {} } // R16\n  document.getElementById('mainContent').scrollTop = 0;", 'go hook');

// 3) panel before pasteModal
const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) =>
  '<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="checkbox" class="schDay" data-d="' + i + '"/>' + d + '</label>').join('');
h = repRx(h, /(<div class="modal-bg" id="pasteModal">)/, [
  '<!-- \u2550\u2550 SCHEDULES (R16) \u2550\u2550 -->',
  '<div class="panel" id="panel-schedules">',
  '  <div class="page-header">',
  '    <div class="page-title">Schedules</div>',
  '    <div class="page-sub">Run spreadsheet-free (once) flows at set times \u2014 "run this flow at this time"</div>',
  '  </div>',
  '  <div class="card" style="margin-bottom:14px">',
  '    <div style="font-size:12px;font-weight:700;color:var(--t2);margin-bottom:8px" id="schFormTitle">New schedule</div>',
  '    <div class="row">',
  '      <div class="fg"><label>Flow (once-flows only)</label><select id="schFlow"></select><div class="hint">Only spreadsheet-free flows are schedulable \u2014 per-row flows are not.</div></div>',
  '      <div class="fg"><label>Login profile</label><select id="schProfile"></select></div>',
  '    </div>',
  '    <div class="row">',
  '      <div class="fg"><label>Repeats</label><select id="schType" onchange="schTypeChanged()"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly (day N)</option><option value="once">Once (date + time)</option></select></div>',
  '      <div class="fg" id="schDateFg" style="display:none"><label>Date</label><input type="date" id="schDate"/></div>',
  '      <div class="fg"><label>Time</label><input type="time" id="schTime" value="09:00"/></div>',
  '      <div class="fg" id="schDomFg" style="display:none"><label>Day of month</label><input type="number" id="schDom" min="1" max="31" value="1"/><div class="hint">Months without that day are skipped (day 31 skips April).</div></div>',
  '    </div>',
  '    <div class="row" id="schDaysRow" style="display:none"><div class="fg"><label>Days of the week</label><div style="display:flex;gap:12px;flex-wrap:wrap;padding:4px 0">' + days + '</div></div></div>',
  '    <div class="row">',
  '      <div class="fg"><label>Timezone</label><select id="schTz"><option value="America/New_York" selected>America/New_York (ET)</option><option value="America/Chicago">America/Chicago (CT)</option><option value="America/Denver">America/Denver (MT)</option><option value="America/Phoenix">America/Phoenix (AZ)</option><option value="America/Los_Angeles">America/Los_Angeles (PT)</option><option value="UTC">UTC</option></select><div class="hint">Fire times come from THIS zone regardless of the machine clock \u2014 VM-safe.</div></div>',
  '      <div class="fg"><label>Reserved block (minutes)</label><input type="number" id="schBlock" min="1" max="480" value="15"/><div class="hint">Saving refuses schedules whose blocks overlap another schedule within 14 days.</div></div>',
  '    </div>',
  '    <div class="btn-row"><button class="btn grn" onclick="schSave()">Save schedule</button><button class="btn" onclick="schResetForm()">Clear form</button></div>',
  '    <input type="hidden" id="schEditId"/>',
  '  </div>',
  '  <div style="font-size:12px;font-weight:700;color:var(--t2);margin-bottom:8px">Existing schedules</div>',
  '  <div id="schList" style="display:flex;flex-direction:column;gap:8px"><div class="empty">No schedules yet.</div></div>',
  '</div>',
  '',
  '$1'
].join('\n'), 'panel');
fs.writeFileSync(hp, h, 'utf8');
console.log('part 1 done');

// part 2: JS — editor logic, list render, fire pipe, missed popup
h = fs.readFileSync(hp, 'utf8');
if (h.includes('function schSave')) { console.log('part 2 already done'); process.exit(0); }
h = rep(h, '// R12: error-strip ring buffer (newest first, cap 25).', [
  '// \u2550\u2550 R16: SCHEDULES \u2550\u2550 "run this flow at this time" \u2014 the point of the release.',
  'let _schCache = [];',
  'function schTypeChanged(){',
  "  const t = (document.getElementById('schType')||{}).value || 'daily';",
  "  document.getElementById('schDateFg').style.display = t === 'once' ? '' : 'none';",
  "  document.getElementById('schDomFg').style.display = t === 'monthly' ? '' : 'none';",
  "  document.getElementById('schDaysRow').style.display = t === 'weekly' ? '' : 'none';",
  '}',
  'async function schRefreshOptions(){',
  '  // flows: once-flows only (the picker source already filters to flows\\\\once + strays)',
  "  const fsel = document.getElementById('schFlow');",
  '  if(fsel && API.listOnceFlows){',
  '    try{',
  '      const r = await API.listOnceFlows();',
  '      const cur = fsel.value;',
  "      fsel.innerHTML = '';",
  '      for(const f of ((r&&r.flows)||[])){',
  "        const nm = String(f.name || f.filename || '').replace(/\\.json$/i,'');",
  '        if(!nm) continue;',
  "        fsel.innerHTML += '<option value=\"'+esc(nm)+'\">'+esc(nm)+'</option>';",
  '      }',
  '      if(cur) fsel.value = cur;',
  '    }catch(e){}',
  '  }',
  "  const psel = document.getElementById('schProfile');",
  '  if(psel){',
  '    const cur = psel.value;',
  "    psel.innerHTML = '';",
  "    for(const p of (profiles||[])) psel.innerHTML += '<option value=\"'+esc(p.id)+'\">'+esc(p.name||p.id)+'</option>';",
  '    if(cur) psel.value = cur;',
  '  }',
  '}',
  'function schResetForm(){',
  "  document.getElementById('schEditId').value = '';",
  "  document.getElementById('schFormTitle').textContent = 'New schedule';",
  "  document.getElementById('schType').value = 'daily';",
  "  document.getElementById('schTime').value = '09:00';",
  "  document.getElementById('schBlock').value = '15';",
  "  document.getElementById('schTz').value = 'America/New_York';",
  "  document.querySelectorAll('.schDay').forEach(function(cb){ cb.checked = false; });",
  '  schTypeChanged();',
  '}',
  'async function schSave(){',
  '  const s = {',
  "    id: document.getElementById('schEditId').value || undefined,",
  "    flowName: (document.getElementById('schFlow')||{}).value || '',",
  "    profileId: (document.getElementById('schProfile')||{}).value || '',",
  "    type: (document.getElementById('schType')||{}).value || 'daily',",
  "    date: (document.getElementById('schDate')||{}).value || '',",
  "    time: (document.getElementById('schTime')||{}).value || '09:00',",
  "    dayOfMonth: parseInt((document.getElementById('schDom')||{}).value) || 1,",
  "    days: Array.from(document.querySelectorAll('.schDay')).filter(function(cb){return cb.checked;}).map(function(cb){return parseInt(cb.dataset.d);}),",
  "    tz: (document.getElementById('schTz')||{}).value || 'America/New_York',",
  "    blockMin: parseInt((document.getElementById('schBlock')||{}).value) || 15,",
  '    enabled: true,',
  '  };',
  "  if(s.type === 'weekly' && !s.days.length){ alert('Pick at least one weekday.'); return; }",
  "  if(s.type === 'once' && !s.date){ alert('Pick a date.'); return; }",
  '  const r = await API.scheduleSave(s);',
  "  if(!r || r.ok === false){ alert('Could not save schedule:\\n\\n' + ((r&&r.error)||'unknown')); return; }",
  '  schResetForm();',
  '  schRenderList();',
  '}',
  'function schEdit(id){',
  '  const s = _schCache.find(function(x){ return x.id === id; });',
  '  if(!s) return;',
  "  document.getElementById('schEditId').value = s.id;",
  "  document.getElementById('schFormTitle').textContent = 'Edit schedule';",
  "  document.getElementById('schFlow').value = s.flowName;",
  "  document.getElementById('schProfile').value = s.profileId;",
  "  document.getElementById('schType').value = s.type;",
  "  document.getElementById('schDate').value = s.date || '';",
  "  document.getElementById('schTime').value = s.time || '09:00';",
  "  document.getElementById('schDom').value = s.dayOfMonth || 1;",
  "  document.getElementById('schTz').value = s.tz || 'America/New_York';",
  "  document.getElementById('schBlock').value = s.blockMin || 15;",
  "  document.querySelectorAll('.schDay').forEach(function(cb){ cb.checked = (s.days||[]).indexOf(parseInt(cb.dataset.d)) >= 0; });",
  '  schTypeChanged();',
  '}',
  'async function schToggle(id, on){ if(API.scheduleToggle) await API.scheduleToggle({ id: id, enabled: on }); schRenderList(); }',
  "async function schDelete(id){ if(!confirm('Delete this schedule?')) return; await API.scheduleDelete({ id: id }); schRenderList(); }",
  'async function schRunNow(id){',
  '  const r = await API.scheduleRunNow({ id: id });',
  "  if(!r || r.ok === false){ alert('Could not run: ' + ((r&&r.error)||'unknown')); return; }",
  "  go('run');",
  '}',
  'async function schRenderList(){',
  "  const el = document.getElementById('schList');",
  '  if(!el || !API.schedulesList) return;',
  '  try{ _schCache = await API.schedulesList(); }catch(e){ return; }',
  "  const nb = document.getElementById('nb-schedules');",
  "  if(nb){ nb.style.display = _schCache.length ? '' : 'none'; nb.textContent = _schCache.length; }",
  "  if(!_schCache.length){ el.innerHTML = '<div class=\"empty\">No schedules yet.</div>'; return; }",
  '  el.innerHTML = _schCache.map(function(s){',
  "    const rep2 = s.type === 'once' ? ('once \\u00b7 ' + (s.date||'')) : s.type === 'weekly' ? ('weekly \\u00b7 ' + (s.days||[]).map(function(d){return ['Su','Mo','Tu','We','Th','Fr','Sa'][d];}).join('/')) : s.type === 'monthly' ? ('monthly \\u00b7 day ' + (s.dayOfMonth||1)) : 'daily';",
  "    const lr = s.lastResult ? (s.lastResult.status === 'ok' ? '<span style=\"color:var(--green)\">last: ok ('+(s.lastResult.ok||0)+')</span>' : '<span style=\"color:var(--'+(s.lastResult.status==='errors'?'amber':'red')+')\">last: '+esc(s.lastResult.status)+(s.lastResult.error?(' \\u2014 '+esc(String(s.lastResult.error).slice(0,60))):'')+'</span>') : '<span style=\"color:var(--t3)\">never run</span>';",
  "    return '<div class=\"card\" style=\"padding:10px 13px;display:flex;align-items:center;gap:12px;flex-wrap:wrap\">'",
  "      + '<label style=\"display:flex;align-items:center;gap:6px;cursor:pointer\"><input type=\"checkbox\" '+(s.enabled!==false?'checked':'')+' onchange=\"schToggle(\\''+s.id+'\\', this.checked)\" title=\"Enable/disable\"/></label>'",
  "      + '<div style=\"min-width:180px\"><div style=\"font-size:13px;font-weight:700;color:var(--t1)\">'+esc(s.flowName)+'</div><div style=\"font-size:11px;color:var(--t3)\">'+rep2+' \\u00b7 '+esc(s.time||'')+' '+esc(s.tz||'')+' \\u00b7 block '+(s.blockMin||15)+'m</div></div>'",
  "      + '<div style=\"font-size:11px;color:var(--t2);flex:1\">'+(s.enabled===false?'<span style=\"color:var(--t3)\">disabled</span>':(s.nextFireLocal?('next: '+esc(s.nextFireLocal)):'<span style=\"color:var(--t3)\">no upcoming fire</span>'))+'<br/>'+lr+'</div>'",
  "      + '<div style=\"display:flex;gap:6px\"><button class=\"btn sm\" onclick=\"schRunNow(\\''+s.id+'\\')\">Run now</button><button class=\"btn sm\" onclick=\"schEdit(\\''+s.id+'\\')\">Edit</button><button class=\"btn sm\" style=\"color:var(--red)\" onclick=\"schDelete(\\''+s.id+'\\')\">Delete</button></div>'",
  "      + '</div>';",
  "  }).join('');",
  '}',
  '',
  '// R16: launch pipe — main computed the full payload; the renderer is a dumb gateway',
  '// into the existing pool IPC (no renderer state involved, nothing clobbered).',
  'if(API.onScheduleFire) API.onScheduleFire(async function(d){',
  '  try{',
  '    const sub = await API.poolSubmitJob(d.job);',
  "    if(!sub || sub.ok === false){ API.scheduleResult({ id: d.scheduleId, ok: false, error: (sub&&sub.error)||'submit failed' }); return; }",
  '    const st = await API.poolStart(d.start);',
  "    if(!st || st.ok === false){ API.scheduleResult({ id: d.scheduleId, ok: false, error: (st&&st.error)||'start failed' }); return; }",
  "    addLiveLog('\\u23f0 Scheduled run started: '+(d.job.label||''),'info');",
  '    poolUIActive(true);',
  "    go('run');",
  '  }catch(e){ API.scheduleResult({ id: d.scheduleId, ok: false, error: e.message }); }',
  '});',
  'if(API.onSchedulesMissed) API.onSchedulesMissed(async function(list){',
  '  // R16: missed-while-closed \u2014 one popup per flow: Run now / Skip.',
  '  for(const ms of (list||[])){',
  "    const run = confirm('Missed schedule while BUU was closed:\\n\\n  '+ms.flowName+'\\n  was due '+ms.dueLocal+'\\n\\nOK = run it now \\u00b7 Cancel = skip this occurrence');",
  '    if(run){ await API.scheduleRunNow({ id: ms.id }); break; } // one run at a time; the rest re-offer via the tick',
  '    else await API.scheduleSkipMissed({ id: ms.id });',
  '  }',
  '  schRenderList();',
  '});',
  "if(API.onSchedulesChanged) API.onSchedulesChanged(function(){ try{ schRenderList(); }catch(e){} });",
  '',
  '// R12: error-strip ring buffer (newest first, cap 25).'
].join('\n'), 'js blob');
fs.writeFileSync(hp, h, 'utf8');
console.log('part 2 done');
