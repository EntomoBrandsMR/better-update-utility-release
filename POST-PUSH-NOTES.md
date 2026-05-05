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

### Item 2.10 (Phase 8, sub 3) — Excel writer rewrite: column order, auto-filter, "Stopped reason"

`flush()` was switched from `XLSX.utils.json_to_sheet(logEntries)` (auto-orders columns
by JSON key insertion order — unpredictable, untunable) to `XLSX.utils.aoa_to_sheet`
with explicit headers. The new column order matches the design:

```
Row | Status | Error category | Phase | Step # | Step type | Step label |
Field/selector | Attempted value | URL | Error message | Timestamp |
Failed step | Fields written | Duration (ms)
```

Most-actionable left, most-detailed right. Pivot-friendly. Applied to all three data
sheets: All rows / Errors only / Skipped.

**Auto-filter**: `ws['!autofilter']` is set with the full data range. SheetJS 0.18.5
community edition writes this correctly — confirmed via XML inspection of the produced
.xlsx (`<autoFilter ref="A1:O7"/>` present in `xl/worksheets/sheet*.xml`). Excel
displays filter dropdowns + sort buttons in the header row when the file opens.

**Column widths**: each column gets a sensible default width via `ws['!cols']` so the
file looks reasonable on first open without the user manually expanding columns.

**Stopped reason cell**: a new row in the Summary sheet, populated by walking
`logEntries` backward to find the most recent terminal event. Maps to friendly text:
- `circuit-breaker` → "Circuit breaker tripped after N consecutive errors near row X"
- `error` + phase=`reauth` → "Re-auth failed: <message>"
- `error` + phase=`init` → "Initial login failed: <message>"
- `stopped` (user stop) → "Stopped by user at row X"
- (none of the above) → empty (clean completion)

### Item 2.10 (Phase 8, sub 3) — Freeze-pane NOT shipped; SheetJS 0.18.5 community limitation

Per design line 386, freeze-pane was scoped for header rows of all three data sheets.
Implementation set `ws['!views'] = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2' }]`,
which is the documented SheetJS API for it.

**Verification finding:** SheetJS 0.18.5 community edition does NOT actually write
`<pane>` elements to the worksheet XML, even when `!views` is set. The produced .xlsx
contains a bare `<sheetView workbookViewId="0"/>` with no pane info. This is a known
limitation of the community edition (the pro edition writes panes correctly).

Verified via reading the generated .xlsx as a zip and inspecting `xl/worksheets/sheet*.xml`.

**Decision for v1.2.5:** ship without freeze-pane. The auto-filter on the header row
already provides most of the navigation value (sticky filter dropdowns + visible
column-sort buttons). User can manually enable freeze-pane via View > Freeze Panes
if they want it for a specific log file.

**Possible v1.2.6 follow-ups:**
- Hand-patch the worksheet XML after SheetJS writes the file (open as zip, inject
  `<pane>` element, repackage). Adds ~20 lines but is brittle if SheetJS ever
  starts emitting panes itself.
- Switch to `exceljs` for log writing. Larger dependency, fully supports freeze-pane.

Neither is worth blocking on for v1.2.5.

### Item 2.10 (Phase 8, sub 3) — Errors sheet was always empty pre-2.10; redefined now

Pre-2.10, the Errors sheet filtered `logEntries.filter(e=>e.status==='error')`. The
runner never used `'error'` as an entry status — rows that exhausted retries were
written with `status='skip'`. So the Errors sheet was always empty (dead code).

After 2.10's synthetic entries, `'error'` is now used by login/reauth failures and
`'circuit-breaker'` by breaker-trip events. The Errors sheet now collects both:
things that warrant investigation beyond a routine row-skip. Skipped rows are still
in the Skipped sheet (separate, focused on retryable-row forensics).

The Summary sheet's "Errors" count line now reflects the new definition. The
"Total processed" / "Successful" lines explicitly filter on `e.row` (real rows
only) so synthetic entries don't inflate the row count.

### Item 2.10 (Phase 8, sub 2) — Synthetic timeline entries for run-level events

Five points now write a synthetic All-rows entry via `synthLog()`:

