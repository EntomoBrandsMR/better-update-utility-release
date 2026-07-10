// _audit-step-types.js — read-only: step types used across all saved flows vs types
// implemented in engine/steps.js runStep switch.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const flowDir = path.join(os.homedir(), 'AppData', 'Roaming', 'buu-2', 'flows');
const used = {}; // type -> [flow names]
for (const f of fs.readdirSync(flowDir)) {
  if (!f.endsWith('.json')) continue;
  let j; try { j = JSON.parse(fs.readFileSync(path.join(flowDir, f), 'utf8')); } catch { continue; }
  for (const s of (j.steps || [])) {
    if (!s || !s.type) continue;
    (used[s.type] = used[s.type] || new Set()).add(f);
  }
}
const stepsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'steps.js'), 'utf8');
const impl = [...stepsSrc.matchAll(/case '([a-z0-9-]+)':/g)].map(m => m[1]);
console.log('IMPLEMENTED (' + impl.length + '): ' + impl.join(', '));
console.log('\nUSED IN FLOWS:');
for (const t of Object.keys(used).sort()) console.log('  ' + t.padEnd(18) + used[t].size + ' flow(s)');
const unused = impl.filter(t => !used[t] && !['pestpac-login', 'pestpac-logout'].includes(t));
console.log('\nIMPLEMENTED BUT NEVER USED: ' + (unused.join(', ') || '(none)'));
const unknown = Object.keys(used).filter(t => !impl.includes(t));
console.log('USED BUT NOT IMPLEMENTED (renderer-only/legacy?): ' + (unknown.join(', ') || '(none)'));
