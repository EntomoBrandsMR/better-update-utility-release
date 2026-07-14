// _r11-discover2.js — shim blast radius (read-only).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let out = '';
const h = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const p = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
function seg(label, src, needle, before, after) {
  const i = src.indexOf(needle);
  out += '=== ' + label + ' (idx ' + i + ') ===\n';
  out += (i >= 0 ? src.slice(Math.max(0, i - before), i + after) : '(NOT FOUND)') + '\n\n';
}
out += '=== renderer refs to shimmed APIs ===\n';
const HL = h.split(/\r?\n/);
for (let i = 0; i < HL.length; i++) if (/API\.(startAutomation|stopAutomation|runControl|onAutomationEvent)/.test(HL[i])) out += (i + 1) + ': ' + HL[i].trim().slice(0, 140) + '\n';
out += '\n';
seg('handleRunEvent', h, 'function handleRunEvent', 0, 2600);
out += '=== updateRunStats callers ===\n';
for (let i = 0; i < HL.length; i++) if (/updateRunStats\(/.test(HL[i])) out += (i + 1) + ': ' + HL[i].trim().slice(0, 120) + '\n';
out += '\n=== runTotal / runStartTime refs ===\n';
for (let i = 0; i < HL.length; i++) if (/runTotal|runStartTime/.test(HL[i])) out += (i + 1) + ': ' + HL[i].trim().slice(0, 130) + '\n';
out += '\n=== preload shim exports (contextBridge keys mentioning shim routes) ===\n';
const PL = p.split(/\r?\n/);
for (let i = 0; i < PL.length; i++) if (/startAutomation|stopAutomation|runControl|onAutomationEvent|shim/i.test(PL[i])) out += (i + 1) + ': ' + PL[i].trim().slice(0, 140) + '\n';
fs.writeFileSync(path.join(__dirname, '_r11-dump2.txt'), out, 'utf8');
console.log('written', out.length);
