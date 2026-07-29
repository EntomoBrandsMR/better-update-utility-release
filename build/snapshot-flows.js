// build/snapshot-flows.js — runs before electron-builder (see package.json "build").
// Snapshots the BUILD MACHINE's live flow library (C:\BUU\flows) into .\flows-bundle\
// which ships inside the installer via extraResources. On boot, main.js
// seedBundledFlows() copies any flow the target machine doesn't already have (by NAME,
// anywhere in the flows tree) — so every flow Matthew makes on the main rig is
// available wherever BUU gets installed (VMs included). Decided with Matthew 2026-07-17.
// Rules: *.json only, subfolder structure preserved, zz-* test flows and dot-marker
// files excluded. If C:\BUU\flows doesn't exist (building on a VM), the bundle is
// empty and the installer is still valid — a VM build simply ships no library.
// R3 (3.2.0): DEDUPE AT THE SOURCE. A flat-root .json whose filename also exists in
// any subfolder is the stale duplicate the app migrates away — shipping it re-infected
// every install (the seeder copied it right back after migration deleted it). The
// subfolder copy is the saved/edited one and wins; the flat copy is skipped.
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = 'C:\\BUU\\flows';
const DST = path.join(__dirname, '..', 'flows-bundle');
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
let count = 0, skippedDupes = 0;

// Names present in any SRC subfolder (lowercased) — used to skip shadowed flat copies.
const subNames = new Set();
if (fs.existsSync(SRC)) {
  for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || /^(results|Finished)$/i.test(e.name)) continue;
    try {
      for (const f of fs.readdirSync(path.join(SRC, e.name))) {
        if (f.toLowerCase().endsWith('.json')) subNames.add(f.toLowerCase());
      }
    } catch (err) {}
  }
}

function walk(src, dst, atRoot) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;                       // markers
    const s = path.join(src, e.name);
    if (e.isDirectory()) {
      if (/^(results|Finished)$/i.test(e.name)) continue;       // outputs, not flows
      const d = path.join(dst, e.name);
      fs.mkdirSync(d, { recursive: true });
      walk(s, d, false);
    } else if (e.name.toLowerCase().endsWith('.json') && !/^zz-/i.test(e.name)) {
      if (atRoot && subNames.has(e.name.toLowerCase())) { skippedDupes++; continue; } // R3: shadowed flat dup
      fs.copyFileSync(s, path.join(dst, e.name));
      count++;
    }
  }
}
if (fs.existsSync(SRC)) walk(SRC, DST, true);
console.log('[snapshot-flows] bundled ' + count + ' flow(s) from ' + SRC + (skippedDupes ? ' (skipped ' + skippedDupes + ' flat-root duplicate(s) shadowed by subfolder copies)' : ''));
