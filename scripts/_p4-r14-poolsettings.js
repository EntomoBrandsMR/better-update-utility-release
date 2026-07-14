// _p4-r14-poolsettings.js — Phase 4 R14: pool settings save with the flow.
// saveFlow embeds { workers, scaleMult, evalMin, elastic, diag, diagCap }; loadFlow
// applies them to the sidebar (defaults when absent: workers 1, mult 3, every 2 min,
// elastic off, diag off). Launch-screen override per run WITHOUT re-saving is inherent —
// sliders stay editable and only saveFlow persists. Also closes the R4 alignment note:
// the pool-RESUME eval timer is now always-on (elastic only gates the license part via
// elasticParams), matching pool-start. And resume now sets elasticParams so a resumed
// elastic pool actually license-caps again.
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

// ── main.js: resume timer alignment ──
const mp = path.join(root, 'src', 'main.js');
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('R14: the resume eval timer')) {
  m = repRx(m, /  if \(elastic && licenseProfileId\) \{\r?\n    COORD\.licenseTimer = setInterval\(\(\) => coordEvalScale\(\), Math\.max\(1, parseInt\(licenseIntervalMin\) \|\| 2\) \* 60 \* 1000\);\r?\n  \}/, [
    '  // R14: the resume eval timer is ALWAYS-ON (pressure sensing works without elastic),',
    '  // matching pool-start; elastic only gates the license part via elasticParams — which',
    '  // resume now sets, so a resumed elastic pool license-caps again.',
    '  COORD.elasticParams = (elastic && licenseProfileId)',
    '    ? { licenseProfileId, licenseBuffer, hwCap, intervalMs: Math.max(1, parseInt(licenseIntervalMin) || 2) * 60 * 1000 }',
    '    : null;',
    '  COORD.licenseTimer = setInterval(() => coordEvalScale(), Math.max(1, parseInt(licenseIntervalMin) || 2) * 60 * 1000);'
  ].join('\n'), 'resume timer');
  fs.writeFileSync(mp, m, 'utf8');
  console.log('main done');
} else console.log('main already done');

// ── index.html: save/load pool settings ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('poolSettings')) {
  h = repRx(h, /(    runMode: runMode,\r?\n    automation: flowAutomation, \/\/ R9)/, [
    '$1',
    '    // R14: pool settings ride with the flow — applied as defaults on load; the sidebar',
    '    // sliders remain a per-run override that persists only on the next save.',
    '    poolSettings: {',
    "      workers: parseInt((document.getElementById('poolWorkerCount')||{}).value) || 1,",
    "      scaleMult: parseInt((document.getElementById('poolScaleMult')||{}).value) || 3,",
    "      evalMin: parseInt((document.getElementById('poolLicInterval')||{}).value) || 2,",
    "      elastic: !!(document.getElementById('poolElastic')||{}).checked,",
    "      diag: !!(document.getElementById('poolDiagCapture')||{}).checked,",
    "      diagCap: parseInt((document.getElementById('poolDiagCap')||{}).value) || 10,",
    '    },'
  ].join('\n'), 'save settings');
  h = rep(h, '  clearFlowDirty(); // R10: freshly loaded = clean; also refreshes the builder title', [
    '  // R14: apply the saved pool settings from the flow (spec defaults when absent:',
    '  // workers 1, multiplier 3, eval every 2 min, elastic off, diagnostics off).',
    '  {',
    '    const ps = data.poolSettings || {};',
    '    const _set = function(id, v){ const el = document.getElementById(id); if(el != null && v != null) el.value = v; };',
    "    _set('poolWorkerCount', ps.workers != null ? ps.workers : 1);",
    "    _set('poolScaleMult', ps.scaleMult != null ? ps.scaleMult : 3);",
    "    _set('poolLicInterval', ps.evalMin != null ? ps.evalMin : 2);",
    "    _set('poolDiagCap', ps.diagCap != null ? ps.diagCap : 10);",
    "    { const el = document.getElementById('poolElastic'); if(el) el.checked = !!ps.elastic; }",
    "    { const el = document.getElementById('poolDiagCapture'); if(el) el.checked = !!ps.diag; }",
    '    try { poolScalingLive(); } catch (e) {}',
    '  }',
    '  clearFlowDirty(); // R10: freshly loaded = clean; also refreshes the builder title'
  ].join('\n'), 'load settings');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done');
} else console.log('index already done');
