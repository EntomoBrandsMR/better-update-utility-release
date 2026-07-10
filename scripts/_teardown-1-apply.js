// _teardown-1-apply.js — teardown batch 1: unused step types (clear/assert/textedit)
// + Run Log tab. Every deletion is anchored on content and asserted before cutting.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function mustIndex(s, needle, label) {
  const i = s.indexOf(needle);
  if (i < 0) throw new Error('anchor missing: ' + label);
  return i;
}
function cutLine(s, needle, label) { // remove the whole line containing needle (must be unique)
  const i = mustIndex(s, needle, label);
  if (s.indexOf(needle, i + 1) >= 0) throw new Error('anchor not unique: ' + label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let le = s.indexOf('\n', i); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}
function cutBlockByBraces(s, startNeedle, label) { // from start-of-line of needle through balanced closing brace line
  const i = mustIndex(s, startNeedle, label);
  const ls = s.lastIndexOf('\n', i) + 1;
  let d = 0, j = ls, seen = false;
  for (; j < s.length; j++) {
    if (s[j] === '{') { d++; seen = true; }
    else if (s[j] === '}') { d--; if (seen && d === 0) break; }
  }
  if (j >= s.length) throw new Error('unbalanced block: ' + label);
  let le = s.indexOf('\n', j); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}
function cutRange(s, startNeedle, endNeedle, label) { // start-of-line(start) .. end-of-line(end)
  const i = mustIndex(s, startNeedle, label + ':start');
  const ls = s.lastIndexOf('\n', i) + 1;
  const k = mustIndex(s, endNeedle, label + ':end');
  if (k < i) throw new Error('end before start: ' + label);
  let le = s.indexOf('\n', k); if (le < 0) le = s.length; else le++;
  return s.slice(0, ls) + s.slice(le);
}

// ── engine/steps.js: drop clear / assert / textedit handlers (idempotent) ──
const sp = path.join(root, 'src', 'engine', 'steps.js');
let st = fs.readFileSync(sp, 'utf8');
if (st.includes("case 'clear':{")) {
  st = cutLine(st, "case 'clear':{", 'steps clear');
  st = cutLine(st, "case 'assert':{", 'steps assert');
  st = cutBlockByBraces(st, "case 'textedit':{", 'steps textedit'); // block incl. inner mode switch
  fs.writeFileSync(sp, st, 'utf8');
} else console.log('steps.js already cut');

// ── index.html ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
// add-step buttons
h = cutLine(h, "addStep('clear')", 'btn clear');
h = cutLine(h, "addStep('assert')", 'btn assert');
h = cutLine(h, "addStep('textedit')", 'btn textedit');
// SM registry entries
h = cutLine(h, "clear:    { label:'Clear'", 'SM clear');
h = cutLine(h, "assert:   { label:'Assert'", 'SM assert');
h = cutBlockByBraces(h, "textedit: { label:'Text edit'", 'SM textedit');
// editor field branches
h = cutLine(h, "if(s.type==='clear') return", 'editor clear');
h = cutLine(h, "if(s.type==='assert') return", 'editor assert');
h = cutBlockByBraces(h, "if(s.type==='textedit') {", 'editor textedit');
// validation branches
h = cutLine(h, "if(s.type==='clear'&&!s.selector)", 'validate clear');
h = cutLine(h, "if(s.type==='assert'&&!s.selector)", 'validate assert');
h = cutBlockByBraces(h, "if(s.type==='textedit'){", 'validate textedit');

// cut from start-of-line(startNeedle) up to (not including) start-of-line of the
// FIRST stopNeedle occurring AFTER startNeedle.
function cutUntilBefore(s, startNeedle, stopNeedle, label) {
  const i = mustIndex(s, startNeedle, label + ':start');
  const ls = s.lastIndexOf('\n', i) + 1;
  const k = s.indexOf(stopNeedle, i + startNeedle.length);
  if (k < 0) throw new Error('stop anchor missing after start: ' + label);
  const ks = s.lastIndexOf('\n', k) + 1;
  return s.slice(0, ls) + s.slice(ks);
}

// Run Log tab: nav item (cut through the sb-sep that follows keeps structure — stop at it),
// run-panel shortcut, whole panel (stop at the PROFILES banner comment), JS fns + caller, CSS.
h = cutUntilBefore(h, '<div class="nav" id="nav-log"', '<div class="sb-sep"></div>', 'nav-log block');
h = cutLine(h, ">View log table</button>", 'view-log button');
h = cutUntilBefore(h, '<div class="panel" id="panel-log">', '<!-- \u2550\u2550 PROFILES \u2550\u2550 -->', 'panel-log block');
h = cutLine(h, 'function addLogTableEntry(entry){', 'addLogTableEntry fn');
h = cutBlockByBraces(h, 'async function loadMergedPoolLog(){', 'loadMergedPoolLog fn');
h = cutLine(h, 'function clearLogTable(){', 'clearLogTable fn');
// caller inside row-done handler
{
  const i = mustIndex(h, 'addLogTableEntry({row:evt.rowIndex', 'row-done caller');
  const ls = h.lastIndexOf('\n', i) + 1;
  let le = h.indexOf('\n', i); if (le < 0) le = h.length; else le++;
  h = h.slice(0, ls) + h.slice(le);
}
// state: drop logEntries from the shared decl line + the stale comparison comment
h = h.replace('let logEntries = [], runOk = 0', 'let runOk = 0');
h = h.replace('(unlike logEntries which is sliced to last 500)', '(uncapped)');
if (h.includes('logEntries')) throw new Error('logEntries still referenced');
// CSS: LOG TABLE section (keep .s-ok/.s-err/.s-skip — status colors used elsewhere)
h = cutUntilBefore(h, ' LOG TABLE ', '.s-ok {', 'log-table css');
fs.writeFileSync(hp, h, 'utf8');
console.log('teardown batch 1 applied');

