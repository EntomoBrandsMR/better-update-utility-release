// _303-license-always.js — LICENSE COUNTING BECOMES UNCONDITIONAL.
// Today: renderer sends `licenseProfileId: elastic ? activeProfileId : null`, and main does
// `COORD.elasticParams = (elastic && licenseProfileId) ? {...} : null`. Untick Auto-scale
// and licenseProfileId is null -> elasticParams null -> coordEvalScale sets
// COORD.licenseCap = Infinity -> NO license counting and the buffer is IGNORED ENTIRELY.
// Matthew has been clear from the start: knowing seats in use and respecting the buffer is
// a HARD SAFETY CONSTRAINT, not a feature of a checkbox. You cannot tick away a safety rail.
//
// New semantics (agreed): the Auto-scale checkbox gates ONLY the throughput/pressure climb
// — i.e. "let the pool find its own number". The license cap ALWAYS applies, as do the
// hardware cap and Max. Auto-scale off means "hold my number", never "stop counting seats".
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function globalRep(file, from, to, expect, label) {
  const p = path.join(root, file);
  let s = fs.readFileSync(p, 'utf8');
  const n = s.split(from).length - 1;
  if (n !== expect) throw new Error(file + ': ' + label + ' expected ' + expect + ' hit(s), found ' + n);
  s = s.split(from).join(to);
  fs.writeFileSync(p, s, 'utf8');
  console.log(file + ': ' + label + ' -> ' + n + ' site(s)');
}

// ── renderer: always send the profile, never gate it on the checkbox ──
globalRep('src/index.html',
  'licenseProfileId: elastic?activeProfileId:null',
  'licenseProfileId: activeProfileId /* v3.0.3: ALWAYS. License counting is a safety rail, not an Auto-scale feature */',
  2, 'renderer license profile');

// ── main: elasticParams no longer depends on the checkbox ──
globalRep('src/main.js',
  'COORD.elasticParams = (elastic && licenseProfileId)',
  '// v3.0.3: license counting runs whenever we have a profile to read it with. It is NOT\n' +
  '  // gated on the Auto-scale checkbox — unticking a box must never silently stop us\n' +
  '  // counting PestPac seats or honouring the buffer.\n' +
  '  COORD.elasticParams = (licenseProfileId)',
  2, 'main elasticParams');

// ── coordinator: make the intent explicit at the decision point ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
const from = '  if(COORD.autoScale){';
const i = c.indexOf(from);
if (i < 0) throw new Error('autoScale anchor missing');
if (c.indexOf(from, i + 1) >= 0) throw new Error('autoScale anchor not unique');
c = c.slice(0, i) +
  '  // v3.0.3: the license cap above is UNCONDITIONAL — it has already been applied.\n' +
  '  // COORD.autoScale gates ONLY the throughput/pressure climb below, i.e. whether the\n' +
  '  // pool is allowed to hunt for its own worker count. Off = hold the number the user\n' +
  '  // set; it never means "stop counting licenses".\n' +
  from + c.slice(i + from.length);
fs.writeFileSync(cp, c, 'utf8');
console.log('src/pool/coordinator.js: intent comment at the decision point');
