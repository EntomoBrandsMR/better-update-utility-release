// _analyze-coord.js — E5 pre-flight (read-only): find coord segment boundaries, the
// module-level identifiers they reference (ctx to inject), and coord identifiers
// referenced by the REST of main.js (export surface).
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const lines = src.split(/\r?\n/);

// Top-level declaration spans: a decl starts at column 0 and ends before the next
// column-0 'const|let|var|function|async function|ipcMain.|app.|//' block.
const declRe = /^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/;
const decls = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(declRe);
  if (m) decls.push({ name: m[1] || m[2], line: i + 1 });
}
// Segment end = next top-level decl line (or ipcMain/app registration at col 0).
const topRe = /^(?:async\s+)?(?:function|const|let|var)\s|^ipcMain\.|^app\.|^process\./;
function segEnd(startLine) {
  for (let i = startLine; i < lines.length; i++) {
    if (topRe.test(lines[i])) return i; // 0-based line index of next top-level
  }
  return lines.length;
}
const coordDecls = decls.filter(d => d.name === 'COORD' || d.name.startsWith('coord'));
const segs = coordDecls.map(d => {
  const s = d.line - 1;
  // include contiguous preceding comment lines
  let cs = s; while (cs > 0 && /^\s*\/\//.test(lines[cs - 1])) cs--;
  return { name: d.name, start: cs, end: segEnd(d.line) };
});

// Merge adjacent/overlapping segments.
segs.sort((a, b) => a.start - b.start);
const merged = [];
for (const s of segs) {
  const last = merged[merged.length - 1];
  if (last && s.start <= last.end + 1) { last.end = Math.max(last.end, s.end); last.names.push(s.name); }
  else merged.push({ start: s.start, end: s.end, names: [s.name] });
}
const inSeg = new Array(lines.length).fill(false);
for (const m of merged) for (let i = m.start; i < m.end; i++) inSeg[i] = true;
const blockText = lines.filter((_, i) => inSeg[i]).join('\n');
const restText = lines.filter((_, i) => !inSeg[i]).join('\n');

// ctx candidates: every top-level decl name OUTSIDE the segments that the block references.
const outsideDecls = decls.filter(d => !inSeg[d.line - 1]).map(d => d.name);
const used = [];
for (const n of new Set(outsideDecls)) {
  if (new RegExp('\\b' + n + '\\b').test(blockText)) used.push(n);
}
// export surface: coord names referenced by the rest.
const exp = [];
for (const d of coordDecls) {
  if (new RegExp('\\b' + d.name + '\\b').test(restText)) exp.push(d.name);
}
console.log('SEGMENTS:');
for (const m of merged) console.log('  lines ' + (m.start + 1) + '-' + m.end + ' : ' + m.names.join(', '));
console.log('CTX (outside decls referenced by block):\n  ' + used.join(', '));
console.log('EXPORTS (coord names used by rest):\n  ' + exp.join(', '));
