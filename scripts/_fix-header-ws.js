// _fix-header-ws.js — v3.0.2: strip whitespace from sheet headers before they become
// tokens. Trims at EVERY read site AND trims the token ref at resolution, which makes the
// change a strict superset: nothing that resolves today stops resolving.
// (All multi-line anchors go through repRx with \r?\n — src is CRLF.)
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
  let n = 0;
  const out = s.replace(rx, function () { n++; return to; });
  if (n === 0) throw new Error('anchor missing: ' + label);
  if (n > 1) throw new Error('anchor not unique (' + n + '): ' + label);
  return out;
}

// ══ 1. main.js ══
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('function trimRowKeys')) {
  m = rep(m, 'function loadRowsForJob(spreadsheetPath){', [
    '// v3.0.2: HEADER WHITESPACE. A header entered as "Account Number " became the literal',
    '// row key "Account Number ", so the {{Account Number}} anyone would actually type',
    '// resolved to blank — silently, no error. Trim every key once at load.',
    '// Paired with a matching trim of the token ref at resolution (engine/steps.js + worker',
    '// resolvePreview), which makes the pair a STRICT SUPERSET: a flow built against the',
    '// untrimmed header ({{Account Number }}) still resolves after this change.',
    '// Clean sheets pay nothing — the remap only runs when a header is actually dirty.',
    'function trimRowKeys(rows){',
    '  if(!Array.isArray(rows) || !rows.length) return rows;',
    '  let dirty = false;',
    '  for(const k in rows[0]){ if(k !== String(k).trim()){ dirty = true; break; } }',
    '  if(!dirty) return rows;',
    '  return rows.map(function(r){ const o = {}; for(const k in r) o[String(k).trim()] = r[k]; return o; });',
    '}',
    'function loadRowsForJob(spreadsheetPath){'
  ].join('\n'), 'trimRowKeys + loadRowsForJob');

  m = repRx(m, /    const wb = XLSX\.readFile\(spreadsheetPath, \{ raw:false \}\);\r?\n    return XLSX\.utils\.sheet_to_json\(wb\.Sheets\[wb\.SheetNames\[0\]\], \{ defval:'' \}\);/,
    "    const wb = XLSX.readFile(spreadsheetPath, { raw:false });\r\n    return trimRowKeys(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' }));", 'loadRowsForJob csv');

  m = repRx(m, /  const wb = XLSX\.readFile\(spreadsheetPath\);\r?\n  return XLSX\.utils\.sheet_to_json\(wb\.Sheets\[wb\.SheetNames\[0\]\], \{ defval:'' \}\);/,
    "  const wb = XLSX.readFile(spreadsheetPath);\r\n  return trimRowKeys(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' }));", 'loadRowsForJob xlsx');

  m = rep(m, '    headers = (raw[0] || []).map(String).filter(Boolean);',
    '    // v3.0.2: trim BEFORE these headers become chips/tokens. The CSV branch above\r\n    // already trimmed; XLSX never did, so the two disagreed.\r\n    headers = (raw[0] || []).map(h => String(h).trim()).filter(Boolean);', 'open-spreadsheet headers');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main.js done');
} else console.log('main.js already done');

// ══ 2. worker.js ══
const wp = path.join(root, 'src', 'pool', 'worker.js');
let w = fs.readFileSync(wp, 'utf8');
if (!w.includes('v3.0.2: header whitespace')) {
  w = repRx(w, /  const wb=XLSX\.readFile\(fp\);\r?\n  return XLSX\.utils\.sheet_to_json\(wb\.Sheets\[wb\.SheetNames\[0\]\]\);/, [
    '  const wb=XLSX.readFile(fp);',
    '  const ws=wb.Sheets[wb.SheetNames[0]];',
    '  // v3.0.2: header whitespace — trim the row KEYS so {{Token}} matches a header that',
    '  // carries a stray space. The CSV branch above always trimmed; XLSX never did, which',
    '  // is why tokens went blank on sheets with "Account Number ". Read JUST the header row',
    '  // to decide, so a clean sheet never pays for the remap (these runs hit 25k+ rows).',
    '  let _dirty=false;',
    '  try{',
    "    const _rg=XLSX.utils.decode_range(ws['!ref']);",
    "    const _hdr=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',range:{s:{r:_rg.s.r,c:_rg.s.c},e:{r:_rg.s.r,c:_rg.e.c}}})[0]||[];",
    '    _dirty=_hdr.some(function(h){ return String(h)!==String(h).trim(); });',
    '  }catch(e){ _dirty=true; } // probe failed: remap rather than risk a silent blank',
    '  const _rows=XLSX.utils.sheet_to_json(ws);',
    '  if(!_dirty) return _rows;',
    '  return _rows.map(function(r){ const o={}; for(const k in r) o[String(k).trim()]=r[k]; return o; });'
  ].join('\r\n'), 'loadAllRows xlsx');

  w = repRx(w, /            \.replace\(\/\{\{\(\[\^\}\]\+\)\}\}\/g, function\(_, ref\)\{\r?\n              const _sys = buuSystemToken\(ref, RUN_CONTEXT\);/,
    '            .replace(/{{([^}]+)}}/g, function(_, ref){\r\n              ref = String(ref).trim(); // v3.0.2: {{ Foo }} and {{Foo}} are the same token\r\n              const _sys = buuSystemToken(ref, RUN_CONTEXT);', 'resolvePreview ref trim');
  fs.writeFileSync(wp, w, 'utf8');
  console.log('worker.js done');
} else console.log('worker.js already done');

// ══ 3. engine/steps.js: THE live row resolver ══
const sp = path.join(root, 'src', 'engine', 'steps.js');
let s2 = fs.readFileSync(sp, 'utf8');
if (!s2.includes('v3.0.2')) {
  s2 = rep(s2, ".replace(/{{([^}]+)}}/g,function(_,ref){ const _sys=buuSystemToken(ref,",
    ".replace(/{{([^}]+)}}/g,function(_,ref){ ref=String(ref).trim(); /* v3.0.2: header/token whitespace — trimmed headers and trimmed refs must agree, and this keeps flows written against an untrimmed header working */ const _sys=buuSystemToken(ref,", 'steps.js ref trim');
  fs.writeFileSync(sp, s2, 'utf8');
  console.log('steps.js done');
} else console.log('steps.js already done');

// ══ 4. index.html ══
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('after trimming spaces')) {
  h = rep(h, '  const have = new Set((ssHeaders||[]).map(h => String(h)));',
    '  // v3.0.2: refs are trimmed above, so the sheet side must be too — otherwise a header\r\n  // with a stray space reported "column missing" no matter what the user typed.\r\n  const have = new Set((ssHeaders||[]).map(h => String(h).trim()));', 'have set');
  h = rep(h, '  cols = [...ssHeaders];', [
    '  cols = [...ssHeaders];',
    '  // v3.0.2: trimming can collapse two columns onto one key ("Foo" and "Foo "). The',
    '  // second would silently overwrite the first — wrong data, no error, which is the',
    '  // failure mode we care most about. Say so at load, not at 3am in a journal.',
    '  {',
    '    const _seen = new Set(), _dupes = [];',
    '    for(const _h of ssHeaders){ if(_seen.has(_h)) _dupes.push(_h); else _seen.add(_h); }',
    "    if(_dupes.length) alert('Heads up: after trimming spaces, these column headers collide:\\n\\n  ' + [...new Set(_dupes)].join(', ') + '\\n\\nOnly ONE column of each name survives into the row data. Rename them in the sheet before running.');",
    '  }'
  ].join('\r\n'), 'collision warning');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index.html done');
} else console.log('index.html already done');
