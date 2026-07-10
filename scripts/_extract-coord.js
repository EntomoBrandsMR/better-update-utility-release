// _extract-coord.js — Phase 2 E5: move COORD + all coord* functions (verbatim segments)
// into src/pool/coordinator.js as module.exports = wireCoordinator(ctx). mainWindow (and
// any other reassigned binding) is accessed live via ctx.<name>; stable bindings are
// destructured once at wire time. main.js wires at EOF and destructures the full surface.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const p = path.join(root, 'src', 'main.js');
const src = fs.readFileSync(p, 'utf8');
const lines = src.split(/\r?\n/);

const declRe = /^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/;
const topRe = /^(?:async\s+)?(?:function|const|let|var)\s|^ipcMain\.|^app\.|^process\./;
const decls = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(declRe);
  if (m) decls.push({ name: m[1] || m[2], line: i + 1 });
}
function segEnd(startLine) {
  for (let i = startLine; i < lines.length; i++) if (topRe.test(lines[i])) return i;
  return lines.length;
}
const coordDecls = decls.filter(d => d.name === 'COORD' || d.name.startsWith('coord'));
const segs = coordDecls.map(d => {
  let cs = d.line - 1;
  while (cs > 0 && /^\s*\/\//.test(lines[cs - 1])) cs--;
  return { start: cs, end: segEnd(d.line) };
}).sort((a, b) => a.start - b.start);
const merged = [];
for (const s of segs) {
  const last = merged[merged.length - 1];
  if (last && s.start <= last.end + 1) last.end = Math.max(last.end, s.end);
  else merged.push({ ...s });
}

const inSeg = new Array(lines.length).fill(false);
for (const m of merged) for (let i = m.start; i < m.end; i++) inSeg[i] = true;
let block = lines.filter((_, i) => inSeg[i]).join('\n');
const rest = lines.filter((_, i) => !inSeg[i]).join('\n');

// Guard: nothing outside the segments executes COORD at top level during load.
if (/^COORD\b/m.test(rest)) throw new Error('top-level COORD use outside segments');

// ctx = outside top-level decls referenced by block. Electron/builtins are re-required
// inside the module instead of injected.
const SELF_REQUIRED = ['path', 'fs', 'os', 'https', 'http', 'crypto'];
const outside = decls.filter(d => !inSeg[d.line - 1]).map(d => d.name);
const ctxNames = [];
for (const n of new Set(outside)) {
  if (SELF_REQUIRED.includes(n)) continue;
  if (new RegExp('\\b' + n + '\\b').test(block)) ctxNames.push(n);
}
// Reassigned bindings (declared let/var OR assigned at top level in rest) go live via ctx.
const liveNames = [];
for (const n of ctxNames) {
  const letDecl = new RegExp('^(?:let|var)\\s+' + n + '\\b', 'm').test(rest);
  const reassigned = new RegExp('^' + n + '\\s*=[^=]', 'm').test(rest) ||
                     new RegExp('^\\s\\s?' + n + '\\s*=[^=]', 'm').test(rest);
  if (letDecl || reassigned) liveNames.push(n);
}
if (!liveNames.includes('mainWindow') && ctxNames.includes('mainWindow')) liveNames.push('mainWindow');
const stableNames = ctxNames.filter(n => !liveNames.includes(n));
console.log('ctx stable: ' + stableNames.join(', '));
console.log('ctx live:   ' + liveNames.join(', '));

// Sanity: live names must not appear inside string literals in the block (rewrite risk).
for (const n of liveNames) {
  const inStr = new RegExp("['\"][^'\"\\n]*\\b" + n + "\\b[^'\"\\n]*['\"]").test(block);
  if (inStr) throw new Error('live name appears inside a string literal in block: ' + n);
}
for (const n of liveNames) block = block.replace(new RegExp('\\b' + n + '\\b', 'g'), 'ctx.' + n);

const allCoord = coordDecls.map(d => d.name);
const modText = [
  '// pool/coordinator.js — pool coordinator: queue, worker lifecycle, scaling, sweeps,',
  '// journal writers (journal fns move to src/journal.js in E6). Moved VERBATIM from',
  '// main.js — Phase 2 refactor, 2026-07-10. Wired by main.js at load via wireCoordinator(ctx):',
  '// stable bindings destructured once; reassigned bindings (e.g. mainWindow) read live as ctx.<n>.',
  "const path = require('path');",
  "const fs = require('fs');",
  "const os = require('os');",
  "const https = require('https');",
  "const { app } = require('electron');",
  "const { spawn } = require('child_process');",
  '',
  'module.exports = function wireCoordinator(ctx) {',
  'const { ' + stableNames.join(', ') + ' } = ctx;',
  '',
  block,
  '',
  'return { ' + allCoord.join(', ') + ' };',
  '};',
  ''
].join('\n');
fs.writeFileSync(path.join(root, 'src', 'pool', 'coordinator.js'), modText, 'utf8');

// Rewrite main.js: drop segments (leave a pointer at the first), append wiring at EOF.
const keep = [];
let pointerPlaced = false;
for (let i = 0; i < lines.length; i++) {
  if (inSeg[i]) {
    if (!pointerPlaced) { keep.push('// Phase 2: coordinator (COORD + coord*) lives in src/pool/coordinator.js; wired at EOF.'); pointerPlaced = true; }
    continue;
  }
  keep.push(lines[i]);
}
const wiring = [
  '',
  '// ── Phase 2 wiring: coordinator module (see src/pool/coordinator.js) ──',
  'const __coordCtx = {',
  ...stableNames.map(n => '  ' + n + ','),
  ...liveNames.map(n => '  get ' + n + '() { return ' + n + '; },'),
  '};',
  "const { " + allCoord.join(', ') + " } = require('./pool/coordinator')(__coordCtx);",
  ''
].join('\n');
fs.writeFileSync(p, keep.join('\n') + '\n' + wiring, 'utf8');
console.log('E5 spliced: moved ' + merged.length + ' segments, ' + allCoord.length + ' coord symbols exported');
