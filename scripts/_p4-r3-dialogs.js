// _p4-r3-dialogs.js — Phase 4 R3: per-step dialog checkboxes on action steps (click,
// type, select, checkbox, navigate). Armed BEFORE the action, handles CHAINED dialogs
// (stays armed for the whole step), harmless on zero dialogs, disarmed in finally.
// Handle Dialog auto-migrates by folding into the NEXT action step — the plan text said
// "previous" but the step's actual semantics arm the FUTURE dialog (golden flow places
// dialog steps before their triggering clicks); folding backward would break every flow.
// Deviation flagged in TODO. Engine keeps the legacy 'dialog' case as a backstop.
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

// ── engine/steps.js: arm/disarm around the switch ──
const sp = path.join(root, 'src', 'engine', 'steps.js');
let s = fs.readFileSync(sp, 'utf8');
if (!s.includes('_r3Handler')) {
  s = repRx(s, /(async function runStep\(page, step, row, creds\)\{[^\n]*\r?\n)/, [
    '$1',
    '  // R3: per-step dialog checkboxes on action steps. Armed BEFORE the action so even a',
    '  // dialog fired mid-action is handled; stays armed for the WHOLE step (chained dialogs);',
    '  // harmless when no dialog fires; never blocks; always disarmed in the finally below.',
    "  // Mutually exclusive accept/decline — accept wins if a hand-edited flow sets both.",
    '  let _r3Handler = null;',
    "  if ((step.dialogAccept || step.dialogDecline) && { click:1, type:1, select:1, checkbox:1, navigate:1 }[step.type]) {",
    '    const _accept = !!step.dialogAccept;',
    '    _r3Handler = async function(dialog){ try { if (_accept) await dialog.accept(); else await dialog.dismiss(); } catch (e) {} };',
    "    page.on('dialog', _r3Handler);",
    '  }',
    '  try {',
    ''
  ].join('\n'), 'arm block');
  s = repRx(s, /(\r?\n  \})(\r?\n\})(\r?\nif \(typeof module)/, [
    '$1',
    '  } finally {',
    "    if (_r3Handler) { try { page.off('dialog', _r3Handler); } catch (e) {} }",
    '  }',
    '}$3'
  ].join('\n'), 'finally block');
  fs.writeFileSync(sp, s, 'utf8');
  console.log('steps done');
} else console.log('steps already done');

// ── index.html: dialogBlock fragment + 5 editors + migration + button removal ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('function dialogBlock')) {
  h = rep(h, 'function bodyHTML(s) {', [
    '// R3: shared dialog-checkbox fragment for action steps (click/type/select/checkbox/navigate).',
    '// Mutually exclusive; armed before the action; chained dialogs during the step are handled.',
    'function dialogBlock(s){',
    "  return '<div class=\"row\"><div class=\"fg\"><label style=\"cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600\"><input type=\"checkbox\" ' + (s.dialogAccept?'checked':'') + ' onchange=\"u(' + s.id + ',\\'dialogAccept\\',this.checked);if(this.checked)u(' + s.id + ',\\'dialogDecline\\',false);renderSteps()\" style=\"width:15px;height:15px;cursor:pointer\"/>Auto-accept browser dialog</label></div>'",
    "    + '<div class=\"fg\"><label style=\"cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600\"><input type=\"checkbox\" ' + (s.dialogDecline?'checked':'') + ' onchange=\"u(' + s.id + ',\\'dialogDecline\\',this.checked);if(this.checked)u(' + s.id + ',\\'dialogAccept\\',false);renderSteps()\" style=\"width:15px;height:15px;cursor:pointer\"/>Auto-decline browser dialog</label><div class=\"hint\">Armed before the action; handles chained dialogs fired during this step; harmless if none fire.</div></div></div>';",
    '}',
    '',
    'function bodyHTML(s) {'
  ].join('\n'), 'dialogBlock fn');
  // append to the five action editors
  let n = 0;
  h = h.replace(/\+ findByTextBlock\(s\);/g, m => { n++; return '+ findByTextBlock(s) + dialogBlock(s);'; });
  if (n !== 3) throw new Error('findByTextBlock tails: expected 3, got ' + n);
  h = rep(h, "Turn off after debugging.</div></div></div>';", "Turn off after debugging.</div></div></div>' + dialogBlock(s);", 'click tail');
  h = rep(h, ' value="none">No wait</option></select></div></div>\';', ' value="none">No wait</option></select></div></div>\' + dialogBlock(s);', 'navigate tail');
  // migration: fold Handle Dialog forward into the next action step
  h = rep(h, "    for(const st of list){ if(st && st.type === 'ifclick'){ st.type = 'click'; st.notFound = 'skip'; st.presenceSec = st.presenceSec || 1; } }", [
    "    for(const st of list){ if(st && st.type === 'ifclick'){ st.type = 'click'; st.notFound = 'skip'; st.presenceSec = st.presenceSec || 1; } }",
    '    // R3: Handle Dialog folds into the NEXT action step (the step armed the FUTURE dialog;',
    '    // dialog steps sit before their triggering action — folding backward would break flows).',
    '    // dialogMatch has no checkbox equivalent and is dropped: per-step scoping replaces it.',
    '    // A trailing dialog step with no following action stays put (engine keeps a backstop).',
    '    const ACT = { click:1, type:1, select:1, checkbox:1, navigate:1 };',
    '    for(let i2 = 0; i2 < list.length; i2++){',
    "      const st2 = list[i2];",
    "      if(!st2 || st2.type !== 'dialog') continue;",
    '      let k2 = i2 + 1; while(k2 < list.length && !(list[k2] && ACT[list[k2].type])) k2++;',
    '      if(k2 >= list.length) continue;',
    "      if(st2.dialogAction === 'dismiss'){ list[k2].dialogDecline = true; list[k2].dialogAccept = false; }",
    '      else { list[k2].dialogAccept = true; list[k2].dialogDecline = false; }',
    '      list.splice(i2, 1); i2--;',
    '    }'
  ].join('\n'), 'dialog migration');
  h = repRx(h, /^.*addStep\('dialog'\).*\r?\n/m, '', 'dialog button');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done');
} else console.log('index already done');
