// build/snapshot-flows.js — runs before electron-builder (see package.json "build").
// Snapshots the BUILD MACHINE's live flow library (C:\BUU\flows) into .\flows-bundle\
// which ships inside the installer via extraResources. On first boot after install,
// main.js seedBundledFlows() copies any flow the target machine doesn't already have
// into its flows dir — so every flow Matthew makes on the main rig is available
// wherever BUU gets installed (VMs included). Decided with Matthew 2026-07-17.
// Rules: *.json only, subfolder structure preserved, zz-* test flows and dot-marker
// files excluded. If C:\BUU\flows doesn't exist (building on a VM), the bundle is
// empty and the installer is still valid — a VM build simply ships no library.
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = 'C:\\BUU\\flows';
const DST = path.join(__dirname, '..', 'flows-bundle');
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
let count = 0;
function walk(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;                       // markers
    const s = path.join(src, e.name);
    if (e.isDirectory()) {
      if (/^(results|Finished)$/i.test(e.name)) continue;       // outputs, not flows
      const d = path.join(dst, e.name);
      fs.mkdirSync(d, { recursive: true });
      walk(s, d);
    } else if (e.name.toLowerCase().endsWith('.json') && !/^zz-/i.test(e.name)) {
      fs.copyFileSync(s, path.join(dst, e.name));
      count++;
    }
  }
}
if (fs.existsSync(SRC)) walk(SRC, DST);
console.log('[snapshot-flows] bundled ' + count + ' flow(s) from ' + SRC);