1. Initial login complete → phase=`init`, status=`success`, label="Initial login complete"
2. Initial login failed → phase=`init`, status=`error`, label includes failed step
3. Re-auth succeeded → phase=`reauth`, status=`reauth`, label includes trigger reason
4. Re-auth failed → phase=`reauth`, status=`error`, label includes trigger reason
5. Circuit breaker tripped → phase=`cleanup`, status=`circuit-breaker`, label includes count

Each entry has `row=''` (empty), populated `phase` and `status` columns, and (where
relevant) `errorCategory` populated via the same classifier used for row failures.
Timestamp + URL captured at the moment of the event.

The All-rows sheet will now show events interleaved with row entries in chronological
order: "Login complete" → row 1 → row 2 → ... → "Re-auth (timer) succeeded" → row 47 → ...
Visible run history without needing to cross-reference the checkpoint or runner log.

### Item 2.10 (Phase 8, sub 2) — Fatal main().catch does NOT write a synthetic entry

The outer `main().catch(...)` block runs OUTSIDE main(), so it doesn't have access to
the `synthLog` helper (which is defined inside main() because it closes over `page`).

Trade-offs considered:
- **Move synthLog to module scope**: would need to also pass `page` and `addLog` as
  closures, complicating the helper signature for marginal benefit.
- **Duplicate the addLog call inline**: doable but copy-pastes the entry shape.
- **Skip it**: the checkpoint already preserves `lastError` with phase='fatal' and
  the message, the resume modal surfaces it clearly, and the existing `try{flush();}`
  in main().catch ensures partial log state is saved.

Skipping for v1.2.5. The user-visible diagnostic story is: resume modal banner shows
"Run crashed" with the message; the runner log file (`buu-runner-<runId>.log`) has the
full stack trace. That's sufficient for the rare case of an uncaught fatal.

If this turns out to be too thin in practice (e.g., users opening the Excel log expect
to see a fatal entry there too), a v1.2.6 follow-up can move synthLog to module scope.

### Item 2.10 (Phase 8, sub 1) — Step context tracked in closure, not thrown with the error

The cleanest way to attribute a row failure to a specific step would be to wrap each
`runStep` call in a try/catch and re-throw with attached metadata. That requires
modifying every case in the runStep switch (15+ cases) which is invasive and error-prone.

Instead: a closure variable `_currentStepCtx` is updated by `attempt()` BEFORE each
`runStep` call. If `runStep` throws, the outer catch reads the still-set ctx to
populate the rich error columns. Cleared after a successful walk so retry attempts
don't carry stale context.

Trade-off: phase column is heuristic (regex on error message), not from the call site
that actually failed. `pre-action` matches "waitForSelector timeout" patterns, `action`
is the default for everything else, `post-action` matches "Assert failed". For v1.2.5
this gives 80% of the diagnostic value with 5% of the implementation risk.

### Item 2.10 (Phase 8, sub 1) — `errorCategory` is string-based, separate from 2.8's probe

2.8's network gate uses `probeNetwork()` (TCP probe) as the source of truth for "are
we connected" — string-based classification was deemed too unreliable for a runtime
decision. 2.10's `classifyError()` is also string-based but only populates a forensic
column, never drives runtime behavior.

The two could disagree (e.g., a pure Playwright timeout with no network involvement
would: probe=connected, errorCategory=timeout). That's correct — the gate said "we're
connected, your row legitimately failed", and the column says "the failure looked
like a timeout to the parser." Both true.

### Item 2.10 (Phase 8, sub 1) — Row-error event payload extended; live UI now distinguishes skip from FAILED

Pre-2.10, the runner emitted `row-error` events without `status` and the renderer
always wrote "✗ Row N FAILED" — even though the actual Excel log entry said
`status: 'skip'`. Cosmetic but confusing during retry-then-skip flows.

After 2.10, the runner includes `status`, `errorCategory`, `phase`, `stepIndex`,
`stepType` in the `row-error` payload. The renderer:
- Shows "⊘ Row N SKIPPED [internet-down] Step 4 of 12: <error>" in amber for skips.
- Shows "✗ Row N FAILED [selector] Step 4 of 12: <error>" in red for true errors.
- Marks the log table entry with the matching status class.

The Excel log writer (sub 3) will use the same fields to populate the new columns.

### Item 2.11 (Phase 7) — Re-auth fires at row boundaries, never mid-row

