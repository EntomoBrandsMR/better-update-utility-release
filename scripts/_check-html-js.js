// Recreated 2026-07-04 (work machine) — original lives only on the bigma box.
// Extracts every <script> block from src/index.html and syntax-checks each with node --check.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const blocks = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) blocks.push(m[1]);
if (!blocks.length) { console.error('FAIL: no inline <script> blocks found'); process.exit(1); }

let failed = 0;
blocks.forEach(function (code, idx) {
  const tmp = path.join(os.tmpdir(), '_buu_html_js_check_' + idx + '.js');
  fs.writeFileSync(tmp, code, 'utf8');
  const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed++;
    console.error('FAIL: script block #' + (idx + 1) + ' has a syntax error:');
    console.error(res.stderr);
  }
});
if (failed) process.exit(1);
console.log('OK: ' + blocks.length + ' inline script block(s) parse cleanly');

// v3.0.3: DIV BALANCE MUST BE 0. This is not cosmetic. A single surplus </div> closed
// .content 177 lines early, so the browser reparented panel-run/profiles/schedules onto
// .shell (display:flex) and each rendered as a third flex COLUMN - the emptied .content
// kept flex:1 and ate the left half. That was the "Run progress is shoved right" bug.
// A -1 balance was reported as "baseline" in every validation for an entire session while
// it was, in fact, the bug printing itself on screen. Never normalise this number again.
(function checkDivBalance(){
  const fs2 = require('fs');
  const src = fs2.readFileSync(require('path').join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const open = (src.match(/<div\b/g) || []).length;
  const close = (src.match(/<\/div>/g) || []).length;
  const bal = open - close;
  if (bal !== 0) {
    console.error('FAIL: div balance ' + bal + ' (open ' + open + ' / close ' + close + '). Must be 0 - malformed HTML reparents panels onto .shell.');
    process.exit(1);
  }
  console.log('OK: div balance 0 (' + open + ' open / ' + close + ' close)');
})();