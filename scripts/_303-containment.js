// _303-containment.js — THE 4-BECAME-29 BUG.
// coordEvalScale/coordScaleTo are async and RE-ENTRANT with no guard. Five callers can
// enter: the eval timer (main 728/804/842/974) and every slider move (main 844).
// coordScaleTo reads `const live = COORD.workers.size` ONCE, then sits in an await loop
// up to 90s PER WORKER. A second call entering mid-ramp computes canSpawn from a stale
// live count and spawns independently — they compound. Matthew watched a cap of 4 reach
// 29; I twice claimed that was impossible. He was right.
// Two fixes, belt and braces:
//   1. a single in-flight mutex on the eval path (coalescing, not dropping — a pending
//      request re-runs once the current pass finishes, so the last slider move still wins)
//   2. re-assert the clamp INSIDE the ramp loop, after every await, reading the LIVE
//      count each time. Even if something re-enters, no spawn can cross the target.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = path.join(__dirname, '..', 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
function repRx(rx, to, label) {
  const hits = c.match(new RegExp(rx.source, rx.flags.replace('g', '') + 'g'));
  if (!hits) throw new Error('anchor missing: ' + label);
  if (hits.length > 1) throw new Error('anchor NOT UNIQUE (' + hits.length + '): ' + label);
  c = c.replace(rx, to);
}
if (c.includes('_evalInFlight')) { console.log('already done'); process.exit(0); }

// ── 1) mutex on the eval path ──
repRx(/(async function coordEvalScale\(\)\{\r?\n)(\s*)(if\(!COORD\.active \|\| COORD\.stopping\) return;)/, [
  '// v3.0.3: RE-ENTRANCY GUARD. This function awaits (license scrape, and a ramp that can',
  '// run 90s per worker) while five callers can fire it — the eval timer and every slider',
  '// move. Concurrent passes each read a stale worker count and spawn independently, which',
  '// is how a manual cap of 4 produced 29 live workers. Coalesce rather than drop: a request',
  '// arriving mid-pass sets _evalPending so the LAST intent still gets applied once.',
  'let _evalInFlight = false;',
  'let _evalPending = false;',
  '$1$2$3',
  '$2if(_evalInFlight){ _evalPending = true; return; }',
  '$2_evalInFlight = true;',
  '$2try {'
].join('\n'), 'mutex open');

// close the try/finally at the end of coordEvalScale
repRx(/(\r?\n)(\s*)COORD\.capReason = reason;(\r?\n\s*)COORD\.desiredWorkers = target;(\r?\n\s*)await coordScaleTo\(target\);(\r?\n\s*)coordEmitStatus\(\);(\r?\n\})/, [
  '$1$2  COORD.capReason = reason;',
  '$2  COORD.desiredWorkers = target;',
  '$2  await coordScaleTo(target);',
  '$2  coordEmitStatus();',
  '$2} finally {',
  '$2  _evalInFlight = false;',
  '$2  // a request that arrived mid-pass runs now, so the last slider move is never lost',
  '$2  if(_evalPending){ _evalPending = false; setTimeout(() => { coordEvalScale().catch(()=>{}); }, 0); }',
  '$2}',
  '}'
].join('\n'), 'mutex close');

// ── 2) re-assert the clamp inside the ramp loop ──
repRx(/(\s*)for \(let i = 0; i < canSpawn; i\+\+\) \{(\r?\n\s*)const _id = await coordSpawnWorker\(\);/, [
  '$1for (let i = 0; i < canSpawn; i++) {',
  '$1  // v3.0.3: re-assert against the LIVE count every iteration. `live` above is a',
  '$1  // snapshot and this loop awaits for up to 90s per worker — by now it can be stale,',
  '$1  // and anything that re-entered must not be able to push us past the target.',
  '$1  if (COORD.workers.size >= target) break;',
  '$1  const _id = await coordSpawnWorker();'
].join('\n'), 'clamp re-assert');
fs.writeFileSync(cp, c, 'utf8');
console.log('done');
