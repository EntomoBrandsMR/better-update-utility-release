// _test-header-ws.js — offline proof for the v3.0.2 header-whitespace fix.
// Extracts the REAL loadAllRows out of pool/worker.js and the REAL resolver line out of
// engine/steps.js and runs them against a real xlsx/csv. Testing a reimplementation would
// prove nothing — that is exactly how the REAUTH_INTERVAL_MS hole passed every gate.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = path.join(__dirname, '..');
const XLSX = require(path.join(root, 'node_modules', 'xlsx'));
let fails = 0;
const ok = (c, n, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? '  :: ' + JSON.stringify(x) : '')); if (!c) fails++; };

// ── extract the real loadAllRows from worker.js ──
const w = fs.readFileSync(path.join(root, 'src', 'pool', 'worker.js'), 'utf8');
const k = w.indexOf('function loadAllRows(fp){');
let d = 0, j = w.indexOf('{', k);
for (; j < w.length; j++) { if (w[j] === '{') d++; else if (w[j] === '}') { d--; if (!d) break; } }
const src = w.slice(k, j + 1);
const loadAllRows = new Function('XLSX', 'fs', 'path', src + '; return loadAllRows;')(XLSX, fs, path);

const tmp = os.tmpdir();
function makeXlsx(headers, rows, name) {
  const aoa = [headers].concat(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const p = path.join(tmp, name);
  XLSX.writeFile(wb, p);
  return p;
}

// 1) dirty xlsx headers -> keys trimmed
const f1 = makeXlsx(['Account Number ', ' Zone', 'Clean'], [['12345', 'A1', 'x']], '_buu_ws_dirty.xlsx');
const r1 = loadAllRows(f1);
ok(Object.keys(r1[0]).includes('Account Number'), 'xlsx trailing-space header trimmed', Object.keys(r1[0]));
ok(Object.keys(r1[0]).includes('Zone'), 'xlsx leading-space header trimmed');
ok(r1[0]['Account Number'] === '12345', 'value survives the remap', r1[0]['Account Number']);
ok(r1[0]['Clean'] === 'x', 'clean header untouched');

// 2) clean xlsx -> untouched (and NOT remapped: same object identity path)
const f2 = makeXlsx(['Account Number', 'Zone'], [['999', 'B2']], '_buu_ws_clean.xlsx');
const r2 = loadAllRows(f2);
ok(r2[0]['Account Number'] === '999' && r2[0]['Zone'] === 'B2', 'clean sheet loads normally', r2[0]);

// 3) csv path (already trimmed pre-fix — must not regress)
const f3 = path.join(tmp, '_buu_ws.csv');
fs.writeFileSync(f3, 'Account Number , Zone\n12345,A1\n', 'utf8');
const r3 = loadAllRows(f3);
ok(Object.keys(r3[0]).includes('Account Number') && Object.keys(r3[0]).includes('Zone'), 'csv headers trimmed', Object.keys(r3[0]));

// 4) empty sheet doesn't explode
const f4 = makeXlsx(['A '], [], '_buu_ws_empty.xlsx');
ok(Array.isArray(loadAllRows(f4)), 'empty sheet returns array');

// ── extract the REAL resolver line from engine/steps.js ──
const s = fs.readFileSync(path.join(root, 'src', 'engine', 'steps.js'), 'utf8');
const rl = s.split(/\r?\n/).find(l => l.includes('const r=v=>{'));
ok(!!rl, 'found the live resolver line in steps.js');
const mk = new Function('creds', 'row', 'buuSystemToken', 'RUN_CONTEXT', rl + ' return r;');
const r = mk({ companyKey: 'CK', username: 'U', password: 'P' }, { 'Account Number': '12345' }, () => null, { runId: 'R1', profileUsername: 'PU' });
ok(r('{{Account Number}}') === '12345', 'plain token resolves', r('{{Account Number}}'));
ok(r('{{Account Number }}') === '12345', 'BACK-COMPAT: token written against the untrimmed header still resolves', r('{{Account Number }}'));
ok(r('{{ Account Number }}') === '12345', 'padded token resolves', r('{{ Account Number }}'));
ok(r('{{CRED:username}}') === 'U', 'credential token unaffected');
ok(r('{{Nope}}') === '', 'unknown token still blank');

for (const f of [f1, f2, f3, f4]) { try { fs.unlinkSync(f); } catch (e) {} }
console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS');
process.exit(fails ? 1 : 0);
