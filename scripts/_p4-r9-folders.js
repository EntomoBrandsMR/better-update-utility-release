// _p4-r9-folders.js — Phase 4 R9: flow folders.
// flows\once\ (setup+teardown once-flows), flows\automation\ (ONLY flows the user
// explicitly checkboxes — nothing auto-flagged), flows\general\ (default). Startup
// migration sorts flat legacy flows by runMode. Pickers filter: setup/teardown reads
// once\ (+ flat stragglers); save dialog defaults into the right subfolder;
// read-flow-by-name (launch fresh-read) searches all of them.
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
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}

// ── main.js ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('migrateFlowsIntoFolders')) {
  m = rep(m, '// R8: one-time migration from the old %APPDATA%\\buu-2 layout into the install root.', [
    '// R9: flow folders. flows\\once\\ (setup/teardown once-flows), flows\\automation\\',
    '// (ONLY flows the user explicitly flags — nothing is auto-flagged), flows\\general\\',
    '// (everything else). Startup migration sorts flat legacy flows by runMode.',
    "const FLOW_SUBS = ['automation', 'once', 'general'];",
    'function ensureFlowSubdirs(dir) {',
    '  for (const s2 of FLOW_SUBS) { const p2 = path.join(dir, s2); if (!fs.existsSync(p2)) { try { fs.mkdirSync(p2, { recursive: true }); } catch (e) {} } }',
    '}',
    'function migrateFlowsIntoFolders() {',
    '  try {',
    '    const dir = getFlowsDir();',
    '    ensureFlowSubdirs(dir);',
    "    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.toLowerCase().endsWith('.json'));",
    '    let moved = 0;',
    '    for (const e of entries) {',
    '      const fp = path.join(dir, e.name);',
    "      let sub = 'general';",
    "      try { const d = JSON.parse(fs.readFileSync(fp, 'utf8')); if (d.runMode === 'once') sub = 'once'; } catch (err) {}",
    '      const dst = path.join(dir, sub, e.name);',
    '      try { if (!fs.existsSync(dst)) { fs.renameSync(fp, dst); moved++; } } catch (err) {}',
    '    }',
    "    if (moved) console.log('[r9] sorted ' + moved + ' flat flow(s) into folders');",
    '  } catch (e) {}',
    '}',
    '',
    '// R8: one-time migration from the old %APPDATA%\\buu-2 layout into the install root.'
  ].join('\n'), 'folder fns');
  m = repRx(m, /  migrateAppDataToBuuRoot\(\);\r?\n  sweepOrphanWorkers\(\);/,
    '  migrateAppDataToBuuRoot();\n  migrateFlowsIntoFolders();\n  sweepOrphanWorkers();', 'ready hook');
  m = repRx(m, /ipcMain\.handle\('save-flow', async \(_, \{ json, name \}\) => \{\r?\n  const defaultName = \(name \|\| 'buu-flow'\) \+ '\.json';\r?\n  const r = await dialog\.showSaveDialog\(mainWindow, \{\r?\n    title: 'Save flow',\r?\n    defaultPath: path\.join\(getFlowsDir\(\), defaultName\),/, [
    "ipcMain.handle('save-flow', async (_, { json, name, sub }) => {",
    "  const defaultName = (name || 'buu-flow') + '.json';",
    '  ensureFlowSubdirs(getFlowsDir());',
    "  // R9: default into the folder matching the flow type (once / automation / general).",
    "  const _sub = FLOW_SUBS.includes(sub) ? sub : 'general';",
    '  const r = await dialog.showSaveDialog(mainWindow, {',
    "    title: 'Save flow',",
    '    defaultPath: path.join(getFlowsDir(), _sub, defaultName),'
  ].join('\n'), 'save sub');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main part 1 done');
} else console.log('main part 1 already done');

// main part 2: list-once-flows folder scan + read-flow-by-name subfolder search
m = fs.readFileSync(mp, 'utf8');
if (!m.includes('ent.filename')) {
  m = repRx(m, /  const dir = getFlowsDir\(\);\r?\n  let entries = \[\];\r?\n  try \{\r?\n    entries = fs\.readdirSync\(dir\)\.filter\(f => f\.toLowerCase\(\)\.endsWith\('\.json'\)\);\r?\n  \} catch \(e\) \{\r?\n    return \{ ok: false, error: 'Cannot read flows directory: ' \+ e\.message, flows: \[\] \};\r?\n  \}/, [
    '  const dir = getFlowsDir();',
    '  ensureFlowSubdirs(dir);',
    '  let entries = [];',
    '  // R9: the setup/teardown picker reads flows\\once\\ plus any flat stragglers at the',
    '  // root (pre-R9 saves, or files dropped in by hand).',
    "  for (const d of [path.join(dir, 'once'), dir]) {",
    '    let names = [];',
    "    try { names = fs.readdirSync(d).filter(f => f.toLowerCase().endsWith('.json')); } catch (e) { continue; }",
    '    for (const f of names) entries.push({ filename: f, dir: d });',
    '  }'
  ].join('\n'), 'once scan');
  m = repRx(m, /  for \(const filename of entries\) \{\r?\n    const fp = path\.join\(dir, filename\);/, [
    '  for (const ent of entries) {',
    '    const filename = ent.filename;',
    '    const fp = path.join(ent.dir, filename);'
  ].join('\n'), 'once loop');
  m = repRx(m, /    const fp = path\.join\(getFlowsDir\(\), safe \+ '\.json'\);\r?\n    if \(!fs\.existsSync\(fp\)\) return null;\r?\n    return \{ json: fs\.readFileSync\(fp, 'utf8'\), mtime: fs\.statSync\(fp\)\.mtimeMs, path: fp \};/, [
    '    // R9: search the flow folders (flat root first for pre-R9 stragglers).',
    "    for (const sub of ['', 'general', 'automation', 'once']) {",
    "      const fp = path.join(getFlowsDir(), sub, safe + '.json');",
    "      if (fs.existsSync(fp)) return { json: fs.readFileSync(fp, 'utf8'), mtime: fs.statSync(fp).mtimeMs, path: fp };",
    '    }',
    '    return null;'
  ].join('\n'), 'read-by-name subs');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main part 2 done');
} else console.log('main part 2 already done');

// ── index.html: Automation checkbox + save/load plumbing ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('flowAutomation')) {
  h = repRx(h, /        <input type="radio" name="runMode" value="once" id="runModeOnce" onchange="setRunMode\('once'\)"\/>\r?\n        <span>Once-flow \(no spreadsheet\)<\/span>\r?\n      <\/label>/, [
    '        <input type="radio" name="runMode" value="once" id="runModeOnce" onchange="setRunMode(\'once\')"/>',
    '        <span>Once-flow (no spreadsheet)</span>',
    '      </label>',
    '      <label style="display:flex;align-items:center;gap:8px;cursor:pointer" title="Automation flows are meant for scheduled/unattended runs and save into flows\\automation. Nothing is flagged automatically - only this checkbox.">',
    '        <input type="checkbox" id="flowAutomation" onchange="flowAutomation=this.checked"/>',
    '        <span>Automation flow</span>',
    '      </label>'
  ].join('\n'), 'checkbox');
  h = rep(h, 'async function saveFlow(){', 'let flowAutomation = false; // R9: saves into flows\\automation when checked\n\nasync function saveFlow(){', 'state decl');
  h = repRx(h, /    runMode: runMode,\r?\n    setupFlowId: setupFlowId,/,
    '    runMode: runMode,\n    automation: flowAutomation, // R9\n    setupFlowId: setupFlowId,', 'flow field');
  h = rep(h, 'const p = await API.saveFlow({ json, name: saveName });',
    "const p = await API.saveFlow({ json, name: saveName, sub: runMode === 'once' ? 'once' : (flowAutomation ? 'automation' : 'general') });", 'save sub');
  h = rep(h, "  flowName = data.name || '';", [
    "  flowName = data.name || '';",
    '  flowAutomation = !!data.automation; // R9',
    "  { const _fa = document.getElementById('flowAutomation'); if (_fa) _fa.checked = flowAutomation; }"
  ].join('\n'), 'load restore');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done');
} else console.log('index already done');
