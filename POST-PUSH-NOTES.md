# v1.2.5 POST-PUSH NOTES

Things to verify after first install / first run / discuss with Matthew before or after ship.

## Items to validate post-ship (per design doc Section 6)

These cannot be tested before ship — they need a live PestPac session and/or real network conditions:

- **2.4** stop-from-pause regression — verification mode run, Stop from pause panel, click Run again immediately. Should accept the new run, not bounce with "automation already running."
- **2.11 timer-based re-auth** — set interval to ~30 minutes for first observation. Confirm re-auth event appears in log, run continues cleanly across the boundary.
- **2.11 detection-based re-auth** — manually clear PestPac cookies via DevTools mid-run. Confirm next navigation triggers re-auth, row continues.
- **2.8 network-aware retry** — disconnect WiFi during run. Confirm wait-and-ping loop activates, heartbeat shows `waiting-for-internet` phase. Reconnect; row should retry cleanly.
- **2.10 error categorization** — induce known errors (bad selector, empty token cell, disconnect WiFi). Confirm log columns populate correctly.
- **2.12 retry-failed** — complete a small run with intentional failures. Click Retry. Confirm only failed rows re-attempted, separate log file written.

## Implementation deviations / open questions surfaced during impl

### Item 2.8 — selector timeout default drop is the riskiest change in v1.2.5

The default selector timeout drops from 15s (hardcoded in v1.2.4) to 5s (configurable, but defaulting low). For most PestPac flows on a healthy network this is fine — selectors typically resolve in <1s. But:

- PestPac has slow days where individual selectors can take 6-10 seconds to render (modal animations, lazy-loaded React components, server lag during peak hours).
- Saved flows from before v1.2.5 don't carry a `selectorTimeout` field, so they pick up the new 5s default automatically — no migration prompt.
- A flow that worked at 15s but fails at 5s will start producing "TimeoutError: waiting for selector ..." errors that look like flow bugs but are actually environmental.

**Watch the first real run carefully.** If you see a sudden cluster of selector-timeout errors that weren't there before, raise the global Selector timeout to 10s or 15s on the Build steps page Run settings. The setting persists per-flow once saved.

If the new defaults regress a known-good flow, that's reportable as a bug and we adjust defaults in v1.2.6. The doc said to ship at 5s; we did. But this is the field that's most likely to bite.

### Item 2.8 — `_validate-runner.js` is gitignored

The validator script in `scripts/_validate-runner.js` is gitignored (the whole `scripts/` folder is). This means changes to it don't ship with the repo. I updated it for the new buildRunner signature (3 new args) but those changes are local-only. If anyone clones the repo fresh, they'll need to recreate the script's arg list to match the current buildRunner signature. Worth either un-ignoring this one helper, or documenting the expected sample-args shape somewhere persistent.

### Item 2.3 — Live UI says "FAILED" / status='error' for retry-then-skip rows

The runner now writes `status='skip'` to the Excel log for rows that hit the retry-failed catch (per design — these are skip outcomes, not errors). However the runner still emits `type:'row-error'` to the renderer, so the live log shows "❌ Row N FAILED: Retry failed: ..." and the in-session log table shows `status:'error'`. The persisted Excel log is correct; only the live UI is misleading.

Fix deferred to **item 2.10** (error log enrichment) where we'll revisit the emit shape and live-UI presentation together. Out of scope for 2.3.

### Item 2.5 (Import-side) — `removeCol` orphaned, no-impact

Old Import chips had a ✕ button to remove a column from the displayed list. The design doc didn't address this. Decision: removed the ✕ along with the click-to-copy behavior; `removeCol()` function stays in source but is unreachable from UI. If users miss the ability to hide columns from the Import page, we can add it back.

### Item 2.5 (Import-side) — header text forward-references drag

The new Import-page header reads "Detected columns — drag from any step's chip strip to insert as a token." Drag behavior is Phase 5 (Build-side). Between Phase 2 ship and Phase 5 ship there's a brief gap where the message promises behavior that doesn't fully exist yet (Build chips are still old click-broken behavior). Verify after Phase 5 lands that the wording is accurate. Acceptable for a single-PR ship; flag if we ever break Phase 5 across multiple ships.

## Things I noticed but didn't change (potential future cleanups)

- `src/main.js` line 16 comment says "v1.3.0 will lift this cap" referring to `MAX_CONCURRENT_RUNS`. Multi-runner moved to BUUA. Update this comment when in the area for item 2.3b (Phase 3).
