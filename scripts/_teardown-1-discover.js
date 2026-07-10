// _teardown-1-discover.js — read-only discovery for teardown batch 1:
// unused step types (clear/assert/textedit) + Run Log tab, in src/index.html.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const lines = src.split(/\r?\n/);
const hits = [];
const pats = [
  ["type==='clear'", /type\s*===\s*'clear'/],
  ["type==='assert'", /type\s*===\s*'assert'/],
  ["type==='textedit'", /type\s*===\s*'textedit'/],
  ["addStep('clear'|'assert'|'textedit')", /addStep\('(clear|assert|textedit)'\)/],
  ['SM clear/assert/textedit entry', /^\s{2}(clear|assert|textedit):\s*\{/],
  ['editMode/textedit fields', /editMode|searchText|replaceText/],
  ['nav-log / panel-log / nb-log', /nav-log|panel-log|nb-log/],
  ["go('log')", /go\('log'\)/],
  ['logBody / logStats / mergedPoolLog*', /\blogBody\b|\blogStats\b|mergedPoolLog/],
  ['row-skip css', /row-skip/],
];
for (let i = 0; i < lines.length; i++) {
  for (const [name, re] of pats) {
    if (re.test(lines[i])) hits.push(String(i + 1).padStart(5) + ' [' + name + '] ' + lines[i].trim().slice(0, 100));
  }
}
console.log(hits.join('\n'));
console.log('total: ' + hits.length);
