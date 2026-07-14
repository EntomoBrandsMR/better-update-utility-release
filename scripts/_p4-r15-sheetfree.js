// _p4-r15-sheetfree.js — Phase 4 R15: spreadsheet-free flows.
// A once-flow (runMode 'once') runs directly: no sheet, no row loop — the pool carries
// ONE synthetic empty row so the entire runtime (journal, logout, stop, crash safety,
// scaling floor of 1) is reused unchanged; the journal's single row IS the summary log.
// TODAY/RUNDATE/system tokens work; COLUMN tokens are invalid and block the launch with
// a named list. THE POINT OF THE RELEASE together with R16 (schedule these).
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

// ── worker: synthetic single row ──
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes("'__none__'")) {
  w = rep(w, '  const ALL_ROWS = loadAllRows(SPREADSHEET);',
    "  // R15: spreadsheet-free once-flow — one synthetic empty row = one pass of the steps.\n  const ALL_ROWS = SPREADSHEET === '__none__' ? [{}] : loadAllRows(SPREADSHEET);", 'rows');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker done');
} else console.log('worker already done');

// ── coordinator: argv sentinel ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes("'__none__'")) {
  c = rep(c, 'spawn(process.execPath, [runnerPath, job.spreadsheetPath, credPath]',
    "spawn(process.execPath, [runnerPath, job.spreadsheetPath || '__none__', credPath]", 'argv');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator done');
} else console.log('coordinator already done');

// ── main: sheet-free job accepted ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('sheetFree')) {
  m = repRx(m, /  const total = countRowsSync\(spreadsheetPath\);\r?\n  if \(total <= 0\) return \{ ok: false, error: 'Could not read rows from ' \+ spreadsheetPath \};/, [
    '  // R15: spreadsheet-free once-flow — one synthetic pass; the pool runtime is reused',
    '  // unchanged with totalRows 1 (its single journal row is the summary log).',
    '  const sheetFree = !spreadsheetPath;',
    '  const total = sheetFree ? 1 : countRowsSync(spreadsheetPath);',
    "  if (total <= 0) return { ok: false, error: 'Could not read rows from ' + spreadsheetPath };"
  ].join('\n'), 'submit total');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');

// ── index.html: launch guards, token block, payload, run-button gating ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('collectColumnTokensInFlow')) {
  h = rep(h, 'async function poolStageCurrent(){', [
    '// R15: raw column-token collector — every {{token}} the DATA steps reference that is',
    '// NOT a system/credential token. Used to block spreadsheet-free launches with a list.',
    'function collectColumnTokensInFlow(){',
    '  const refs = new Set();',
    '  const scan = function(v){',
    "    if(typeof v !== 'string') return;",
    "    const mm = v.match(/\\{\\{([^}]+)\\}\\}/g) || [];",
    '    for(const t0 of mm){',
    '      const t = t0.slice(2,-2).trim();',
    "      if(/^CRED\\./.test(t)) continue;",
    "      if(/^(TODAY|RUNDATE)([+-]\\d+)?$/.test(t)) continue;",
    "      if(t==='RUNID' || t==='PROFILE_USERNAME') continue;",
    '      refs.add(t);',
    '    }',
    '  };',
    '  for(const s of steps){',
    '    if(s.locked) continue;',
    '    scan(s.url); scan(s.value); scan(s.selector); scan(s.matchText); scan(s.containerSel);',
    '    scan(s.waitFor); scan(s.afterSelector); scan(s.waitSel); scan(s.condCol); scan(s.expected); scan(s.pathCol);',
    '  }',
    '  return Array.from(refs);',
    '}',
    '',
    'async function poolStageCurrent(){'
  ].join('\n'), 'collector');
  h = rep(h, "  if(!ssPath){ alert('Load a spreadsheet first.'); go('import'); return false; }", [
    '  // R15: spreadsheet-free flows. A once-flow runs its steps exactly one time — no',
    '  // sheet, no row loop, one summary journal line. Column tokens have no row to',
    '  // resolve from and BLOCK the launch by name; system tokens still work.',
    "  const _sheetFree = (runMode === 'once');",
    "  if(!_sheetFree && !ssPath){ alert('Load a spreadsheet first.'); go('import'); return false; }",
    '  if(_sheetFree){',
    '    const _bad = collectColumnTokensInFlow();',
    '    if(_bad.length){',
    "      alert('This is a spreadsheet-free (once) flow, but the steps reference column tokens:\\n\\n  '+_bad.join(', ')+'\\n\\nColumn tokens have no value without a sheet. Remove them or switch the flow type to per-row.');",
    "      go('builder'); return false;",
    '    }',
    '  }'
  ].join('\n'), 'stage guard');
  h = rep(h, '  const colCheck = checkFlowColumnsAgainstSheet();',
    '  const colCheck = _sheetFree ? null : checkFlowColumnsAgainstSheet();', 'colcheck skip');
  h = rep(h, "    label: (flowName||'flow')+' · '+ssName,",
    "    label: (flowName||'flow') + (_sheetFree ? ' \\u00b7 once' : ' \\u00b7 '+ssName),", 'label');
  h = rep(h, '    spreadsheetPath: ssPath,', '    spreadsheetPath: _sheetFree ? null : ssPath,', 'payload path');
  let _ng = 0;
  h = h.replace(/const canRun = \(!isRunning && steps\.length > 0 && activeProfileId && ssPath\);/g, () => { _ng++;
    return "const canRun = (!isRunning && steps.length > 0 && activeProfileId && (ssPath || runMode === 'once')); // R15: once-flows need no sheet"; });
  if (_ng !== 2) throw new Error('run gate: expected 2, got ' + _ng);
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done');
} else console.log('index already done');
