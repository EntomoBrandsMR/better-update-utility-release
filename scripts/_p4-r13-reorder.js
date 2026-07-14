// _p4-r13-reorder.js — Phase 4 R13: step reorder ▲/▼ buttons.
// mv() existed but nothing rendered buttons for it. Buttons live in the step-acts strip,
// disabled at the ends of the MOVABLE range (locked login steps don't count — and mv()
// gains a locked-neighbor guard so a swap can never displace a locked step). Same
// mutation path as drag (markFlowDirty + renderSteps). Drag auto-scroll already exists
// (v2.1.1 bug J) — verified in source, nothing to add there.
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
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('Move up')) {
  h = rep(h, 'function mv(e,id,d) { e.stopPropagation(); const i=steps.findIndex(s=>s.id===id); const ni=i+d; if(ni<0||ni>=steps.length)return; [steps[i],steps[ni]]=[steps[ni],steps[i]]; markFlowDirty(); renderSteps(); }',
    'function mv(e,id,d) { e.stopPropagation(); const i=steps.findIndex(s=>s.id===id); const ni=i+d; if(ni<0||ni>=steps.length)return; if(steps[ni]&&steps[ni].locked)return; [steps[i],steps[ni]]=[steps[ni],steps[i]]; markFlowDirty(); renderSteps(); }', 'mv guard');
  h = repRx(h, /(          : '<div class="step-acts">' \+\r?\n)(              '<span class="drag-handle")/, [
      "          : '<div class=\"step-acts\">' +",
      "              // R13: ▲/▼ reorder — disabled at the ends of the MOVABLE range (locked",
      "              // login steps don't count as neighbors you can displace).",
      "              '<button class=\"ibtn\" onclick=\"mv(event,' + s.id + ',-1)\" title=\"Move up\"' + ((i===0 || (steps[i-1]&&steps[i-1].locked)) ? ' disabled style=\"opacity:.25;pointer-events:none\"' : '') + '><svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"width:12px;height:12px\"><path d=\"M8 12V4M4.5 7.5 8 4l3.5 3.5\"/></svg></button>' +",
      "              '<button class=\"ibtn\" onclick=\"mv(event,' + s.id + ',1)\" title=\"Move down\"' + ((i===steps.length-1 || (steps[i+1]&&steps[i+1].locked)) ? ' disabled style=\"opacity:.25;pointer-events:none\"' : '') + '><svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" style=\"width:12px;height:12px\"><path d=\"M8 4v8M4.5 8.5 8 12l3.5-3.5\"/></svg></button>' +",
      "              '<span class=\"drag-handle\""
    ].join('\n'), 'buttons');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('done');
} else console.log('already done');
