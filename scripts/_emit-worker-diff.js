// _emit-worker-diff.js — prove E1-E3 equivalence: emit the pool worker source from the
// pre-refactor main.js (git v2.2.9) and from the current tree, stub cfg interpolations
// identically, strip comment-only/blank lines + export guards, and diff.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const root = path.join(__dirname, '..');

function template(src) {
  const fnIdx = src.indexOf('function buildPoolWorker(cfg)');
  const retIdx = src.indexOf('return `', fnIdx);
  let i = retIdx + 'return `'.length, out = '', depth = 0, exprs = [];
  let cur = '';
  while (i < src.length) {
    const c = src[i];
    if (depth === 0) {
      if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
      if (c === '`') break;
      if (c === '$' && src[i + 1] === '{') { depth = 1; i += 2; cur = ''; continue; }
      out += c; i++;
    } else {
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { out += '\u0000' + exprs.length + '\u0000'; exprs.push(cur); i++; continue; } }
      cur += c; i++;
    }
  }
  return { text: out, exprs };
}

function constValue(src, name) { // parse `const NAME = \`...\`;` literal into its VALUE
  const d = src.indexOf('const ' + name + ' = `');
  if (d < 0) return null;
  const open = src.indexOf('`', d) + 1;
  const close = src.indexOf('`;', open);
  const raw = src.slice(open, close);
  return raw.replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');
}

function emit(src, fileReads) {
  if (src.indexOf('__POOL_INLINE_SRC') >= 0) {
    // New shape: shell file + marker assembly (Phase 2 E4+).
    let shell = fs.readFileSync(path.join(root, 'src', 'pool', 'worker.js'), 'utf8');
    shell = shell.replace(/\/\*__BUU_INLINE ([A-Z_]+)__\*\//g, (_, n) => {
      if (fileReads && fileReads[n] !== undefined) return fileReads[n];
      const v = constValue(src, n);
      if (v === null) throw new Error('inline source missing: ' + n);
      return v;
    });
    return shell.replace(/\/\*__BUU_CFG_\d+__\*\/null/g, '@@CFG@@');
  }
  const { text, exprs } = template(src);
  let out = text.replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');
  return out.replace(/\u0000(\d+)\u0000/g, (_, n) => {
    const e = exprs[+n].trim();
    if (/^[A-Z_]+(_SRC)$/.test(e)) {
      if (fileReads && fileReads[e] !== undefined) return fileReads[e];
      const v = constValue(src, e);
      if (v !== null) return v;
    }
    return '@@CFG@@'; // cfg-dependent interpolation, stubbed identically both sides
  });
}

function normalize(s) {
  return s.split(/\r?\n/)
    .map(l => l.replace(/\s+$/,''))
    .filter(l => l.trim() !== '' && !/^\s*\/\//.test(l) && !/^if \(typeof module/.test(l))
    .join('\n');
}

const oldSrc = execSync('git show v2.2.9:src/main.js', { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const newSrc = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const reads = {
  LOGIN_TO_PESTPAC_SRC: fs.readFileSync(path.join(root, 'src', 'engine', 'login.js'), 'utf8'),
  LOCATE_STACK_SRC: fs.readFileSync(path.join(root, 'src', 'engine', 'locate.js'), 'utf8'),
  STEPS_SRC: fs.readFileSync(path.join(root, 'src', 'engine', 'steps.js'), 'utf8'),
};
const a = normalize(emit(oldSrc, null));
const b = normalize(emit(newSrc, reads));
if (a === b) { console.log('EQUIVALENT: emitted worker matches pre-refactor (comments/blank/export-guards ignored)'); process.exit(0); }
const A = a.split('\n'), B = b.split('\n');
let i = 0, j = 0, shown = 0;
while ((i < A.length || j < B.length) && shown < 25) {
  if (A[i] === B[j]) { i++; j++; continue; }
  // naive resync: look ahead a few lines on each side
  let ra = -1, rb = -1;
  for (let k = 1; k <= 5; k++) { if (A[i + k] === B[j]) { ra = k; break; } }
  for (let k = 1; k <= 5; k++) { if (A[i] === B[j + k]) { rb = k; break; } }
  if (ra > 0 && (rb < 0 || ra <= rb)) { for (let k = 0; k < ra; k++) console.log('OLD> ' + A[i + k]); i += ra; shown += ra; continue; }
  if (rb > 0) { for (let k = 0; k < rb; k++) console.log('NEW> ' + B[j + k]); j += rb; shown += rb; continue; }
  console.log('OLD> ' + (A[i] ?? '(eof)')); console.log('NEW> ' + (B[j] ?? '(eof)'));
  i++; j++; shown += 2;
}
console.log('RESULT: DIFFERS'); process.exit(1);
