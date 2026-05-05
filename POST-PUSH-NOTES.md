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

### Item 2.3b — circuit breaker ships with minimal checkpoint preservation; full resume UX deferred to 2.7

The breaker correctly preserves the checkpoint when it trips (skips the `unlinkSync(CHECKPOINT)` in the `finally` block when `_breakerTripped` is true). On the next launch, the existing v1.2.3 resume-on-launch logic will detect the orphan checkpoint and prompt to resume from the last `rowIndex`.

**What works today:**
- Breaker counts only "real" failures (retry-exhausted + Skip-mode immediate skip). User-initiated `__NEXT_ROW__` skips don't count.
- Counter resets to 0 on any successful row.
- On trip: checkpoint annotated with `lastError: { phase: 'circuit-breaker', consecutiveErrors, lastSuccessfulRow, rowIndex, ts }`. Schema is forward-compatible with item 2.7.
- Live UI shows a clear status message and a follow-up alert dialog (so an unattended overnight job lands a visible signal in the morning).
- Resume path can read `breakerThreshold` from checkpoint to keep the same threshold across the resume.

**What's deferred to item 2.7 (Phase 6):**
- Resume modal currently shows the existing v1.2.3 prompt — "Last run stopped at row X. Resume from this row, or start fresh?" — not the richer 3-option modal the design specifies (Resume / Skip-and-resume / Start fresh, with explicit counts of failed rows).
- Resume currently re-attempts row X+1 onward; it doesn't re-attempt the cluster of failed rows that triggered the breaker. The 3-option modal in 2.7 will provide both behaviors as user choices.

If a breaker trip happens before 2.7 lands, the user gets correct minimum behavior (work preserved, can resume forward), just not the cluster-retry option. Acceptable.

### Item 2.8 — selector timeout default: 30s (deviated from design's 5s)

The design doc specified 5s as the new selector timeout default. Matthew opted for 30s instead (raised, not lowered, vs. v1.2.4's hardcoded 15s) to ensure no saved flows regress. Rationale:

- 5s is correct for healthy PestPac runs but risks regressing flows that depended on the historical 15s tolerance during slow PestPac days.
- The circuit breaker (item 2.3b) caps the worst case at 20 consecutive failures regardless of per-row timeout, so even if a flow hangs hard at 30s/row × 20 rows, that's ~10 minutes before the breaker stops the run. Acceptable.
- Field is configurable per-flow on the Run settings card, so users with confidence in their flows can lower it to 5s.

Defaults landed at 30s in:
- index.html input value attribute
- main.js `selectorTimeout` IPC fallback when value is null
- index.html `executeResume` checkpoint fallback for legacy v1 checkpoints
- _validate-runner.js test args use 5s deliberately (faster validator runs; not a runtime path)

If a future v1.2.6 wants to revisit this back toward the original 5s, treat it as a real product decision based on observed data, not a "fix."

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