The design called for three triggers (timer / connectivity-wait / detection). All three are implemented but converge on a single rule: **re-auth never interleaves with row execution.**

- **Timer-based** is *not* a `setInterval` — that would risk firing mid-row. Instead, `nextReauthAt` is checked at the top of each row (after retry-skip filter, before `row-start` emit). When `Date.now() >= nextReauthAt`, `maybeReauth('timer')` runs synchronously, then the row proceeds. Worst-case drift: a 2-hour-and-3-min row delay vs the locked 2-hour interval. PestPac sessions are believed to last 4+ hours so this is well-margined.
- **Detection-based** also fires at row-start, via `isOnLoginPage()` checking `page.url()` against `/login\.pestpac\.com/i`. Mid-row session expiry is therefore NOT caught — the row will fail with a confusing "selector not found" error, then the per-row retry logic kicks in (which itself doesn't currently re-auth, so the retries also fail, then the row skips). The next row's row-start will detect the login page and re-auth, so subsequent rows recover. Acceptable for v1.2.5; mid-row detection could be added in v1.2.6 if mid-row expiry turns out to be common.
- **Connectivity-wait** fires inside the network gate (between rows by definition, since the gate runs AFTER a row's first failure). Threshold: `waitedMs > 10*60*1000`. Below 10 min, no re-auth — PestPac sessions tolerate brief outages.

All three triggers route through `maybeReauth(reason)`, which calls a shared `loginToPestPac(page, creds)` helper. The `pestpac-login` step case in `runStep` was simplified to delegate to the same helper, so the initial login and the three re-auth triggers all use one code path.

### Item 2.11 (Phase 7) — Re-auth failure is fatal

`maybeReauth()` does NOT retry on its own failure. If `loginToPestPac` throws (network error during re-auth, PestPac down, credentials rejected, login page changed), the runner emits a fatal event, the outer main().catch writes `lastError: { phase: 'fatal', message: 'Re-auth failed (...)' }` to the checkpoint, and the runner exits with code 1.

User sees: resume modal next launch with banner "Run crashed" and the re-auth failure message. Clear actionable feedback.

This is the right default for v1.2.5: re-auth failure during a 6-hour overnight job suggests something deeply wrong (credentials wiped, network down for hours, PestPac changed their login flow). Continuing would just produce 4,000 confused rows. Better to stop, preserve the checkpoint, surface the issue, let the user investigate.

A future v1.2.6 could add a small re-auth retry (3 attempts, 30s apart) for transient network blips during the re-auth itself. Out of scope for v1.2.5.

### Item 2.11 (Phase 7) — `_hbState.phase` carries the re-auth reason

While re-auth is in progress, the heartbeat phase is set to `reauth-timer` / `reauth-connectivity-wait` / `reauth-detected-login-page`. The renderer's heartbeat handler maps these to friendly status messages ("session refresh (scheduled)", etc.). After `loginToPestPac` returns successfully, phase resets to `running`.

This means: if the user is watching the live log, they'll see the status flip to "Re-authenticating — session refresh (scheduled)…" for ~10–15 seconds (the duration of the login sequence), then back to "Row N…". Clear visual feedback that the system is healthy and being proactive.

### Item 2.11 (Phase 7) — `nextReauthAt = 0` disables timer trigger; default 120 min stays

Per the locked design and the dormant constant from commit `ddf98bf`, REAUTH_INTERVAL_MS defaults to 120 min. Setting reauthInterval=0 in Settings disables the timer trigger entirely. Detection and connectivity-wait triggers still work — they're independent of the timer.

### Item 2.8 (Phase 7) — Network probe is TCP, not DNS or HTTP HEAD

The design (line 627) flagged the ping mechanism as an open question. Picked **TCP connect to `app.pestpac.com:443`** via Node's builtin `net` module. Reasoning:

- **DNS lookup** is too lenient. Cached DNS will resolve even when the network is genuinely down (router up, ISP routing dead). False positive: probe says "connected" but every HTTP request fails.
- **HTTP HEAD** is too aggressive. Every probe adds load to PestPac's servers. Run an overnight job through 6 outages, that's hundreds of needless requests. Also opens the door to rate-limiting / "are you a bot" responses, which would themselves look like network failure.
- **TCP connect** confirms the network path end-to-end (ISP, routing, PestPac's load balancer accepting connections) without paying the HTTP cost. 5-second timeout. Sock destroyed immediately on connect. ~10–50ms when up, fails fast when down.

The probe runs AFTER any row failure, regardless of error string. The probe result is the source of truth — error strings from Playwright are heterogeneous (`net::ERR_INTERNET_DISCONNECTED`, `Navigation failed because page crashed`, plain timeouts) and unreliable as a sole classifier.

### Item 2.8 (Phase 7) — Network gate placed BEFORE the bounded retry loop, not after

Initial plan was to add a probe inside each retry attempt. Final design probes once, BEFORE entering the retry loop. Reasoning:

- If the network is genuinely down, the first 1–2 retry attempts will fail with network errors, exhausting the retry budget while the user waits for nothing. The breaker eventually trips (20 errors). That's the 5/1 disaster pattern.
- Probing once before the retry loop converts a "burn the row's retry budget on a dead network" situation into "wait for network, then give the row its full retry budget on a live connection." Net effect: a 30-min outage costs the user 30 minutes of wall time, but ZERO row failures.
- If the post-wait retry still fails, the existing retry/skip logic runs unchanged. Real selector errors still skip after their bounded retries; the breaker still trips on persistent real errors. The gate just removes "network down" from the breaker's input.

### Item 2.8 (Phase 7) — User Stop honored during network wait

`waitForNetwork()` checks `currentMode === 'stop'` after every sleep. If the user clicks Stop during a 6-hour network outage, the wait loop throws `__STOP__` and the row catch handler exits cleanly with a checkpoint annotated as `lastStop: { phase: 'user-stop', ... }` (item 2.7's path).

The emitted `stopped` event uses `reason: 'user-during-network-wait'` (vs the normal `reason: 'user'`) so the runner log distinguishes the two cases. Renderer treats them identically — the row was stopped, no further processing.

### Item 2.11 (Phase 7 sub 2) — Re-auth hook placed but not yet wired

Inside the network gate, after `waitForNetwork()` returns the total ms waited, there's a comment-marked hook for item 2.11: if `waitedMs > 10*60*1000` (10 minutes), trigger re-auth before continuing. PestPac's session likely expired during a 10+ minute outage; the post-wait retry would just hit the login page and fail with a confusing "selector not found" error.

Sub-commit 2 of Phase 7 will fill this in alongside the timer-based and detection-based re-auth triggers. All three triggers will share a single `loginToPestPac()` helper extracted from the existing `pestpac-login` step logic.

### Item 2.12 — Retry-failed is in-session only; cross-launch retry deferred

The "Retry N failed rows" button appears in the Run progress panel after a run completes with at least one failure. Clicking it spawns a new runner with `retryRowIndexes: [list of failed source rows]` and processes only those rows.

**Scope intentionally narrow:**

- **In-session only.** The button is populated from `_failedRowIndexesThisRun`, an in-memory array tracked from `row-error` events. Quitting BUU loses this state. Cross-launch retry (re-opening yesterday's log file and retrying its failures) requires the v1.2.4 backlog item to make historical logs scannable, which is out of scope for v1.2.5.
- **`logEntries` cap doesn't matter.** The display log table is capped at 500 entries via `slice(-500)`, but `_failedRowIndexesThisRun` is uncapped — failures from any point in a 100k-row run are kept. Memory cost is negligible (8 bytes per int).
- **Source-spreadsheet integrity check.** Retry refuses to proceed if `ssPath` or `ssRowCount` doesn't match the snapshot taken at original-run start. Prevents row-index mis-mapping if the user edited the spreadsheet between runs.

**What's NOT in v1.2.5:**

- Reading failures from a saved Excel log file (cross-launch). Belongs to a future "historical log scan" feature.
- Auto-merge retry results into the original log. Per design, separate logs for audit clarity.
- Auto-re-retry on new failures. The user clicks Retry again if the first retry produced more failures.

**Edge case worth flagging:** if the user *navigates away from the Run progress panel* between completion and clicking Retry, the button state persists fine (it's a DOM element with `display:''`), but if the user runs a *fresh* full run before clicking Retry, `_failedRowIndexesThisRun` resets to empty and the button hides. That's correct behavior — retry-of-the-prior-run after starting a new run would be a footgun.

### Item 2.12 — `runTotal` set to retry count, not source total

When a retry run starts, the renderer sets `runTotal = n` (the retry list length) so the progress bar and "Row N of M" status reads naturally as "Row 47 of 12" rather than "Row 47 of 6,278." However the runner's own emit events use `totalRows` from the source (whatever `streamRows` reports), so `evt.totalRows` will still be the source count. The renderer ignores that for retry runs and uses its locally-set `runTotal`.

This produces a small inconsistency: live log lines like "Row 47/6278" come from the `row-start` event's `evt.totalRows`, while the run-progress stat box uses `runTotal=12`. Acceptable for v1.2.5 — both numbers are meaningful in context (source row index vs retry progress). Could be polished in v1.2.6.

### Item 2.4 — Both Stop buttons now use clean shutdown (force-kill removed from primary path)

In v1.2.4, the toolbar Stop and pause-panel Stop took different paths:
- Toolbar called `API.stopAutomation()` which **force-killed** the runner process (synchronous; `runStopped()` cleared UI immediately).
- Pause-panel called `API.runControl({cmd:'stop'})` which sent a clean stdin command (asynchronous; UI relied on `done` event to clear `isRunning`).

The pause-panel async chain had a race where a fast double-click hit "An automation is already running" because `isRunning` hadn't synced yet.

After v1.2.5, both buttons route through a new `requestStop()` function that:
1. Disables the Run button immediately (visible feedback during stop window)
2. Sends the clean stdin command via `runControl`
3. Sets `_stopInProgress` flag so subsequent clicks during the window are ignored
4. Lets the runner's exit fire `done`/`closed` which calls `runStopped()` (re-enables buttons)

The `API.stopAutomation` IPC handler (force-kill) still exists in main.js for backward compatibility; the renderer only calls it as a fallback if `API.runControl` is missing (older preload bridges). No production path exercises force-kill anymore.

**Why this matters with 2.7:** force-kill bypasses the runner's `finally` block, which is where 2.7 writes `lastStop` and decides about checkpoint preservation. Force-killing would leave checkpoint state ambiguous (was the user-stop annotated? was the breaker preserved?). Clean shutdown gives 2.7's logic a chance to run.

**Open question from design:** "Does `proc.on('close')` fire reliably on the clean-exit path?" The chain has multiple async steps (runner finally block → emit complete → main() returns → process exits → IPC fires `done`), but it's the same chain v1.2.4's pause-panel path used. Trusted to work; would surface as "buttons stuck disabled after stop" if it doesn't, easy to spot.

### Item 2.7 — User Stop now preserves the checkpoint (behavior change from v1.2.4)

In v1.2.4, clicking Stop while a run was active would terminate cleanly and **delete** the checkpoint. From v1.2.5 forward, clicking Stop preserves the checkpoint and annotates it with `lastStop: { phase: 'user-stop', rowIndex, lastSuccessfulRow, ts }`.

On the next BUU launch, the resume modal will appear for that stopped run. The user has three options: Resume forward, Discard (deletes checkpoint), or Dismiss (leaves it for next launch).

**Why this is the right call:** users sometimes Stop intending only to pause and reconsider. Today they lose the option to resume. After 2.7 they get the choice.

**Trade-off:** users who genuinely want to abandon a run now need one extra click (Discard from the modal next launch). Net: better safety, marginal friction.

### Item 2.7 — `skip-and-resume` shares runtime path with `resume`; visible distinction lands with 2.10

The 3-option modal exposes a "Skip & resume" button that's only visible when the previous run hit the circuit breaker. Clicking it currently does the same thing as "Resume" — spawn from `rowIndex + 1`, leaving the failed cluster behind.

The design's distinction is **logging-only**: skip-and-resume should mark the previously-failed rows as "skipped (breaker)" in the new run's Excel log, so a later analyst can tell which rows BUU intentionally bypassed. That requires touching the runner's log writer and the row-iteration logic to inject pseudo-entries before the resume row. Both are owned by item 2.10 (error log enrichment).

For v1.2.5: the button's existence tells the user the system understands their intent, even though the runtime behavior is identical to Resume forward. Acceptable interim. If a user picks "Skip & resume" in this release and later asks "why doesn't my log show those skipped rows?" — that's a 2.10 follow-up, not a 2.7 bug.

### Item 2.7 — `complete` event still fires after a user stop (pre-existing UX bug)

Unrelated to 2.7 logic but observed while wiring the new state: when the user stops, the runner emits `stopped` then falls through the `finally` block, which lets execution exit naturally and the function emits `complete` with the partial row counts. The renderer's `handleRunEvent` for `complete` writes "Complete — N rows (X ok, Y errors, Z skipped)" which sounds like a successful finish.

This was true in v1.2.4 too. Fix belongs to item 2.10 (live UI cleanup) where the emit shape gets revisited. Calling it out here so it doesn't get blamed on 2.7's user-stop behavior change.

### Item 2.5 (Build-side) — `copyToken` and `tokenBar`'s `field` arg are now vestigial

After 2.5-Build, chips are drag-only. The old click-to-insert path through `copyToken()` is no longer reachable from the UI (chips have no onclick). The function still exists in source because removing it cleanly would mean also removing the `pendingInsertId`/`pendingInsertField` globals it reads — and **those globals are still set by the paste-HTML modal flow** via input `onfocus` handlers and `openPasteModal()`. Pulling that thread is its own refactor.

Similarly, `tokenBar(sid, field)` keeps its `field` parameter on the signature even though the function no longer consults it. Removing it would mean updating ~5 call sites in `bodyHTML()`. Cosmetic; not worth a separate commit.

Both are safe to leave as-is for v1.2.5. Worth a small "remove orphaned token-insert code" cleanup commit in v1.2.6, paired with the paste-HTML modal cleanup if anyone touches that flow.

### Item 2.5 (Build-side) — drag works, but no keyboard equivalent for accessibility

The new chip behavior is mouse-only. Users who navigate via keyboard (or have motor difficulties with click-and-drag) have no way to insert tokens. The old click-to-copy worked from keyboard since chips were buttons. This is an accessibility regression on a feature that very few users probably hit, but worth naming.

Out of scope for v1.2.5. A future fix could add Enter-on-focused-chip → insert at last-focused field's cursor (re-using the `pendingInsertId`/`pendingInsertField` machinery the paste-HTML modal uses). Acceptable to ship without.

### Item 2.6 — Pre-run prompt uses two confirm() calls instead of a custom modal

The design specifies a 3-way prompt (Run anyway / Show me / Cancel). Native browser `confirm()` only gives 2 buttons (OK/Cancel), and Electron inherits that. Implemented as two sequential prompts:

1. First: "Run anyway?" — OK proceeds with the run, Cancel falls through to the second prompt.
2. Second (only if first was Cancel): "Show me where the issues are?" — OK applies highlights and scrolls to the first flagged step, Cancel just closes.

UX is functional but rougher than a custom modal would be. A real modal would unify this into one prompt with three buttons. Out of scope for v1.2.5 — we're not shipping a modal framework just for this. Worth revisiting in v1.2.6 if user feedback finds the two-step prompt confusing.

### Item 2.6 — Live re-validation only paints highlights when on the Build page

`scheduleValidationRefresh()` checks whether `panel-builder` is the active panel before re-applying highlights. If the user is on Import, Run progress, Run log, etc., the function clears any stale highlights but does not re-paint new ones (no point — they can't see the steps).

This means: switching to a non-builder page right after editing leaves the highlight state where it was, then it clears on the next debounce tick. Switching back doesn't re-paint until the next edit. Acceptable behavior — switching away is normally rare, and the next edit re-paints correctly.

### Item 2.11 (settings UI) — `REAUTH_INTERVAL_MS` is dormant until Phase 7

The re-auth interval input is wired through (renderer → IPC → checkpoint → runner template), and the runner sees the value as `REAUTH_INTERVAL_MS`, but no code consumes it yet. The actual three triggers (timer-based, connectivity-wait, detection-based) and shared `loginToPestPac()` function come in Phase 7's item 2.11 logic commit.

If the input is at default 120 (or any non-zero value) and a run hits the ~6 hour PestPac session ceiling, **the run will fail the same way the 5/1 Duncan run did** — that's the safety gap until Phase 7 lands. The circuit breaker (2.3b) catches it at 20 consecutive errors, so worst case is ~10 minutes of failed rows before stop, not 18 hours.

Acceptable interim state. Don't ship v1.2.5 to fleet without finishing Phase 7.

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
