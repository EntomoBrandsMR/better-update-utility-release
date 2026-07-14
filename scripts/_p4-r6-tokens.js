// _p4-r6-tokens.js — Phase 4 R6: system date tokens.
// {{TODAY}} = LIVE per resolution (crosses midnight mid-run); {{RUNDATE}} = frozen at
// POOL start (runContext.runStartTs — not worker spawn, which matters for elastic
// workers spawned hours in). Both accept ±N days ({{TODAY-1}}, {{RUNDATE+30}}).
// MM/DD/YYYY zero-padded, straight day arithmetic. System tokens WIN over same-named
// columns (save-time warning on collision). Green chips, always available (work in
// spreadsheet-free flows). Replaces the legacy frozen ISO {{TODAY}}.
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

// ── coordinator.js: pool-start timestamp into runContext ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('runStartTs')) {
  let nts = 0;
  c = c.replace(/today: new Date\(\)\.toISOString\(\)\.slice\(0,10\),/g, () => { nts++;
    return "runStartTs: parseInt(String(COORD.poolId||'').replace(/^pool/,''), 10) || Date.now() /* R6: {{RUNDATE}} base - pool start */,"; });
  if (nts < 1) throw new Error('runContext ts: no occurrences');
  console.log('runContext ts sites converted:', nts);
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator done');
} else console.log('coordinator already done');

// ── engine/steps.js: buuSystemToken + r() clause ──
const sp = path.join(root, 'src', 'engine', 'steps.js');
let s = fs.readFileSync(sp, 'utf8');
if (!s.includes('buuSystemToken')) {
  s = rep(s, 'async function runStep(page, step, row, creds){', [
    '// R6 system date tokens. {{TODAY}} is LIVE per resolution (crosses midnight mid-run);',
    '// {{RUNDATE}} is frozen at pool start (runContext.runStartTs). Both accept ±N days:',
    '// {{TODAY-1}}, {{RUNDATE+30}}. MM/DD/YYYY zero-padded, straight day arithmetic (the',
    '// local-date constructor normalizes month/DST rollover). System tokens WIN over',
    '// same-named columns; the save-time warning covers the collision. Returns null when',
    '// ref is not a system date token so column resolution proceeds.',
    'function buuSystemToken(ref, runContext){',
    "  const m = /^(TODAY|RUNDATE)([+-]\\d+)?$/.exec(String(ref||'').trim());",
    '  if(!m) return null;',
    '  let base;',
    "  if(m[1] === 'TODAY') base = new Date();",
    '  else {',
    '    const ts = runContext && runContext.runStartTs;',
    '    base = ts ? new Date(ts) : new Date();',
    '  }',
    '  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (m[2] ? parseInt(m[2], 10) : 0));',
    "  return String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0') + '/' + d.getFullYear();",
    '}',
    '',
    'async function runStep(page, step, row, creds){'
  ].join('\n'), 'token fn');
  s = rep(s, "if(ref==='TODAY')return RUN_CONTEXT.today||''; ",
    "const _sys=buuSystemToken(ref, typeof RUN_CONTEXT!=='undefined'?RUN_CONTEXT:null); if(_sys!==null)return _sys; ", 'r clause');
  s = rep(s, 'module.exports = { runStep };', 'module.exports = { runStep, buuSystemToken };', 'export');
  fs.writeFileSync(sp, s, 'utf8');
  console.log('steps done');
} else console.log('steps already done');

// ── worker.js: resolvePreview clause ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('buuSystemToken(ref, RUN_CONTEXT)')) {
  w = rep(w, "              if(ref === 'TODAY') return RUN_CONTEXT.today || '';",
    "              const _sys = buuSystemToken(ref, RUN_CONTEXT); if(_sys !== null) return _sys; // R6 (hoisted decl from the inlined steps source)", 'preview clause');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker done');
} else console.log('worker already done');

// ── index.html: column-check filter, save-time collision warning, green chips ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('sysChip')) {
  h = rep(h, "      if(BUILTINS.has(t)) continue;           // run-context tokens, not columns",
    "      if(BUILTINS.has(t)) continue;           // run-context tokens, not columns\n      if(/^(TODAY|RUNDATE)([+-]\\d+)?$/.test(t)) continue; // R6 system date tokens (±N forms too)", 'scan filter');
  h = rep(h, 'async function saveFlow(){', [
    'async function saveFlow(){',
    '  // R6: system tokens ({{TODAY}}/{{RUNDATE}}) WIN over same-named columns — warn loudly',
    '  // at save time when the loaded sheet has a column that will be shadowed.',
    '  try{',
    "    const _shadow = (ssHeaders||[]).filter(function(h2){ return /^(TODAY|RUNDATE)$/.test(String(h2).trim()); });",
    "    if(_shadow.length) alert('Heads up: the loaded sheet has column(s) named '+_shadow.join(', ')+'.\\n\\nThese are system date tokens and WIN over the column — rows will get the date, not the column value. Rename the column if you need its data.');",
    '  }catch(e){}'
  ].join('\n'), 'save warning');
  h = rep(h, '  const allTokens = cols.concat(readTokens);', [
    '  const allTokens = cols.concat(readTokens);',
    '  // R6: system date tokens — always available (no sheet needed; they work in',
    '  // spreadsheet-free flows). Green = system. ±N day math: {{TODAY-1}}, {{RUNDATE+30}}.',
    "  const sysChip = t => '<span class=\"chip\" draggable=\"true\" data-token=\"{{' + t + '}}\" title=\"System date token, MM/DD/YYYY. Supports ±N days: {{' + t + '-1}}, {{' + t + '+30}}. TODAY is live per row; RUNDATE is frozen at run start. Wins over a same-named column.\"><span class=\"tok\" style=\"color:var(--green)\">{{' + t + '}}</span></span>';",
    "  const sysChips = sysChip('TODAY') + sysChip('RUNDATE');"
  ].join('\n'), 'sysChip def');
  h = repRx(h, /(if\(!allTokens\.length\)\{\r?\n    return '<div style="margin-bottom:10px">' \+\r?\n      '<div style="font-size:10px[^\n]*\r?\n      )'<div class="chips" style="font-size:11px;color:var\(--t3\);font-style:italic;padding:4px 0">Load a spreadsheet to see column tokens you can drag\.<\/div>' \+/,
    "$1'<div class=\"chips\">' + sysChips + '<span style=\"font-size:11px;color:var(--t3);font-style:italic;padding:4px 6px\">Load a spreadsheet for column tokens.</span></div>' +", 'empty branch');
  h = rep(h, "'<div class=\"chips\">' + cols.map(c => chip(c, false)).join('') + readTokens.map(c => chip(c, true)).join('') + '</div>' +",
    "'<div class=\"chips\">' + sysChips + cols.map(c => chip(c, false)).join('') + readTokens.map(c => chip(c, true)).join('') + '</div>' +", 'main chips');
  h = rep(h, "(readTokens.length ? ' · purple = read from an earlier step' : '')",
    "' · green = system date' + (readTokens.length ? ' · purple = read from an earlier step' : '')", 'legend');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done');
} else console.log('index already done');
