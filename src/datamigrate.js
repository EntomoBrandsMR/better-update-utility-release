'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 3.2.2 DATA MIGRATION — move user data OUT of the install directory, for good.
//
// Through 3.2.1, buuRoot() (when packaged) was path.dirname(process.execPath) — so flows,
// schedules, logs, and failures lived NEXT TO THE .EXE, inside the install folder. Every
// installer wipes the old program folder before laying down the new one, so a reinstall/
// update/uninstall could destroy user data; the fragile "park to C:\BUU-preserved and
// restore" dance in installer.nsh existed only to work around that, and it broke the moment
// the install location wasn't exactly where it expected (the 07-31 VM loss).
//
// 3.2.2 puts data at a FIXED root OUTSIDE the install dir (C:\BUU-Data). This module copies
// data into that root from every legacy location, exactly the safe way: COPY (never move),
// NEVER overwrite an existing file. A partial or repeated run can only ADD files, never lose
// one. Pure fs (no electron) so the offline suite exercises the real shipping logic.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// The user-data subtrees that used to live in the install dir and now live in the data root.
const DATA_SUBDIRS = ['flows', 'schedules', 'logs', 'failures'];

// Recursively copy `src` into `dst` WITHOUT overwriting any file that already exists in `dst`
// (existing/local data always wins). Missing src → 0. Never throws on a per-file error —
// one unreadable file must not abort the whole migration. Returns files copied.
function copyDirNoOverwrite(src, dst, fsm) {
  const F = fsm || fs;
  let copied = 0;
  let st; try { st = F.statSync(src); } catch (e) { return 0; }
  if (st.isDirectory()) {
    try { F.mkdirSync(dst, { recursive: true }); } catch (e) {}
    let names = []; try { names = F.readdirSync(src); } catch (e) { return copied; }
    for (const name of names) copied += copyDirNoOverwrite(path.join(src, name), path.join(dst, name), F);
  } else {
    let exists = true; try { F.accessSync(dst); } catch (e) { exists = false; }
    if (!exists) {
      try { F.mkdirSync(path.dirname(dst), { recursive: true }); F.copyFileSync(src, dst); copied++; } catch (e) {}
    }
  }
  return copied;
}

// Migrate DATA_SUBDIRS into `destRoot` from each candidate source root, in priority order.
// Existing files in destRoot are never clobbered, and a source that equals the dest is skipped.
// Returns { destRoot, copied, bySource } — a summary safe to log. Never throws.
function migrateInto(destRoot, sourceRoots, opts) {
  const F = (opts && opts.fs) || fs;
  const subdirs = (opts && opts.subdirs) || DATA_SUBDIRS;
  const summary = { destRoot: destRoot, copied: 0, bySource: {} };
  try { F.mkdirSync(destRoot, { recursive: true }); } catch (e) {}
  let destResolved; try { destResolved = path.resolve(destRoot); } catch (e) { destResolved = destRoot; }
  for (const srcRoot of (sourceRoots || [])) {
    if (!srcRoot) continue;
    try { if (path.resolve(srcRoot) === destResolved) continue; } catch (e) {}
    let n = 0;
    for (const d of subdirs) n += copyDirNoOverwrite(path.join(srcRoot, d), path.join(destRoot, d), F);
    if (n) summary.bySource[srcRoot] = n;
    summary.copied += n;
  }
  return summary;
}

module.exports = { DATA_SUBDIRS, copyDirNoOverwrite, migrateInto };
