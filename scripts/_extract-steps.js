// _extract-steps.js — Phase 2 E3: move the pool worker's runStep (step handlers) out of
// the buildPoolWorker template literal into src/engine/steps.js (real file, emitted text).
'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'main.js');
let src = fs.readFileSync(p, 'utf8');

const startTag = 'async function runStep(page, step, row, creds){';
const start = src.indexOf(startTag);
if (start < 0) throw new Error('runStep start not found');
const commentIdx = src.indexOf('// Run a once-flow', start);
if (commentIdx < 0) throw new Error('runStep end anchor not found');
const closeBrace = src.lastIndexOf('}', commentIdx);
if (closeBrace < 0 || closeBrace <= start) throw new Error('runStep closing brace not found');
const rawSegment = src.slice(start, closeBrace + 1);
const end = closeBrace + 1; // splice boundary (exclusive)

// Safety: the segment must contain NO live template interpolation.
if (/(^|[^\\])\$\{/.test(rawSegment)) throw new Error('live ${} found in runStep segment — abort');

// Unescape template-literal escapes to get the EMITTED child-source text
// (same transform the pool-worker validator applies).
const emitted = rawSegment.replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');

const header = [
  '// engine/steps.js — pool worker step handlers (runStep). SINGLE SOURCE, interpolated',
  '// VERBATIM into the pool worker child script via ${STEPS_SRC}.',
  '// SCOPE CONTRACT — the host that inlines this file must define, before this point:',
  '//   RUN_CONTEXT, PAGE_LOAD_MODE, NAV_TIMEOUT, SELECTOR_TIMEOUT (config globals),',
  '//   resolveStepLocator/findLocator (engine/locate.js), loginToPestPac (engine/login.js),',
  '//   fs (node builtin, used by fileupload).',
  '// Extracted verbatim from buildPoolWorker template — Phase 2 refactor, 2026-07-10.',
  '// ifclick + dialog handlers intentionally survive Phase 2; they die with R2/R3.',
  ''
].join('\n');
const footer = '\nif (typeof module !== "undefined" && module.exports) { module.exports = { runStep }; }\n';
fs.writeFileSync(path.join(__dirname, '..', 'src', 'engine', 'steps.js'), header + emitted + footer, 'utf8');

// Replace segment in the template with one interpolation.
src = src.slice(0, start)
  + '// Phase 2: step handlers (runStep) now live in src/engine/steps.js\n${STEPS_SRC}'
  + src.slice(end);

// Define STEPS_SRC beside the other engine reads.
const anchor = "const LOCATE_STACK_SRC = fs.readFileSync(path.join(__dirname, 'engine', 'locate.js'), 'utf8');";
if (!src.includes(anchor)) throw new Error('locate anchor not found');
src = src.replace(anchor, anchor +
  "\nconst STEPS_SRC = fs.readFileSync(path.join(__dirname, 'engine', 'steps.js'), 'utf8');");
fs.writeFileSync(p, src, 'utf8');
console.log('E3 spliced. raw=' + rawSegment.length + ' emitted=' + emitted.length);
