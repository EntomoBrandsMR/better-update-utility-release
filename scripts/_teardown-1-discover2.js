// _teardown-1-discover2.js — round 2: JS call graph for the Run Log tab + block extents.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const lines = src.split(/\r?\n/);
const pats = [
  ['logEntries', /\blogEntries\b/],
  ['addLogTableEntry call/def', /addLogTableEntry/],
  ['clearLogTable call/def', /clearLogTable/],
  ['renderLogTable', /renderLogTable/],
  ['renderMergedPoolLog-ish fn header near 3598', null],
  ['panel boundary', /^<div class="panel"/],
  ['next if(s.type=== after 1926', null],
  ['next if(s.type=== after 2104', null],
];
for (let i = 0; i < lines.length; i++) {
  for (const [name, re] of pats) {
    if (re && re.test(lines[i])) console.log(String(i + 1).padStart(5) + ' [' + name + '] ' + lines[i].trim().slice(0, 95));
  }
}
// function containing 3598 and its extent (naive: previous 'function ' line, next 'function ' line)
for (const target of [3598, 3022, 3625]) {
  let s = target - 1; while (s > 0 && !/^\s*function |^function /.test(lines[s])) s--;
  let e = target; while (e < lines.length && !/^\s*function |^function /.test(lines[e])) e++;
  console.log('fn around ' + target + ': lines ' + (s + 1) + '..' + e + ' :: ' + lines[s].trim().slice(0, 80));
}
// block ends for editor branches
for (const start of [1926, 2104, 1530]) {
  let d = 0, e = start - 1;
  for (let i = start - 1; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '{') d++; else if (ch === '}') d--; }
    if (d <= 0 && i > start - 1) { e = i; break; }
  }
  console.log('block ' + start + ' ends at line ' + (e + 1) + ' :: ' + lines[e].trim().slice(0, 60));
}
