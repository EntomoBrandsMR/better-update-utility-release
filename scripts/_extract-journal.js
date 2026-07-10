// _extract-journal.js — Phase 2 E6: move journal writer/reader fns out of
// pool/coordinator.js into src/journal.js (initJournal({app, COORD})).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const p = path.join(root, 'src', 'pool', 'coordinator.js');
const src = fs.readFileSync(p, 'utf8');
const lines = src.split(/\r?\n/);

const NAMES = ['coordJournalPath', 'coordJournalMetaPath', 'coordJournalDonePath',
  'coordOpenJournal', 'coordMarkPhaseProgress', 'coordJournalAppend',
  'coordJournalAppendDialog', 'coordCloseJournal', 'coordMarkJournalDone',
  'coordMostRecentJournalPoolId'];

const startRe = new RegExp('^(?:async\\s+)?function (' + NAMES.join('|') + ')\\b');
const topRe = /^(?:async\s+)?function\s|^const\s|^return \{|^};/;
const segs = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(startRe);
  if (!m) continue;
  let cs = i; while (cs > 0 && /^\s*\/\//.test(lines[cs - 1])) cs--;
  let e = lines.length;
  for (let j = i + 1; j < lines.length; j++) if (topRe.test(lines[j])) { e = j; break; }
  while (e - 1 > i && /^\s*\/\//.test(lines[e - 1])) e--; // next decl's doc comments stay behind
  segs.push({ name: m[1], start: cs, end: e });
}
const found = segs.map(s => s.name);
for (const n of NAMES) if (!found.includes(n)) throw new Error('not found: ' + n);

const inSeg = new Array(lines.length).fill(false);
for (const s of segs) for (let i = s.start; i < s.end; i++) inSeg[i] = true;
const block = lines.filter((_, i) => inSeg[i]).join('\n');
const codeOnly = block.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

// Guard: journal fns must not call non-journal coord fns (would create a cycle).
const coordCalls = (codeOnly.match(/\bcoord[A-Za-z]+\s*\(/g) || [])
  .map(s => s.replace(/\s*\($/, ''))
  .filter(n => !NAMES.includes(n));
if (coordCalls.length) throw new Error('journal block calls coordinator fns: ' + [...new Set(coordCalls)].join(', '));
// Guard: free identifier whitelist — coordinator ctx names must not leak in.
for (const bad of ['mainWindow', 'encStore', 'keytar', 'buildPoolWorker', 'loadRowsForJob',
  'readConfig', 'readAllProfiles', 'getBundledChromiumPath', 'licenseReaderLogout',
  'buildLogoutSweeper', 'buildOnceFlowRunner', 'resolveOnceFlowByName', 'SERVICE_NAME',
  'MAX_WORKERS_HARD_CEILING', 'getLogsDir', 'https', 'os', 'spawn', 'ctx.']) {
  const re = bad === 'ctx.' ? /\bctx\./ : new RegExp('\\b' + bad + '\\b');
  if (re.test(codeOnly)) throw new Error('journal block references ' + bad);
}

const modText = [
  '// journal.js — the ONE pool journal writer + reader precedence rules (R1 rework lands',
  '// here). Moved VERBATIM from pool/coordinator.js — Phase 2 refactor, 2026-07-10.',
  '// State stays on COORD (injected); fs/path/app are module-local.',
  "const path = require('path');",
  "const fs = require('fs');",
  "const { app } = require('electron');",
  '',
  'module.exports = function initJournal({ COORD }) {',
  '',
  block,
  '',
  'return { ' + NAMES.join(', ') + ' };',
  '};',
  ''
].join('\n');
fs.writeFileSync(path.join(root, 'src', 'journal.js'), modText, 'utf8');

// Rewrite coordinator.js: drop segments, add require after the COORD literal closes.
const keep = [];
let pointer = false;
for (let i = 0; i < lines.length; i++) {
  if (inSeg[i]) {
    if (!pointer) { keep.push('// Phase 2: journal writer/reader fns live in src/journal.js (wired below COORD).'); pointer = true; }
    continue;
  }
  keep.push(lines[i]);
}
let out = keep.join('\n');
// COORD literal: `const COORD = {` ... first line that is exactly `};`
const coordIdx = out.indexOf('const COORD = {');
if (coordIdx < 0) throw new Error('COORD literal not found');
const closeIdx = out.indexOf('\n};', coordIdx);
if (closeIdx < 0) throw new Error('COORD close not found');
const insertAt = closeIdx + 3;
const wire = "\nconst { " + NAMES.join(', ') + " } = require('../journal')({ COORD });\n";
out = out.slice(0, insertAt) + wire + out.slice(insertAt);
fs.writeFileSync(p, out, 'utf8');
console.log('E6 spliced: ' + NAMES.length + ' journal fns moved (' + block.length + ' chars)');
