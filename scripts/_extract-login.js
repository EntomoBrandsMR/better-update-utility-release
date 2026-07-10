// _extract-login.js — one-shot Phase 2 splice: replace the dual-copy login block in
// src/main.js with a file-read of src/engine/login.js + require alias.
'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'main.js');
let src = fs.readFileSync(p, 'utf8');

const marker = '// v2.2.2 — SHARED LOGIN HELPER (canonical, hardened, drift-proof)';
const mIdx = src.indexOf(marker);
if (mIdx < 0) throw new Error('marker not found');
const start = src.lastIndexOf('// ═', mIdx) >= 0 ? src.lastIndexOf('\n// ═', mIdx) + 1 : mIdx;
const endAnchor = "}`;";
const eIdx = src.indexOf(endAnchor, mIdx);
if (eIdx < 0) throw new Error('end anchor not found');
const end = eIdx + endAnchor.length;

const removed = src.slice(start, end);
if (!removed.includes('const LOGIN_TO_PESTPAC_SRC')) throw new Error('splice missed the const');
if (!removed.includes('async function loginToPestPacInPage')) throw new Error('splice missed the fn');

const replacement = [
  '// Phase 2 refactor: canonical login moved to src/engine/login.js (single source; the',
  '// v2.2.2 dual-copy + hand-sync rule is dead). File is read VERBATIM for template',
  "// interpolation and require()'d for main-process use; alias preserves call sites.",
  "const LOGIN_TO_PESTPAC_SRC = fs.readFileSync(path.join(__dirname, 'engine', 'login.js'), 'utf8');",
  "const { loginToPestPac: loginToPestPacInPage } = require('./engine/login');"
].join('\n');

src = src.slice(0, start) + replacement + src.slice(end);
fs.writeFileSync(p, src, 'utf8');
console.log('spliced: removed ' + removed.length + ' chars, inserted ' + replacement.length);
