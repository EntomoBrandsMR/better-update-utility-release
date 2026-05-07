# v1.2.6 — Iframe-aware selectors (hotfix)

Hotfix for a failure mode discovered after v1.2.5 shipped. Single-issue release.

## What was broken

PestPac renders form pages and modal dialogs (e.g., the attach-to-lead "No" confirmation that pops up after saving a service order) inside iframes. Playwright's selector lookups in v1.2.5 only checked the top frame, so any click/type/select/etc. step targeting an in-iframe element would stall for 30 seconds (selector timeout) and fail.

This was particularly insidious because the same selector worked fine when tested manually in DevTools — DevTools' console auto-scopes to the active frame, masking the issue. Took an hour of diagnostic theorizing before the runtime debug dump showed the truth: the modal lived in a third iframe (`app.pestpac.com/dialog/LocationLeads.asp`), separate from both the top frame and the form's iframe.

## What changed

**Automatic iframe traversal.** Every selector-based step (click, type, select, checkbox, clear, wait, assert) now walks the top frame first, then every iframe, and operates on whichever frame contains the match. Zero overhead when the match IS in the top frame; ~10–30ms per step otherwise. Existing flows just start working — no flow changes needed.

**Click-step debug checkbox kept as permanent feature.** The checkbox originally added in the v1.2.5-debug1 internal-only build is now shipping. When checked, the runner dumps Playwright's view of the selector to the runner.log: top-frame match count, visibility, bounding box, and a full iframe scan showing which frames contain matches. Useful when a click stalls or fails for unclear reasons.

**Better error message** when a selector genuinely doesn't match anywhere. v1.2.5's failure said "Timeout 30000ms exceeded waiting for locator." v1.2.6 says: `Selector "X" not found in any frame after 30000ms. Frames searched: [...list of frame URLs...]` — actionable, tells you exactly where to look.

## What's NOT changed

Auto-update, resume, retry-failed, network-aware retry, re-auth, circuit breaker, Excel log enrichment, defaults, settings — all continue from v1.2.5 unchanged.

## Compatibility

Existing flows, profiles, credentials carry over unchanged. Steps that previously stalled in v1.2.5 should now succeed without modification.

## Stats

2 commits since v1.2.5. ~180 lines added in `src/main.js`, ~1 line changed in `src/index.html` (debug checkbox label).
