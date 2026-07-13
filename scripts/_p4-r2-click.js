// _p4-r2-click.js — Phase 4 R2: UNIFIED CLICK. Three sections defaulted to current
// behavior (when-to-act + per-step wait timeout; if-not-found error|skip w/ presence
// window; after-click none|element|url|load). Absorbs If-click (auto-migrated at flow
// load + legacy engine alias so unmigrated flows can never silently no-op). Legacy
// step.waitFor honored as after=element — existing Click steps run unchanged.
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

// ── engine/locate.js: per-step timeout param (default preserves behavior) ──
const lp = path.join(root, 'src', 'engine', 'locate.js');
let l = fs.readFileSync(lp, 'utf8');
if (!l.includes('R2: optional per-step timeout')) {
  l = rep(l, 'async function resolveStepLocator(page, step, resolveFn){',
    '// R2: optional per-step timeout (ms). Omitted -> pool-wide SELECTOR_TIMEOUT (pre-R2 behavior).\nasync function resolveStepLocator(page, step, resolveFn, timeoutMs){\n  const _t = (timeoutMs && isFinite(timeoutMs)) ? timeoutMs : SELECTOR_TIMEOUT;', 'rsl signature');
  l = rep(l, "return await findInContainer(page, step.containerSel || '', matchResolved, step.selector || '', step.matchMode || 'contains', {timeout: SELECTOR_TIMEOUT});",
    "return await findInContainer(page, step.containerSel || '', matchResolved, step.selector || '', step.matchMode || 'contains', {timeout: _t});", 'rsl findInContainer');
  l = repRx(l, /return await findLocator\(page, step\.selector, \{timeout: SELECTOR_TIMEOUT\}\);(\r?\n\})/,
    'return await findLocator(page, step.selector, {timeout: _t});$1', 'rsl findLocator');
  fs.writeFileSync(lp, l, 'utf8');
  console.log('locate done');
} else console.log('locate already done');

