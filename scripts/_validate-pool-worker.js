// Recreated 2026-07-04 (work machine) — original lives only on the bigma box (scripts/ is
// gitignored). Purpose: the pool worker executor lives inside a template literal returned by
// buildPoolWorker(), so `node --check src/main.js` passes even when the worker source itself
// is broken. This extracts the template, stubs every ${...} interpolation, and syntax-checks
// the resulting worker source.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const mainPath = path.join(__dirname, '..', 'src', 'main.js');
const src = fs.readFileSync(mainPath, 'utf8');

const fnIdx = src.indexOf('function buildPoolWorker(cfg)');
if (fnIdx < 0) { console.error('FAIL: buildPoolWorker not found'); process.exit(1); }
const retIdx = src.indexOf('return `', fnIdx);
if (retIdx < 0) { console.error('FAIL: return template not found'); process.exit(1); }

// Scan the template literal honoring escapes and nested ${ } braces.
let i = retIdx + 'return `'.length;
let out = '';
let depth = 0; // ${ } nesting depth; content inside is replaced with a stub
while (i < src.length) {
  const c = src[i];
  if (depth === 0) {
    if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
    if (c === '`') break; // end of template
    if (c === '$' && src[i + 1] === '{') { depth = 1; i += 2; out += '0'; continue; }
    out += c; i++;
  } else {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
}
if (i >= src.length) { console.error('FAIL: template literal never closed'); process.exit(1); }

// Unescape template-literal escapes so the worker source reads as it would at runtime.
const workerSrc = out.replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');

const tmp = path.join(require('os').tmpdir(), '_buu_pool_worker_check.js');
fs.writeFileSync(tmp, workerSrc, 'utf8');
const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
if (res.status !== 0) {
  console.error('FAIL: pool worker template has a syntax error:');
  console.error(res.stderr);
  process.exit(1);
}
console.log('OK: pool worker template parses cleanly (' + workerSrc.length + ' chars checked)');
