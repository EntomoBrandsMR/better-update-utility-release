// _p4-r16-wiring.js — R16 wiring: scheduler init in main + preload entries.
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

// ── main.js: init after launch recovery ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('initScheduler')) {
  m = repRx(m, /  migrateAppDataToBuuRoot\(\);\r?\n  migrateFlowsIntoFolders\(\);\r?\n  sweepOrphanWorkers\(\);/, [
    '  migrateAppDataToBuuRoot();',
    '  migrateFlowsIntoFolders();',
    '  sweepOrphanWorkers();',
    '  // R16: the scheduler. Fires spreadsheet-free (once) flows at their zone-computed',
    '  // times; launch goes through the renderer as a dumb pipe into the existing pool',
    '  // IPC. Schedules persist under <buuRoot>/schedules/ (userData in dev).',
    "  try { require('./scheduler').initScheduler({",
    '    app, ipcMain,',
    '    buuRoot,',
    '    COORD,',
    '    getWindow: () => mainWindow,',
    '    readFlowByName: (name) => {',
    '      try {',
    "        const safe = String(name || '').replace(/[\\\\/:*?\"<>|]/g, '_');",
    '        if (!safe) return null;',
    "        for (const sub of ['', 'general', 'automation', 'once']) {",
    "          const fp = path.join(getFlowsDir(), sub, safe + '.json');",
    "          if (fs.existsSync(fp)) return { json: fs.readFileSync(fp, 'utf8'), path: fp };",
    '        }',
    '      } catch (e) {}',
    '      return null;',
    '    },',
    "  }); } catch (e) { console.error('[r16] scheduler init failed:', e.message); }"
  ].join('\n'), 'init');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');

// ── preload ──
const pp = path.join(root, 'src', 'preload.js');
let p = fs.readFileSync(pp, 'utf8');
if (!p.includes('schedulesList')) {
  p = repRx(p, /(  onPoolRowError:[^\n]*\r?\n)/, [
    '$1',
    '  // R16: scheduler surface.',
    "  schedulesList:       ()      => ipcRenderer.invoke('schedules-list'),",
    "  scheduleSave:        (s)     => ipcRenderer.invoke('schedule-save', s),",
    "  scheduleDelete:      (d)     => ipcRenderer.invoke('schedule-delete', d),",
    "  scheduleToggle:      (d)     => ipcRenderer.invoke('schedule-toggle', d),",
    "  scheduleRunNow:      (d)     => ipcRenderer.invoke('schedule-run-now', d),",
    "  scheduleSkipMissed:  (d)     => ipcRenderer.invoke('schedule-skip-missed', d),",
    "  scheduleResult:      (d)     => ipcRenderer.send('schedule-result', d),",
    "  onScheduleFire:      (cb)    => ipcRenderer.on('schedule-fire', (_, d) => cb(d)),",
    "  onSchedulesMissed:   (cb)    => ipcRenderer.on('schedules-missed', (_, d) => cb(d)),",
    "  onSchedulesChanged:  (cb)    => ipcRenderer.on('schedules-changed', (_, d) => cb(d)),",
    ''
  ].join('\n'), 'preload entries');
  fs.writeFileSync(pp, p, 'utf8');
  console.log('preload done');
} else console.log('preload already done');
