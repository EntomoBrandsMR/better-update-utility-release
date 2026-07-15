// _hdr-removal2.js — finish the job: the five leftover refs the first pass missed
// (embedded in multi-statement lines, so the line filter didn't catch them). Two were
// live throws: poolUIActive touching the deleted runBtn/stopBtn, and boot-init +
// setActiveProfile calling the deleted refreshRunBtn.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function rep(s, from, to, label) {
  const i = s.indexOf(from);
  if (i < 0) throw new Error('anchor missing: ' + label);
  if (s.indexOf(from, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  return s.slice(0, i) + to + s.slice(i + from.length);
}
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
h = rep(h, "document.getElementById('runBtn').style.display = active?'none':'';", "// (legacy header runBtn/stopBtn removed — the sidebar pool buttons are the only controls)", 'runBtn toggle');
h = rep(h, "document.getElementById('stopBtn').style.display = active?'':'none';", '', 'stopBtn toggle');
h = rep(h, "// ARE met, it's the normal Run button. runBtnClick() routes to the right action.", "// ARE met, it's the normal Run button (sidebar Run pool).", 'comment');
h = rep(h, 'renderColChips(); renderPreview(); renderSteps(); refreshRunBtn();', 'renderColChips(); renderPreview(); renderSteps();', 'boot init call');
h = rep(h, 'renderProfiles();refreshRunBtn', 'renderProfiles()', 'setActiveProfile call');
fs.writeFileSync(hp, h, 'utf8');
console.log('done');
// final audit
const h2 = fs.readFileSync(hp, 'utf8');
let clean = true;
for (const n of ["'runBtn'", "'stopBtn'", 'runBtnClick', 'refreshRunBtn', 'forceStopBtn', 'forceStopNow']) {
  let p = -1;
  while ((p = h2.indexOf(n, p + 1)) >= 0) {
    const ls = h2.lastIndexOf('\n', p) + 1;
    console.log('LEFTOVER ' + n + ': ' + h2.slice(ls, h2.indexOf('\n', p)).trim().slice(0, 120));
    clean = false;
  }
}
console.log(clean ? 'CLEAN' : 'NOT CLEAN');
