// _test-mutation.js — MUTATION CHECK. Does _test-containment.js actually catch the bug,
// or does it pass on anything? Temporarily removes the v3.0.3 guards from a WORKING COPY
// of coordinator.js, reruns the test, and asserts it FAILS. Restores via git afterwards.
// A green test on broken code is worse than no test.
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
const backup = fs.readFileSync(cp, 'utf8');

function restore() {
  fs.writeFileSync(cp, backup, 'utf8');
  const now = fs.readFileSync(cp, 'utf8');
  if (now !== backup) throw new Error('RESTORE FAILED');
}

try {
  // ── mutation 1: remove the re-entrancy mutex ──
  let broken = backup.replace('if(_evalInFlight){ _evalPending = true; return; }', '// MUTATION: mutex removed');
  if (broken === backup) throw new Error('mutation 1 anchor missing');
  // ── mutation 2: remove the in-loop clamp re-assert ──
  const b2 = broken.replace('if (COORD.workers.size >= target) break;', '// MUTATION: clamp re-assert removed');
  if (b2 === broken) throw new Error('mutation 2 anchor missing');
  broken = b2;
  fs.writeFileSync(cp, broken, 'utf8');
  console.log('guards removed — rerunning the containment test (it MUST fail)\n');

  let failed = false, out = '';
  try {
    out = execSync('node "' + path.join(__dirname, '_test-containment.js') + '"', { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  console.log(out.split('\n').filter(l => /PASS|FAIL|RESULT|peak=/.test(l)).join('\n'));
  restore();
  console.log('\ncoordinator.js restored from backup.');
  if (failed) {
    console.log('\nMUTATION CHECK: PASS — the test DETECTS the missing guards.');
    process.exit(0);
  } else {
    console.log('\nMUTATION CHECK: FAIL — the test passed WITHOUT the guards, so it proves nothing.');
    process.exit(1);
  }
} catch (e) {
  try { restore(); console.log('coordinator.js restored after error.'); } catch (e2) { console.log('!!! RESTORE FAILED: ' + e2.message); }
  console.log('HARNESS ERROR: ' + e.message);
  process.exit(1);
}
