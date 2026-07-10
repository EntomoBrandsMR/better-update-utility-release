// _validate-pool-worker.js — v2 (Phase 2): the pool worker shell is now a real file
// (src/pool/worker.js) assembled at spawn by buildPoolWorker via marker substitution.
// This validator performs the SAME assembly (engine files + string-constant helpers
// spliced at __BUU_INLINE markers; __BUU_CFG markers left as their valid null defaults)
// and syntax-checks the assembled child source.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');

const mainSrc = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
function constValue(name) {
  const d = mainSrc.indexOf('const ' + name + ' = `');
  if (d < 0) { console.error('FAIL: const ' + name + ' not found in main.js'); process.exit(1); }
  const open = mainSrc.indexOf('`', d) + 1;
  const close = mainSrc.indexOf('`;', open);
  return mainSrc.slice(open, close).replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');
}
const inline = {
  REQUIRE_FN_SRC: constValue('REQUIRE_FN_SRC'),
  LOGIN_TO_PESTPAC_SRC: fs.readFileSync(path.join(root, 'src', 'engine', 'login.js'), 'utf8'),
  LOCATE_STACK_SRC: fs.readFileSync(path.join(root, 'src', 'engine', 'locate.js'), 'utf8'),
  STEPS_SRC: fs.readFileSync(path.join(root, 'src', 'engine', 'steps.js'), 'utf8'),
  PROBE_NETWORK_FN_SRC: constValue('PROBE_NETWORK_FN_SRC'),
  WAIT_FOR_NETWORK_FN_SRC: constValue('WAIT_FOR_NETWORK_FN_SRC'),
  CLASSIFY_ERROR_FN_SRC: constValue('CLASSIFY_ERROR_FN_SRC'),
  CLASSIFY_PHASE_FN_SRC: constValue('CLASSIFY_PHASE_FN_SRC'),
};

let shell = fs.readFileSync(path.join(root, 'src', 'pool', 'worker.js'), 'utf8');
shell = shell.replace(/\/\*__BUU_INLINE ([A-Z_]+)__\*\//g, (_, n) => {
  if (!(n in inline)) { console.error('FAIL: unknown inline marker ' + n); process.exit(1); }
  return inline[n];
});
if (/\/\*__BUU_INLINE [A-Z_]+__\*\//.test(shell)) { console.error('FAIL: unresolved inline marker'); process.exit(1); }
const cfgCount = (shell.match(/\/\*__BUU_CFG_\d+__\*\/null/g) || []).length;

const tmp = path.join(require('os').tmpdir(), '_buu_pool_worker_check.js');
fs.writeFileSync(tmp, shell, 'utf8');
const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
if (res.status !== 0) {
  console.error('FAIL: assembled pool worker has a syntax error:');
  console.error(res.stderr);
  process.exit(1);
}
console.log('OK: assembled pool worker parses cleanly (' + shell.length + ' chars, ' + cfgCount + ' cfg markers)');
