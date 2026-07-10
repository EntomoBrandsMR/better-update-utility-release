// _extract-worker.js — Phase 2 E4: convert buildPoolWorker's template literal into
// src/pool/worker.js (real JS file with /*__BUU_INLINE X__*/ and /*__BUU_CFG_n__*/null
// markers); buildPoolWorker becomes readFileSync + marker substitution.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const p = path.join(root, 'src', 'main.js');
let src = fs.readFileSync(p, 'utf8');

const INLINES = ['REQUIRE_FN_SRC', 'LOGIN_TO_PESTPAC_SRC', 'LOCATE_STACK_SRC', 'STEPS_SRC',
  'PROBE_NETWORK_FN_SRC', 'WAIT_FOR_NETWORK_FN_SRC', 'CLASSIFY_ERROR_FN_SRC', 'CLASSIFY_PHASE_FN_SRC'];

const fnIdx = src.indexOf('function buildPoolWorker(cfg){');
if (fnIdx < 0) throw new Error('buildPoolWorker not found');
const retIdx = src.indexOf('return `', fnIdx);
if (retIdx < 0) throw new Error('return template not found');
const preBody = src.slice(fnIdx, retIdx); // fn header + destructuring/prelude, verbatim

// Scan template capturing interpolation expressions.
let i = retIdx + 'return `'.length, text = '', depth = 0, cur = '', exprs = [];
while (i < src.length) {
  const c = src[i];
  if (depth === 0) {
    if (c === '\\') { text += c + (src[i + 1] || ''); i += 2; continue; }
    if (c === '`') break;
    if (c === '$' && src[i + 1] === '{') { depth = 1; i += 2; cur = ''; continue; }
    text += c; i++;
  } else {
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { text += '\u0000' + exprs.length + '\u0000'; exprs.push(cur); i++; continue; } }
    cur += c; i++;
  }
}
if (i >= src.length) throw new Error('template never closed');
const tplEnd = i; // index of closing backtick

// Locate end of buildPoolWorker: expect `; then the function's closing } at column 0.
const afterTpl = src.slice(tplEnd);
const closeMatch = afterTpl.match(/^`;\s*\r?\n\}/);
if (!closeMatch) throw new Error('unexpected buildPoolWorker tail: ' + JSON.stringify(afterTpl.slice(0, 30)));
const fnEnd = tplEnd + closeMatch[0].length;

// Build worker.js: unescape shell text, then swap expr tokens for markers.
let shell = text.replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');
const cfgExprs = [];
shell = shell.replace(/\u0000(\d+)\u0000/g, (_, n) => {
  const e = exprs[+n].trim();
  if (INLINES.includes(e)) return '\n/*__BUU_INLINE ' + e + '__*/\n';
  const idx = cfgExprs.length; cfgExprs.push(exprs[+n]);
  return '/*__BUU_CFG_' + idx + '__*/null';
});
const header = [
  '// pool/worker.js — pool worker child-process shell. NOT run in place: buildPoolWorker',
  '// (src/main.js) reads this file at spawn, splices engine sources at the __BUU_INLINE',
  '// markers, and replaces each /*__BUU_CFG_n__*/null with the run-config expression listed',
  '// (in order) in buildPoolWorker. The null defaults keep this file node --check valid.',
  '// Phase 2 refactor, 2026-07-10 — emitted text proven equivalent to the v2.2.9 template.',
  ''
].join('\n');
fs.writeFileSync(path.join(root, 'src', 'pool', 'worker.js'), header + shell, 'utf8');

// New buildPoolWorker: same prelude, then file read + marker substitution.
const asm = [
  '  const __inj = [',
  ...cfgExprs.map(e => '    (' + e.trim() + '),'),
  '  ];',
  "  let __src = fs.readFileSync(path.join(__dirname, 'pool', 'worker.js'), 'utf8');",
  "  __src = __src.replace(/\\/\\*__BUU_INLINE ([A-Z_]+)__\\*\\//g, function(_, n){",
  '    if (!(n in __POOL_INLINE_SRC)) throw new Error("unknown inline: " + n);',
  '    return __POOL_INLINE_SRC[n];',
  '  });',
  "  __src = __src.replace(/\\/\\*__BUU_CFG_(\\d+)__\\*\\/null/g, function(_, n){",
  '    if (+n >= __inj.length) throw new Error("cfg marker out of range: " + n);',
  '    return String(__inj[+n]);',
  '  });',
  '  return __src;',
  '}'
].join('\n');
src = src.slice(0, fnIdx) + preBody + asm + src.slice(fnEnd);

// Inline-source map, defined after all the referenced consts exist.
const mapDecl = '\nconst __POOL_INLINE_SRC = { REQUIRE_FN_SRC, LOGIN_TO_PESTPAC_SRC, LOCATE_STACK_SRC, STEPS_SRC, PROBE_NETWORK_FN_SRC, WAIT_FOR_NETWORK_FN_SRC, CLASSIFY_ERROR_FN_SRC, CLASSIFY_PHASE_FN_SRC };\n';
const mapAnchor = 'function buildPoolWorker(cfg){';
src = src.replace(mapAnchor, mapDecl + mapAnchor);
fs.writeFileSync(p, src, 'utf8');
console.log('E4 spliced. cfg exprs: ' + cfgExprs.length + ', shell bytes: ' + shell.length);
