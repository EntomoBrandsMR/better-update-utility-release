// engine/locate.js — selector resolution + find-by-text stack. SINGLE SOURCE,
// interpolated VERBATIM into the pool worker child script (${LOCATE_STACK_SRC}).
// NOTE: resolveStepLocator references SELECTOR_TIMEOUT, a global the worker
// template defines before this file is inlined. The guarded exports below are
// for tests/tooling; main process has no native callers today.
// (Extracted verbatim from v2.2.2 FIND_LOCATOR/MATCHES_TEXT/FIND_IN_CONTAINER/
//  RESOLVE_STEP_LOCATOR string constants — Phase 2 refactor, 2026-07-10.)
async function findLocator(page, selector, opts){
  opts = opts || {};
  const timeoutMs = opts.timeout || 30000;
  const pollMs = 250;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // Top frame first (most common; cheapest path).
    try {
      const top = page.locator(selector);
      if (await top.count() > 0) return top;
    } catch (_) {}
    // Walk every iframe. page.frames() includes the main frame, so skip it.
    const main = page.mainFrame();
    for (const f of page.frames()) {
      if (f === main) continue;
      try {
        const inFrame = f.locator(selector);
        if (await inFrame.count() > 0) return inFrame;
      } catch (_) {
        // Cross-origin frames throw on access; skip silently.
      }
    }
    // Not found yet — wait briefly and re-scan.
    await new Promise(function(r){ setTimeout(r, pollMs); });
  }
  // Final attempt with detailed error so the user knows where to look.
  const frameInfo = page.frames().map(function(f){ return f.url() || '(blank)'; }).join(', ');
  throw new Error('Selector "' + selector + '" not found in any frame after ' + timeoutMs + 'ms. Frames searched: [' + frameInfo + ']');
}

function matchesText(haystack, needle, mode){
  var h = (haystack == null ? '' : String(haystack));
  var n = (needle == null ? '' : String(needle));
  switch(mode || 'contains'){
    case 'exact':       return h.trim() === n.trim();
    case 'starts':      return h.trim().indexOf(n.trim()) === 0;
    case 'ends':        { var ht = h.trim(), nt = n.trim(); return nt.length <= ht.length && ht.lastIndexOf(nt) === (ht.length - nt.length); }
    case 'contains-ci': return h.trim().toLowerCase().indexOf(n.trim().toLowerCase()) !== -1;
    case 'exact-ci':    return h.trim().toLowerCase() === n.trim().toLowerCase();
    case 'regex':
      try { return new RegExp(n).test(h); }
      catch(e){ throw new Error('Find-by-text regex invalid: ' + n + ' — ' + e.message); }
    case 'contains':
    default:            return h.trim().indexOf(n.trim()) !== -1;
  }
}

async function findInContainer(page, containerSel, matchText, targetSel, mode, opts){
  opts = opts || {};
  var timeoutMs = opts.timeout || 30000;
  var pollMs = 250;
  var startedAt = Date.now();
  var lastSeenCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    var frames = [page.mainFrame()];
    for (var fi = 0; fi < page.frames().length; fi++) {
      if (page.frames()[fi] !== page.mainFrame()) frames.push(page.frames()[fi]);
    }
    var matched = [];
    for (var k = 0; k < frames.length; k++) {
      var f = frames[k];
      var containers;
      try { containers = f.locator(containerSel); } catch(e){ continue; }
      var count;
      try { count = await containers.count(); } catch(e){ continue; }
      for (var ci = 0; ci < count; ci++) {
        var txt = '';
        try { txt = await containers.nth(ci).innerText({timeout: 2000}); }
        catch(e){
          try { txt = await containers.nth(ci).textContent({timeout: 2000}) || ''; } catch(e2){ txt = ''; }
        }
        if (matchesText(txt, matchText, mode)) {
          matched.push({ frame: f, index: ci });
        }
      }
      lastSeenCount += count;
    }
    if (matched.length === 1) {
      var m = matched[0];
      var containerLoc = m.frame.locator(containerSel).nth(m.index);
      if (!targetSel) return containerLoc;
      return containerLoc.locator(targetSel);
    }
    if (matched.length > 1) {
      throw new Error('Find-by-text matched ' + matched.length + ' containers for "' + matchText + '" (mode: ' + (mode||'contains') + '). Expected exactly 1. Make the match text more specific or narrow the container selector — BUU will not guess which one.');
    }
    await new Promise(function(r){ setTimeout(r, pollMs); });
  }
  throw new Error('Find-by-text found no container matching "' + matchText + '" (mode: ' + (mode||'contains') + ') in selector "' + containerSel + '" after ' + timeoutMs + 'ms. Containers seen during scan: ' + lastSeenCount + '. Check the match text/column value and the container selector.');
}

async function resolveStepLocator(page, step, resolveFn){
  if (step.findByText) {
    var matchResolved = resolveFn(step.matchText || '');
    return await findInContainer(page, step.containerSel || '', matchResolved, step.selector || '', step.matchMode || 'contains', {timeout: SELECTOR_TIMEOUT});
  }
  return await findLocator(page, step.selector, {timeout: SELECTOR_TIMEOUT});
}
if (typeof module !== "undefined" && module.exports) { module.exports = { findLocator, matchesText, findInContainer, resolveStepLocator }; }
