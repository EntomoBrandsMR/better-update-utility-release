// _extract-locate.js — Phase 2 E2: move the find-by-text/locator stack out of main.js
// string constants into src/engine/locate.js; pool worker interpolates the file verbatim.
'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'main.js');
let src = fs.readFileSync(p, 'utf8');

const names = ['FIND_LOCATOR_FN_SRC', 'MATCHES_TEXT_FN_SRC',
  'FIND_IN_CONTAINER_FN_SRC', 'RESOLVE_STEP_LOCATOR_FN_SRC'];
const bodies = {};
for (const n of names) {
  const declStart = src.indexOf('const ' + n + ' = `');
  if (declStart < 0) throw new Error('missing decl: ' + n);
  const open = src.indexOf('`', declStart) + 1;
  const close = src.indexOf('`;', open);
  if (close < 0) throw new Error('unterminated: ' + n);
  bodies[n] = src.slice(open, close);
  // remove the whole declaration incl. trailing `;` and one following newline
  let end = close + 2;
  if (src[end] === '\r') end++;
  if (src[end] === '\n') end++;
  src = src.slice(0, declStart) + src.slice(end);
}

// Build engine/locate.js from the captured bodies (dependency order).
const header = [
  '// engine/locate.js — selector resolution + find-by-text stack. SINGLE SOURCE,',
  '// interpolated VERBATIM into the pool worker child script (${LOCATE_STACK_SRC}).',
  '// NOTE: resolveStepLocator references SELECTOR_TIMEOUT, a global the worker',
  '// template defines before this file is inlined. The guarded exports below are',
  '// for tests/tooling; main process has no native callers today.',
  '// (Extracted verbatim from v2.2.2 FIND_LOCATOR/MATCHES_TEXT/FIND_IN_CONTAINER/',
  '//  RESOLVE_STEP_LOCATOR string constants — Phase 2 refactor, 2026-07-10.)',
  ''
].join('\n');
const footer = '\nif (typeof module !== "undefined" && module.exports) {' +
  ' module.exports = { findLocator, matchesText, findInContainer, resolveStepLocator }; }\n';
const locateSrc = header + names.map(n => bodies[n]).join('\n\n') + footer;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'engine', 'locate.js'), locateSrc, 'utf8');

// Replace the 4-line interpolation block in buildPoolWorker with one interpolation.
const blkStart = src.indexOf('${FIND_LOCATOR_FN_SRC}');
const blkEndTag = '${RESOLVE_STEP_LOCATOR_FN_SRC}';
const blkEnd = src.indexOf(blkEndTag);
if (blkStart < 0 || blkEnd < 0) throw new Error('interpolation block not found');
const lineStart = src.lastIndexOf('\n', blkStart) + 1;
src = src.slice(0, lineStart)
  + '// Phase 2: locator + find-by-text stack now lives in src/engine/locate.js\n'
  + '${LOCATE_STACK_SRC}'
  + src.slice(blkEnd + blkEndTag.length);

// Define LOCATE_STACK_SRC next to LOGIN_TO_PESTPAC_SRC.
const anchor = "const LOGIN_TO_PESTPAC_SRC = fs.readFileSync(path.join(__dirname, 'engine', 'login.js'), 'utf8');";
if (!src.includes(anchor)) throw new Error('login anchor not found');
src = src.replace(anchor, anchor +
  "\nconst LOCATE_STACK_SRC = fs.readFileSync(path.join(__dirname, 'engine', 'locate.js'), 'utf8');");
fs.writeFileSync(p, src, 'utf8');
console.log('E2 spliced. locate.js bytes: ' + locateSrc.length);
