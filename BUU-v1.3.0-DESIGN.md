# BUU v1.3.0 — Design & Implementation Record

**Status:** Implementation complete 2026-05-20. All 11 items applied and validated.
**Type:** Polish + bug-fix release (no architectural change).
**Predecessor:** v1.2.9.

---

## STANDING CONTEXT (always true — do not re-ask)

- **Matthew is the only user of BUU right now.** Sole operator, no other install in the field.
  Shipping a release does not risk other people's work. Do NOT propose "hold the release so
  others aren't affected" — there are no others. When Matthew says ship, ship the whole way
  (bump, commit, tag, push, AND publish the GitHub release). He tests on his own machine after
  the fact and is fine with auto-update offering him the new version.
- **Workflow:** diff-by-diff sign-off on non-trivial changes; tests after push, not during the
  session; prefers brutal honesty over softened status.
- This block is intentionally duplicated in DESIGN-INDEX.md so any fresh session sees it.

---

## The 11 items (all shipped in 1.3.0)

| # | Item | Where | Validated |
|---|------|-------|-----------|
| 1 | Find-by-text selector (pick one of several look-alike items) | main.js runner + index.html | runner template parses all 3 modes |
| 2 | Drag scoped to handle (text selection in step fields works) | index.html | — |
| 3 | Stop/restart diagnostic hardening + idempotent runStopped + 5s safety timer | main.js + index.html | — |
| 3a | Verification panel persists between steps (no flicker) | index.html | — |
| 4 | Toolbar Run button doubles as "Open last log" when idle | index.html | — |
| 5 | Dialog steps skip the step-mode pause | main.js runner | runner template |
| 6 | UI size bump +5 | index.html CSS | — |
| 7 | Verify logs in step mode | test-only, no code | — |
| 8 | `{{token}}` brace-pair validation at save | index.html | — |
| 9 | Setup/teardown participate in step mode (no new mode) | main.js runner + index.html | runner template |
| 10 | `perMachine: true` taskbar-pin experiment | package.json | NOT statically validatable — see POST-PUSH-NOTES.md |
| 11 | Remove vestigial Pause button | index.html | — |

Items 12 (per-step on-fail flows) and 13 (file-upload step) were explicitly deferred — not in 1.3.0.

---

## Locked decisions

### Item 6 — UI bump sizes (+5, locked via mockup preview 2026-05-20)
- body 13→18, inputs/select/textarea 12→17, .step-desc 12→17, .hint 10→15
- .badge 10→15 (padding 2×8 → 4×11), .step-n 22px/10px → 28px/14px, .paste-btn 11→15
- CSS-only. Inline locked-login label also bumped 10→15 for consistency.

### Item 9 — setup/teardown in step mode (simpler approach, locked)
No new start mode. The existing "Step through each step" mode now pauses before every step in
EVERY phase (setup, main, teardown). Rejected the original `step-everything` fourth-mode design
as unnecessary UI. `runOnceFlow()` gained the same pause-and-wait main's row loop uses; the
`pause-step` event carries `phase` so the renderer labels it "Setup · step X" / "Teardown · step X".

### Item 1 — find-by-text (locked via Q&A 2026-05-20)
- Problem: many look-alike items on a page (open service orders, batches, rows); act on the one
  matching the current row's data.
- Always acts on something INSIDE the matched container (the existing selector = target inside row).
- Match text is a normal token field (token or literal — same as every value field).
- Match mode dropdown: contains/exact/starts/ends (trimmed), contains-ci, exact-ci, regex.
- Zero or >1 container match = row FAILS (BUU never guesses). Iframe-aware via the same frame walk.
- Available on click, type, select, checkbox, clear, assert.

### Item 3 — stop/restart hardening (locked)
- console.log/warn instrumentation at every state transition (`[main]` and `[run]` prefixes).
- 5-second safety timer in requestStop() forces runStopped() if clean exit doesn't fire.
- runStopped() made idempotent (short-circuits if already idle); also resets currentRunMode
  and phase-indicator pips that previously leaked across runs.

### Item 11 — Pause button removed
Was wired to API.pauseRun/resumeRun which were never exposed; the runner has no pause command.
The button did nothing. Stop already provides graceful safe-boundary halt. Removed entirely
(state var, function, all 6 call sites). May return as a real feature later.

### Item 10 — perMachine experiment
Flipped package.json build.nsis.perMachine false→true. EXPERIMENTAL. Full risk analysis and a
6-step build/install/update test procedure live in POST-PUSH-NOTES.md. One-line revert if it
regresses installation. Does not block the other 10 items.

---

## Validation performed (static, in-session)
- `scripts/_validate-runner.js` → runner template parses clean in all 3 modes (run-all, step,
  step-row) after every runner-template edit (Items 1, 5, 9).
- `scripts/_check-html-js.js` → index.html embedded script parses clean.
- `node --check src/main.js` → clean.
- package.json → valid JSON after perMachine flip.

Static validation does NOT cover: actual runtime behavior, the perMachine install cycle, or the
UI rendering. Those are Matthew's post-push tests.

## Suggested post-push tests
1. Find-by-text: build a flow with a find-by-text click on a page with several look-alike rows;
   confirm it targets the right one and fails cleanly on 0/multiple matches.
2. Step mode through setup/teardown: confirm pause panel labels "Setup · step X" / "Teardown · step X".
3. Pause button gone; text selectable in step fields; drag-reorder still works via the handle.
4. Brace validation: type "{{Name}" in a value field, confirm the step flags an error.
5. UI bump readable.
6. Toolbar Run button shows "Open last log" after a run with no flow loaded.
7. Item 10 install/update/pin cycle per POST-PUSH-NOTES.md.

---

## END