// ── engine/steps.js: unified click replaces click + ifclick ──
const sp = path.join(root, 'src', 'engine', 'steps.js');
let s = fs.readFileSync(sp, 'utf8');
if (!s.includes('R2 UNIFIED CLICK')) {
  const newClick = [
    "    // R2 UNIFIED CLICK — three sections, all defaulted to pre-R2 behavior:",
    "    //   When to act: 'appears' (default) | 'enabled'; waitTimeoutSec overrides the",
    "    //     pool-wide SELECTOR_TIMEOUT for THIS step when set (kills the hardcoded 30s).",
    "    //   If not found: 'error' (default) | 'skip' — skip probes within presenceSec",
    "    //     (default 1s) and continues, recording the branch on the row (absorbs If-click).",
    "    //   After click: 'none' (default) | 'element' | 'url' | 'load'. Legacy step.waitFor",
    "    //     is honored as after='element', so pre-R2 Click steps run unchanged unmigrated.",
    "    case 'ifclick': step = Object.assign({}, step, { type:'click', notFound:'skip' }); // legacy alias — falls through",
    "    case 'click':{",
    "      const waitMs = (step.waitTimeoutSec != null && step.waitTimeoutSec !== '' && isFinite(parseFloat(step.waitTimeoutSec)))",
    "        ? Math.max(250, Math.round(parseFloat(step.waitTimeoutSec)*1000)) : SELECTOR_TIMEOUT;",
    "      const notFound = step.notFound === 'skip' ? 'skip' : 'error';",
    "      let loc = null;",
    "      if(notFound === 'skip'){",
    "        const presenceMs = Math.max(250, Math.round(parseFloat(step.presenceSec||1)*1000));",
    "        try{ loc = await findLocator(page, step.selector, {timeout: presenceMs}); }catch(e){ loc = null; }",
    "        if(loc){ try{ await loc.first().waitFor({state:'visible', timeout: Math.max(1000, presenceMs)}); }catch(e){ loc = null; } }",
    "        if(!loc){ row.__stepNote = 'not present'; break; }",
    "        row.__stepNote = 'clicked';",
    "      } else {",
    "        loc = await resolveStepLocator(page, step, r, waitMs);",
    "        await loc.first().waitFor({state:'visible', timeout: waitMs});",
    "      }",
    "      if(step.whenMode === 'enabled'){",
    "        const _end = Date.now() + waitMs;",
    "        while(true){",
    "          let _en = false; try{ _en = await loc.first().isEnabled(); }catch(e){}",
    "          if(_en) break;",
    "          if(Date.now() >= _end) throw new Error('element never became enabled within '+waitMs+'ms');",
    "          await page.waitForTimeout(150);",
    "        }",
    "      }",
    "      await loc.first().click();",
    "      const after = step.after || (step.waitFor ? 'element' : 'none');",
    "      if(after === 'element'){",
    "        const _sel = step.afterSelector || step.waitFor;",
    "        if(_sel){ const wl = await findLocator(page, _sel, {timeout: waitMs}); await wl.first().waitFor({state:'visible', timeout: waitMs}); }",
    "      } else if(after === 'url'){",
    "        const _u0 = page.url();",
    "        await page.waitForURL(u => u.toString() !== _u0, {timeout: waitMs});",
    "      } else if(after === 'load'){",
    "        await page.waitForLoadState('load', {timeout: waitMs});",
    "      }",
    "      break;",
    "    }"
  ].join('\n');
  s = repRx(s, /    case 'click':\{[^\n]*\r?\n/, newClick + '\n', 'click case');
  s = repRx(s, /    case 'ifclick':\{\r?\n[\s\S]*?\r?\n    \}\r?\n/, '', 'ifclick case');
  fs.writeFileSync(sp, s, 'utf8');
  console.log('steps done');
} else console.log('steps already done');

// ── index.html: editor + migration + button removal ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (!h.includes('migrateLoadedSteps')) {
  // add-step button
  h = repRx(h, /^.*addStep\('ifclick'\).*\r?\n/m, '', 'ifclick button');
  // click editor: three sections (replaces the whole old click branch line)
  const clickEd = "  if(s.type==='click') return '<div class=\"row\">' + selField(s.id,'selector',s.selector||'','button[type=\"submit\"]','CSS selector')"
    + " + '<div class=\"fg\"><label>When to act</label><select onchange=\"u(' + s.id + ',\\'whenMode\\',this.value)\"><option ' + (!s.whenMode||s.whenMode==='appears'?'selected':'') + ' value=\"appears\">When element appears</option><option ' + (s.whenMode==='enabled'?'selected':'') + ' value=\"enabled\">Wait until enabled</option></select></div>'"
    + " + '<div class=\"fg\"><label>Wait timeout (seconds)</label><input type=\"number\" value=\"' + (s.waitTimeoutSec||'') + '\" min=\"0.25\" step=\"0.25\" placeholder=\"pool default\" oninput=\"u(' + s.id + ',\\'waitTimeoutSec\\',this.value)\"/><div class=\"hint\">Blank = the pool-wide element wait. Set per step to wait longer (slow pages) or shorter.</div></div></div>'"
    + " + '<div class=\"row\"><div class=\"fg\"><label>If not found</label><select onchange=\"u(' + s.id + ',\\'notFound\\',this.value);renderSteps()\"><option ' + (s.notFound!=='skip'?'selected':'') + ' value=\"error\">Error (default)</option><option ' + (s.notFound==='skip'?'selected':'') + ' value=\"skip\">Skip and continue</option></select></div>'"
    + " + (s.notFound==='skip' ? '<div class=\"fg\"><label>Presence window (seconds)</label><input type=\"number\" value=\"' + (s.presenceSec||1) + '\" min=\"0.25\" step=\"0.25\" oninput=\"u(' + s.id + ',\\'presenceSec\\',this.value)\"/><div class=\"hint\">If the element appears within this window it gets clicked; otherwise the flow continues. The branch taken is logged per row.</div></div>' : '') + '</div>'"
    + " + '<div class=\"row\"><div class=\"fg\"><label>After click</label><select onchange=\"u(' + s.id + ',\\'after\\',this.value);renderSteps()\"><option ' + ((s.after||(s.waitFor?'element':'none'))==='none'?'selected':'') + ' value=\"none\">Nothing (default)</option><option ' + ((s.after||(s.waitFor?'element':'none'))==='element'?'selected':'') + ' value=\"element\">Wait for element</option><option ' + (s.after==='url'?'selected':'') + ' value=\"url\">Wait for URL change</option><option ' + (s.after==='load'?'selected':'') + ' value=\"load\">Wait for next page load</option></select></div>'"
    + " + ((s.after||(s.waitFor?'element':'none'))==='element' ? '<div class=\"fg\"><label>Element to wait for</label><div class=\"sel-wrap\"><input type=\"text\" id=\"fi-' + s.id + '-afterSelector\" value=\"' + esc(s.afterSelector||s.waitFor) + '\" placeholder=\".success-toast\" oninput=\"u(' + s.id + ',\\'afterSelector\\',this.value)\" onfocus=\"pendingInsertId=' + s.id + ';pendingInsertField=\\'afterSelector\\'\"/><button class=\"paste-btn\" onclick=\"openPasteModal(' + s.id + ',\\'afterSelector\\')\">Paste HTML</button></div></div>' : '') + '</div>'"
    + " + findByTextBlock(s) + '<div class=\"row\"><div class=\"fg\"><label style=\"cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;color:var(--amber)\"><input type=\"checkbox\" ' + (s.debugClick?'checked':'') + ' onchange=\"u(' + s.id + ',\\'debugClick\\',this.checked)\" style=\"width:16px;height:16px;cursor:pointer\"/>\\ud83d\\udc1b Debug this click step</label><div class=\"hint\">Dumps Playwright\\'s view of the selector to runner.log before attempting it. Turn off after debugging.</div></div></div>';";
  h = repRx(h, /^  if\(s\.type==='click'\) return .*\r?\n/m, clickEd + '\n', 'click editor');
  h = repRx(h, /^  if\(s\.type==='ifclick'\) return .*\r?\n/m, '', 'ifclick editor');
  // migration at flow load
  h = rep(h, '  steps = data.steps || [];', [
    '  steps = migrateLoadedSteps(data.steps || []);',
    '  // R2: If-click is absorbed into the unified Click. Migrate on load; the flow persists',
    '  // migrated on its next save. (The engine also keeps a legacy alias as a backstop.)',
    '  function migrateLoadedSteps(list){',
    "    for(const st of list){ if(st && st.type === 'ifclick'){ st.type = 'click'; st.notFound = 'skip'; st.presenceSec = st.presenceSec || 1; } }",
    '    return list;',
    '  }'
  ].join('\n'), 'migration');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done');
} else console.log('index already done');
