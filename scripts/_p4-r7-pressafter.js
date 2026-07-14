// _p4-r7-pressafter.js — Phase 4 R7: pressAfter on type steps.
// Dropdown (none default | Tab | Enter | Escape | ArrowDown | ArrowUp | Space); the key
// is pressed on the same element right after typing. Classic use: Tab to commit a field
// PestPac only validates on blur, Enter to fire a search box.
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

// ── engine ──
const sp = path.join(root, 'src', 'engine', 'steps.js');
let s = fs.readFileSync(sp, 'utf8');
if (!s.includes('pressAfter')) {
  s = rep(s, "if(delay>0) await loc.first().pressSequentially(val,{delay:delay}); else await loc.first().fill(val); break; }",
    "if(delay>0) await loc.first().pressSequentially(val,{delay:delay}); else await loc.first().fill(val); if(step.pressAfter && ['Tab','Enter','Escape','ArrowDown','ArrowUp','Space'].indexOf(step.pressAfter)>=0){ await loc.first().press(step.pressAfter==='Space'?' ':step.pressAfter); } /* R7 */ break; }", 'type case');
  fs.writeFileSync(sp, s, 'utf8');
  console.log('engine done');
} else console.log('engine already done');

// ── editor ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('pressAfter')) {
  const dd = " + '<div class=\"fg\"><label>Press key after typing</label><select onchange=\"u(' + s.id + ',\\'pressAfter\\',this.value)\">"
    + "<option ' + (!s.pressAfter?'selected':'') + ' value=\"\">None (default)</option>"
    + "<option ' + (s.pressAfter==='Tab'?'selected':'') + ' value=\"Tab\">Tab</option>"
    + "<option ' + (s.pressAfter==='Enter'?'selected':'') + ' value=\"Enter\">Enter</option>"
    + "<option ' + (s.pressAfter==='Escape'?'selected':'') + ' value=\"Escape\">Escape</option>"
    + "<option ' + (s.pressAfter==='ArrowDown'?'selected':'') + ' value=\"ArrowDown\">Arrow down</option>"
    + "<option ' + (s.pressAfter==='ArrowUp'?'selected':'') + ' value=\"ArrowUp\">Arrow up</option>"
    + "<option ' + (s.pressAfter==='Space'?'selected':'') + ' value=\"Space\">Space</option>"
    + "</select><div class=\"hint\">Pressed on the same field right after typing — e.g. Tab to commit a value PestPac only validates on blur.</div></div>'";
  // the delay field sits inside the same string literal — break the string to splice in
  h = rep(h, "</select></div><div class=\"fg\"><label>Typing delay (ms/char)</label>",
    "</select></div>'" + dd + " + '<div class=\"fg\"><label>Typing delay (ms/char)</label>", 'editor insert');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('editor done');
} else console.log('editor already done');
