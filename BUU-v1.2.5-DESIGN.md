# BUU v1.2.5 DESIGN — Reliability and quality-of-life

**Status:** Design fully revised through Q&A on 2026-05-04. Implementation has NOT started. Locked design captures every item we agreed on, including additions made during the 5/4 walkthrough.
**Author:** Claude (work account), per Matthew.
**Priority:** v1.2.5 grew during the 5/4 walkthrough from "small QoL fixes" to a meaningful reliability release. Ten locked items, ~15-20 hours of implementation. The "feature freeze, bug fixes only" boundary still holds — every item is a response to a real failure mode or paper cut.

---

## 0. CHANGE LOG (FROM ORIGINAL DESIGN)

The original 2026-05-01 design captured 2.1–2.10 as small items; 2.11 was added 2026-05-04 after diagnosing the 5/1 6,278-row run. The 5/4 walkthrough reshaped most of these items. Summary of changes:

| Item | Original | Revised |
|---|---|---|
| 2.1 | Remember last upload directory | Unchanged |
| 2.2 | Default row delays = 0–0 | Unchanged |
| 2.3 | Default `errHandle = retry` (label "Retry once, then skip") | **`stop` removed entirely.** Two options: "Retry" (default), "Skip". Saved flows with `errHandle: stop` upgrade silently to `retry`. Retry-then-failed status is `skip`. |
| **2.3b (NEW)** | — | **Consecutive-error circuit breaker.** Default 20 (configurable, 0=disabled). Resets on success. Retry-then-skip and immediate-skip both count. Trip preserves checkpoint per 2.7. |
| 2.4 | Reproduce-then-fix the stop-from-pause lockout | **Collapse two stop paths into one.** Both Stop buttons (toolbar + pause-panel) call shared clean-shutdown. Disable Run button on Stop click, re-enable on `done` event. |
| 2.5 | Drag-and-drop chips on Build steps page; Import chips: leave or remove | **Drag-only on Build (no click fallback) with higher contrast.** Import chips become non-interactive reference list (plain styling, no chip styling). |
| 2.6 | Validate button → Run button + pre-run validation gate (block on errors) | **Non-blocking validation prompt.** No hard block; "Run anyway / Show me / Cancel". "Show me" navigates to where the fix lives (Build step or Import page) with all-at-once highlighting. **Validate page deleted entirely.** Live re-validation on edit (debounced). |
| 2.7 | Resume from failed run; 3 modal options | Same 3 options, but **"Resume" re-attempts ALL previously-failed rows from the run AND continues forward.** Failed-row list computed from log file at resume-time (not stored in checkpoint). Modal shows explicit counts/destinations. No confirmation on "Start fresh". |
| 2.8 | Configurable selector timeout, page load mode (3 options), retry count | **`networkidle` removed** (footgun on React apps with polling). Page load timeout **hardcoded at 300s** (not a setting). Retry count **hard-capped at 20**. **Network-aware retry added:** ping-based diagnosis (Google + PestPac in parallel), wait-and-ping loop on confirmed outage, indefinite wait, re-auth after >10min wait. **Two-column Run settings layout.** |
| 2.10 | Errors sheet enrichment with step + field columns | **Both Errors and Skipped sheets enriched.** New `errorCategory` column with full taxonomy (internet-down / pestpac-down / etc.). Column reorder for pivot-friendliness. Auto-filter + freeze pane on header rows. Synthetic All-rows entries for non-row events (login, reauth, breaker trip). Truncation indicator (`…` suffix). Summary "Stopped reason" cell. |
| 2.11 | Periodic re-auth (timer-only, 2hr default) | **Three triggers:** timer, post-connectivity-wait, **detection-based** (post-navigation login-page check). All call shared `loginToPestPac()`. All reset the timer. Logout-then-login (per doc, conservative). Credentials in-memory after initial keytar pull. |
| **2.12 (NEW)** | — | **Retry failed rows.** Post-completion only (breaker-tripped runs use resume, not retry-failed). Runner-mode (no temp spreadsheet). Prompt-on-flow-divergence ("Original / Current"). Separate log file. Shares `retryRowIndexes` parameter shape with 2.7's resume. |

Item 2.9 (PestPac API) remains **out of scope** for v1.2.5 — BUUA work, blocked on WorkWave API support per DESIGN-INDEX.md.

---

## 1. STRATEGIC CONTEXT

These items respond to real failure modes Matthew has hit:
- **2.3, 2.3b, 2.10, 2.11, 2.8 network-aware** — directly motivated by the 5/1 6,278-row run that produced 1,991 errors after a session timeout at the 6-hour mark.
- **2.4** — v1.2.4 regression in verification modes.
- **2.5, 2.6** — long-standing UX paper cuts.
- **2.7, 2.12** — recovery infrastructure for failed runs (preserve work done, retry only what didn't).
- **2.8 settings** — performance tuning. With defaults (5s selector timeout, 0-0 row delays, 2 retries), a 7k-row run drops from ~5 hours to under 90 minutes.

v1.2.5 is the last BUU release before the BUUA fork. After ship, BUU enters bug-fix-only mode; new features (multi-runner, queues, unattended operation) move to BUUA per `BUUA-DESIGN.md`.

---

## 2. THE LOCKED ITEMS

### 2.1 Remember last upload directory

**Symptom:** When Matthew clicks "Choose file…" on Import data, the file picker defaults to wherever Electron last left it. He always navigates back to `upcoming/` or wherever the day's job spreadsheets live.

**Fix:** Persist the directory of the last successful spreadsheet pick to `buu-config.json` as `lastSpreadsheetDir`. On `open-spreadsheet` IPC, pass it as `defaultPath` to `dialog.showOpenDialog`.

**Scope:**
- Spreadsheet upload picker → remembers per-machine `lastSpreadsheetDir`.
- Save/Load flow pickers → continue defaulting to `getFlowsDir()`. Do NOT change.

**Implementation:**
- In `open-spreadsheet` handler (`main.js`): read `lastSpreadsheetDir` from config; pass as `defaultPath`. After successful pick, write `path.dirname(filePaths[0])` back via `writeConfig({ lastSpreadsheetDir: ... })`.
- No renderer changes needed.

**Edge cases:**
- First launch (no `lastSpreadsheetDir`) → fall through to OS default.
- Saved dir no longer exists → still pass it; Electron handles missing paths gracefully.
- User cancels picker → don't update saved dir.

**Open question during impl:** does `buu-config.json` already have a stable read/write helper (`readConfig`/`writeConfig`)? If not, this item's first ~10 lines are creating that helper. If yes, item is genuinely 3-5 lines.

---

### 2.2 Default row delay = 0–0 seconds

**Symptom:** Default `rowDelayMin=1` and `rowDelayMax=3` add ~2 sec/row of pure waiting. PestPac doesn't rate-limit at burst speed (verified across multiple production runs).

**Fix:** Change HTML defaults of `#rowDelayMin` and `#rowDelayMax` from `1`/`3` to `0`/`0`.

**Scope:**
- Renderer-side default values on fresh launches only.
- Already-saved flows keep their baked-in `rowDelayMin`/`rowDelayMax` values. (Same upgrade-on-resave pattern as 2.3.)

**Edge cases:**
- The `errHandle` validation in `runValidation()` checks per-step `wait` step type's `waitMin`/`waitMax`. Different code path. Leave alone.

---

### 2.3 Error handling: two options, default Retry

**Symptom:** Default `errHandle: stop` kills overnight runs on first transient error. The `stop` mode itself is a footgun for production work.

**Fix:**

1. **Remove `stop` from the dropdown entirely.** Two options remain:
   - **"Retry"** (default) — try, retry per retry count (2.8), if still failing log as `skip` and continue.
   - **"Skip"** — skip immediately on first error, log as `error`, continue.
2. **Saved flows with `errHandle: stop`** are silently upgraded to `retry` at load time. Re-saved flows persist as `retry`.
3. **Retry-then-failed status:** in the runner's retry-failed catch, set `entry.status='skip'` and increment `skipped++` instead of `errs++`.

**Why two options not three:** with retry count configurable via 2.8 (default 2, hard cap 20), "Retry once" is dishonest about behavior. "Retry" + the retry count setting honestly describes what happens.

**Why `stop` is removed entirely:** verification modes (step / step-row from v1.2.4) handle the "I want to see what's happening" case. Production runs should never stop on first error. There's no defensible scenario for `stop` in modern BUU.

**Implementation:**
1. `index.html`: remove `<option value="stop">…</option>`. Default-select `<option value="retry">Retry</option>`.
2. Flow loader: if `errHandle === 'stop'`, replace with `retry` and (optionally) flag a console.warn so we can spot upgrade events.
3. Runner template (`buildRunner`): in retry-failed catch, swap `error`→`skip`, `errs++`→`skipped++`.
4. Validate via `_validate-runner.js`.

**Scope:**
- Existing `skip` mode unchanged in behavior.

---

### 2.3b Consecutive-error circuit breaker (NEW)

**Symptom:** The 5/1 run produced 1,991 consecutive errors before Matthew noticed the next morning. Without `stop` mode (per 2.3), there's no automatic "this is going badly, stop the run" signal — runs would otherwise burn unbounded time on dead sessions, broken flows, etc.

**Fix:** Add a **consecutive-error circuit breaker** to the runner.

- **New Run setting:** "Stop after N consecutive errors" — integer field on Build steps page Run settings card.
- **Default: 20.** Configurable. **`0` = disabled** (sentinel; same pattern as 2.11).
- **Counter increments on:** any row outcome that represents "BUU tried and couldn't make it work" — i.e., retry-then-skip (Retry mode) AND immediate-skip (Skip mode) both count.
- **Counter resets to 0 on:** any successful row.
- **Connectivity-class errors do NOT increment the breaker** (per 2.8 — the wait-and-ping loop handles those before they become row failures). The breaker is for *structural* problems, not transient network issues.
- **Threshold trip:** runner exits with fatal-style stop. Checkpoint **preserved** per 2.7. `lastError: { phase: 'circuit-breaker', consecutiveErrors: N, lastSuccessfulRow: M }` written. Synthetic All-rows entry per 2.10 (status=`circuit-breaker`).
- **Resume modal handling:** per 2.7, Resume re-attempts all previously-failed rows from the run plus continues forward; Skip-and-resume skips the breaker cluster only and continues forward.

**Why default 20:** sweet spot between false-positive trips on transient bad patches (PestPac sometimes fails 5-10 rows in a row legitimately) and unbounded burn (50+ would let an hour of failure accumulate). Configurable so per-flow tuning is possible.

**Implementation:**
1. Runner template: add `consecutiveErrorCount` variable in row loop. Increment on skip/error outcomes. Reset on success. Connectivity-class errors increment a separate `connectivityErrorCount` (not used for breaker; just for log diagnostics).
2. Runner template: when `consecutiveErrorCount >= breakerThreshold && breakerThreshold > 0`, write `lastError`, emit synthetic `circuit-breaker` log entry, run `finally` cleanup, exit.
3. `index.html`: add input to Run settings card. Default `20`. `min="0"`, `max="1000"`. Tooltip: "Stop the run after this many consecutive errors. 0 = disabled."
4. Persist to flow JSON and `start-automation` IPC payload.
5. Validate via `_validate-runner.js`.

**Scope:**
- Breaker threshold is per-flow (lives in flow JSON), not per-run.
- A breaker trip is a fatal-style exit — same recovery path as fatal browser crash, fatal re-auth failure: checkpoint preserved, resume on next launch.

---

### 2.4 Single stop path for both Stop buttons

**Symptom:** v1.2.4 regression — clicking Stop from the pause panel leaves the renderer's `isRunning` flag stuck `true`, so the next Run click is rejected with "An automation is already running."

**Root-cause hypothesis (not yet verified):** the renderer's stdin-write to runner / runner exits / main detects exit / `automation-event {type:'done'}` arrives / `runStopped()` fires chain has a window where the user can click Run again before `isRunning` syncs to `false`. The toolbar's Stop button works as workaround because it force-clears state through `stopAutomation`.

**Fix:** Collapse the two stop paths into one.

1. Both Stop buttons (toolbar red Stop AND pause-panel Stop) call the **same** `stopAutomation()` function.
2. That function uses **clean-shutdown semantics** (current pause-panel behavior): write stop command via stdin → runner finishes current row safely → `finally` runs → log flushes → checkpoint policy per 2.7 → process exits → main detects → renderer syncs.
3. **Disable the Run button immediately on Stop click**, re-enable when `done`/`closed` event arrives. Visible feedback during the stop window prevents the double-click race regardless of how fast the underlying chain is.
4. **2.7's "Keep checkpoint?" prompt** fires on either Stop button (consistent UX since they share a path now).

**Why clean-shutdown over force-kill:** force-kill leaves potentially incomplete Excel writes, no Summary sheet finalization, partial log state. Clean shutdown preserves the runner's own cleanup (which 2.7 makes meaningful — the `finally` block now writes `lastStop` or doesn't delete the checkpoint based on user choice).

**Implementation note:** if implementation reveals the toolbar's existing Stop is force-kill (not clean-shutdown), CHANGE it to clean-shutdown. Don't merge in the wrong direction.

**Scope:**
- Single shared stop path. Don't refactor the broader run-control IPC architecture; that's BUUA scope.

**Open question deferred to impl:** confirm via `console.log` that `proc.on('close')` actually fires reliably on the runner's clean-exit path. If not, *that's* the bug (deeper than the renderer-sync hypothesis) and we'll handle it as found.

---

### 2.5 Token chips: drag-only on Build, reference-only on Import

**Symptom:** Today's chip insertion uses module-level globals (`pendingInsertId`, `pendingInsertField`) set by focus events, so chips inserts into "wherever you last clicked." Frequently the wrong field. Import-page chips have no field context at all, just inherit whatever was focused last on Build.

**Fix:**

1. **Build steps page per-step `tokenBar()` chips: drag-only.**
   - HTML5 native drag-and-drop. `draggable="true"`. `dragstart` sets `dataTransfer` to the `{{Column}}` token text.
   - Drop targets: any `<input type="text">` inside a step body. `dragover`/`drop` handlers insert at cursor position.
   - **Click does nothing** on these chips. (No fallback. Cleaner test matrix, less ambiguity.)
   - Visual states: `.chip-dragging`, `.field-droppable`, `.field-droppable-hover` CSS classes.
   - **Higher contrast styling** than today — more saturated background, stronger border. Read clearly as draggable.

2. **Import page chips: non-interactive reference display.**
   - Convert from chip-styled clickable elements to a plain list of column names (e.g., separated by `·` or commas).
   - No `cursor: pointer`, no hover state, no click handlers, no drag handlers.
   - Purpose: confirmation that BUU correctly read the spreadsheet's columns. Useful at import-time. Not an action target.

**Implementation effort:** realistic 60-90 min (HTML5 drag-and-drop has fiddly browser quirks: `dragover` needs `preventDefault()`, cursor-position-on-drop calculation isn't trivial). The doc's earlier 30-45 min estimate was optimistic.

**Scope:**
- Drag-and-drop only on per-step chips on Build steps page.
- Import page chips become reference list only.
- Existing `copyToken()` / `pendingInsertId` / `pendingInsertField` globals can be deprecated/removed once drag-only is in place.

**Out of scope:**
- Drag-handle indicators, hover-lift animations, ghost-image polish. Ship the basic working version first; polish if needed.

---

### 2.6 Validation: navigate-to-fix with all-at-once highlighting; Validate page deleted

**Symptom:** "Validate flow →" button takes Matthew to a Validate page that doesn't auto-run validation, doesn't visibly do anything when "Run checks" is clicked, and forces him back to the toolbar's Run button to actually start a run.

**Fix:**

1. **Replace "Validate flow →" button** on Build steps page with **"▶ Run automation"** button (matches toolbar Run icon). Clicks `startRun()`.

2. **Pre-run validation as a non-blocking check.** Both Run buttons (Build-page and toolbar) call `runValidation()` before starting. If validation finds anything (errors, warnings, anything):
   ```
   Validation found N issue(s). Run anyway?
   [Run anyway] [Show me] [Cancel]
   ```
   - **Run anyway** → start the run.
   - **Show me** → navigate to where the fix lives. No run started.
   - **Cancel** → close prompt, do nothing.

   No issues → run starts immediately, no prompt.

3. **"Show me" navigates to the fix location with all-at-once highlighting.**
   - **Step issues** (bad selector, missing field, wrong step config) → Build Steps page, scroll to first flagged step. **All flagged steps highlighted simultaneously** with a colored border + small badge.
   - **Token issues** (a `{{Column}}` token references a column not in the spreadsheet) → Import Data page, with the column reference made visible (highlighted in available-columns list, or shown as missing).

4. **Live re-validation on edit.** Every step modification triggers `runValidation()`. Highlights update automatically — clear when fixed, appear when newly broken. **Debounced** (200ms after last edit) to avoid running on every keystroke.

5. **Delete the Validate page entirely.** Remove from navigation, remove the route, remove `valResults` rendering code, remove the page's HTML. The "Run checks does nothing" bug disappears with the page itself. Remove any stale references to navigating to Validate (e.g., the existing "Continue to Run →" button).

**Why no hard block:** with circuit breaker (2.3b) at 20 consecutive errors as a safety net, a flow with real bugs trips the breaker quickly anyway. Pre-run validation's job is to *inform*, not *prevent*. The user is the one running the automation — if they want to run a flow with warnings, that's their call.

**Why all-at-once highlighting (not stepper UI):** simpler ship, same diagnostic value. User sees every flagged step, fixes in any order. Realistic flow size (5-15 steps) means a "wall of color" isn't a real problem.

**Implementation:**
1. `runValidation()`: extend each issue with a navigation target — e.g., `{ kind: 'step', stepId: '...' }` or `{ kind: 'token', column: '...' }`.
2. `index.html`: change Build-page button onclick + label + icon. Add prompt logic to `startRun()`. Add highlight CSS classes (`.step-validation-flag`, etc.) and apply/clear logic.
3. Live re-validation: hook into existing step-edit handlers, debounce, re-run validation, update highlights.
4. Delete Validate page: remove route from `go()`, remove `panel-validate` from HTML, remove `runValidation` rendering of `valResults` (the function still runs — just doesn't render to a deleted panel).

**Scope:**
- Validation logic itself is unchanged in what it checks; we're changing how issues are surfaced.
- Build-page step highlights only persist while issues remain. Fixed step → highlight clears.

**Out of scope for v1.2.5:**
- New validation rules. We're surfacing existing rules better, not adding more.

---

### 2.7 Resume from any non-clean exit; failed-row list from log

**Symptom:** Today's resume-on-launch (v1.2.3) works only if the runner exits unexpectedly with the checkpoint file still on disk. When `errHandle: stop` triggers (now removed per 2.3) the checkpoint was deleted in `finally`. New failure modes (circuit breaker, re-auth fail, browser crash, user-graceful Stop) need to behave the same: preserve work done, allow resume.

**Fix:**

1. **Runner: rework `finally` to not auto-delete the checkpoint.** Delete only at explicit clean-completion event (row loop exited naturally, all rows processed, no `_stopRequested`).

2. **Runner: write `lastError` to checkpoint on non-clean exit.**
   - Schema additions to checkpoint v2 (all optional):
     ```
     lastError: { phase, message, rowIndex, failedStep? }   // breaker, fatal, crash, reauth-fail
     lastStop: 'user-graceful'                               // user clicked Stop AND chose "keep checkpoint"
     ```
   - On clean completion → both fields absent, checkpoint deleted.
   - On user Stop with "Discard checkpoint" → checkpoint deleted.
   - On user Stop with "Keep checkpoint" → checkpoint preserved with `lastStop`.

3. **Graceful Stop prompt** (2.4 now routes both Stop buttons through this): "Keep checkpoint for later resume? [Yes / No]". Yes preserves with `lastStop: 'user-graceful'`. No deletes.

4. **Resume modal: three options with explicit counts/destinations.**
   ```
   Last run [stopped/failed/was interrupted] at row X.

   • Resume — re-attempt N failed rows, then continue from row X+1
   • Skip and resume — skip M failed rows from the breaker cluster, continue from row X+1
   • Start fresh — discard progress, run all 6,278 rows from row 1
   ```
   - **Resume** = re-attempt all previously-failed rows from the run AND continue forward from where it stopped. Re-attempts both scattered earlier failures AND the cluster (if breaker-tripped).
   - **Skip and resume** = for breaker trips: skip the cluster only, continue forward, scattered failures stay failed. For single-row error-stops: skip that one row, continue from N+1.
   - **Start fresh** = discard checkpoint, run from row 1. **No confirmation.** Trust user.
   - Modal copy always shows explicit counts and destinations. e.g., "Resume: re-attempt 70 failed rows, then continue from row 4,337."

5. **Failed-row list computed from log file at resume-time, not stored in checkpoint.**
   - Resume modal opens the run's log file (path from checkpoint's `logPath`), streams the All-rows / Skipped / Errors sheets via exceljs, extracts failed row indexes.
   - This helper is shared with 2.12 (retry-failed) — same code path for "extract failed rows from a log file."
   - **Log file missing fallback:** modal degrades to "Skip and resume" + "Start fresh" only, with notice "Can't find run log; failed rows can't be re-attempted automatically."

**Why log-based not checkpoint-based:** keeps checkpoint writes minimal (only on `rowIndex` advance, not on every failure). Single source of truth (the log already has this data). Cleaner architecturally.

**Runner parameter shape (shared with 2.12):**
```
{
  retryRowIndexes: [200, 845, 1200, ..., 4297, ..., 4316],
  resumeFromRow: 4317  // optional; if absent, no forward continuation (2.12 case)
}
```

**Implementation order:**
1. Runner: rework `finally`. Explicit checkpoint delete only on clean-completion event.
2. Runner: write `lastError`/`lastStop` on appropriate exit paths.
3. Runner: accept `retryRowIndexes` + `resumeFromRow` parameters. Process retries first, then forward continuation.
4. Renderer: log-file reader helper (`extractFailedRowsFromLog(logPath)`). Returns array of row indexes.
5. Renderer: update resume modal copy + add three-option logic + missing-log fallback.
6. Validate: induce a row-stop (kill runner mid-row), confirm checkpoint remains, confirm resume modal appears on relaunch with correct copy and counts.

---

### 2.8 Speed settings + network-aware retry

**Symptom:** Selector waits hardcoded at 15s. Page-load mode hardcoded at `'load'`. Retry count hardcoded at 1. Combined with default 1-3s row delays, an 8k-row run is ~5 hours of mostly-waiting. Plus: no graceful handling of internet drops or PestPac downtime — errors accumulate row by row.

**Fix:**

**Configurable Run settings (added to Build steps page Run settings card, two-column layout):**

1. **Selector timeout** (seconds) — default `5`, was hardcoded `15`. Used in `page.waitForSelector` for click/type/select/checkbox/clear/assert/textedit. Hard cap at `60`.

2. **Page load mode** — dropdown with **two** options:
   - `domcontentloaded` (default, fast — wait for HTML parse)
   - `load` (slower — wait for images/fonts/etc.)
   - **`networkidle` removed** (footgun on React apps; PestPac's React framework + likely background polling makes networkidle prone to never-resolve hangs).

3. **Retry count** — default `2`, was hardcoded `1`. `min="0"`, **`max="20"`** (hard cap via input attribute).

**Hardcoded (not user setting):**
- **Page-navigation timeout: 300 seconds (5 min).** Matthew confirmed PestPac can have 15+ second slow days unrelated to internet/client. 300s gives plenty of headroom while still failing eventually if a navigate is truly hung. Skip-or-retry handles the rare slow-row case.

**Network-aware retry (built-in, not configurable):**

When the runner catches an error during a row attempt:

1. **Classify the error** (extends 2.10's `errorCategory`):
   - `connectivity` — `ERR_INTERNET_DISCONNECTED`, `ERR_NETWORK_CHANGED`, `ERR_NAME_NOT_RESOLVED`, DNS failures
   - `server` — HTTP 5xx, `ERR_CONNECTION_REFUSED`, `ERR_CONNECTION_RESET`
   - `timeout` — Playwright TimeoutError (selector or navigation)
   - `selector` — selector not found
   - `validation` — HTTP 4xx after action
   - `unknown` — anything else

2. **If category is `connectivity` or `server`:** ping `google.com` AND `app.pestpac.com` in parallel.

   | Google | PestPac | Diagnosis | Action | Final category |
   |---|---|---|---|---|
   | up | up | Transient — neither host is the problem | Retry the row normally | (original raw category) |
   | up | down | **PestPac is down** | Wait-and-ping loop on PestPac; resume row when PestPac returns | `pestpac-down` |
   | down | down | **Internet is down** | Wait-and-ping loop on Google; resume row when internet returns | `internet-down` |
   | down | up | Anomaly (e.g., corp firewall) | Retry row normally | `unknown-network` |

3. **Wait-and-ping loop:** wait 30s, ping target, wait 30s, ping, until target recovers. **Truly indefinite** (no upper bound). Heartbeat continues during wait with new phase (`waiting-for-internet` / `waiting-for-pestpac`) carrying `{ minutesElapsed, lastPingAt, failedRow }`. Renderer displays e.g., *"Waiting for internet — 14 minutes elapsed, last check 14:23:00. Will retry row 3,247 when connection returns."*

4. **Re-auth after >10 min connectivity wait:** when connectivity returns, if total wait exceeded 10 minutes, force a re-auth (per 2.11) before retrying the row. PestPac sessions are usually robust to brief idleness but not to 10+ minute outages. Re-auth resets the 2-hour timer per 2.11.

5. **Connectivity-class errors do NOT count toward the circuit breaker** (2.3b). They're handled by the wait-and-ping loop, not the row-failure path. Breaker stays focused on structural problems.

**Why ping both:** PestPac downtime is operationally distinct from internet outages. Different diagnosis = different log category = different post-run analysis.

**Implementation:**
1. `index.html`: add three new inputs to Run settings card. Two-column layout (regroup existing inputs).
2. Pass new settings into `startRun()` payload, `start-automation` IPC, `buildRunner` substitution.
3. Runner: reference `SELECTOR_TIMEOUT` constant in all `waitForSelector` calls. Use `PAGE_LOAD_MODE` in navigate steps. Use `RETRY_COUNT` in retry catch.
4. Runner: add error classifier function (`classifyError(err)`).
5. Runner: add ping helper (`pingHosts(['google.com', 'app.pestpac.com'])` — parallel, short timeout, returns `{google: bool, pestpac: bool}`).
6. Runner: integrate classifier + pings into the row-error catch path. Trigger wait-and-ping loop on confirmed outages.
7. Runner: emit `connectivity-wait` heartbeat events during wait loops.
8. Renderer: handle new heartbeat phase, display message.
9. Persist all three settings to flow JSON.
10. Validate via `_validate-runner.js`.

**Out of scope:**
- Parallel page tabs within one runner (BUUA).
- Skipping the logout step on success.
- Reusing browser context across runs.
- Pause-on-disconnect (full pause/resume state) — captured for BUUA; v1.2.5 uses wait-and-ping which is functionally similar but simpler.

---

### 2.10 Error log enrichment

**Symptom:** Today's Errors-sheet entry says "errored at https://app.pestpac.com/Customer/Edit/12345" — useful for finding the customer, useless for diagnosing what BUU was trying to do at the moment of failure.

**Fix:**

**New columns** added to **both Errors sheet AND Skipped sheet** (Skipped is the primary forensic surface under new 2.3):

| Column | Description |
|---|---|
| **Error category** | `internet-down` / `pestpac-down` / `unknown-network` / `timeout` / `selector` / `validation` / `connectivity` / `server` / `unknown` (per 2.8 taxonomy) |
| **Phase** | `pre-action` (waitForSelector failed) / `action` (click/type itself failed) / `post-action` (assertion or follow-up failed) / `init` / `reauth` / `cleanup` |
| **Step #** | "Step 4 of 12" |
| **Step type** | `click` / `type` / `select` / `navigate` / `assert` / etc. |
| **Step label** | Human-readable name from flow if user provided one. Empty if not. |
| **Field/selector** | Resolved selector string. e.g., `input[name="UserDef1"]` |
| **Attempted value** | Rendered token value (truncated to 100 chars + `…` suffix if cut). Empty for click/navigate/assert. |

**Column ordering left-to-right:**
```
Row | Status | Error category | Phase | Step # | Step type | Step label | Field/selector | Attempted value | URL | Error message | Timestamp
```
Most-actionable left, most-detailed right. Pivot-friendly.

**Auto-filter + freeze-pane:** enable on header rows of Errors, Skipped, and All-rows sheets. exceljs supports `worksheet.autoFilter` and `worksheet.views[0].state = 'frozen'`.

**Synthetic All-rows entries for non-row events** (login, reauth, breaker trip, browser crash):
- Phase column captures the event type (`init` / `reauth` / `cleanup`).
- Step columns are empty.
- Status reflects the event (`success` / `error` / `reauth` / `circuit-breaker`).
- Each event becomes a visible row in the All-rows timeline so the run history is complete.

**Summary sheet: "Stopped reason" cell.** Empty on clean completion. Populated on non-clean exit:
- Breaker trip → "Stopped after N consecutive errors at row X"
- Re-auth fail → "Re-auth failed at row X"
- Browser crash → "Browser crashed at row X"
- User stop → "Stopped by user at row X"

**Backward compatibility:** old logs (pre-v1.2.5) read fine for retry-failed (2.12) and resume (2.7) — they just lack the rich columns. New logs are forward-only.

**Implementation:**
1. Runner template: in `runStep` catch, extend error object with `stepIndex`, `stepType`, `stepLabel`, `selector`, `attemptedValue`, `phase`, `errorCategory`.
2. Runner template: error classifier (shared with 2.8) populates `errorCategory`.
3. `flush()` in main.js (Excel writer): add new columns to Errors and Skipped sheet headers. Write new fields per row. Apply auto-filter + freeze-pane to all relevant sheets.
4. Runner template: emit synthetic events for login, reauth (per 2.11), breaker trip (per 2.3b), browser crash. `flush()` writes them as All-rows entries with appropriate Phase.
5. Summary sheet: add "Stopped reason" cell, populate from runner's exit-reason event.
6. Validate: induce three error scenarios on a 5-row test flow:
   - Bad selector → log shows phase=`pre-action`, errorCategory=`selector`
   - Empty cell in source data → log shows attemptedValue empty, errorCategory=`validation` or `unknown`
   - Disconnect WiFi mid-run → log shows errorCategory=`internet-down`, wait-and-ping events visible

**Out of scope:**
- Screenshot-on-error (BUUA).
- DOM snapshot dump on error (BUUA).
- Per-attempt retry history (BUUA).

---

### 2.11 Re-auth: timer + connectivity-wait + detection-based

**Symptom:** PestPac enforces an absolute session lifetime (~6 hours suspected) regardless of activity. The 5/1 run hit this at the 6-hour mark; for the next 18 hours every navigation landed on the login page (no `UserDef1` field) and every row failed.

**Fix:** Three triggers for re-auth, all calling shared `loginToPestPac()`, all resetting the 2-hour timer:

1. **Timer-based** — every N minutes of elapsed run time (default 120, configurable 0-480, 0=disabled), between rows.

2. **Connectivity-wait based** — after a wait-and-ping loop > 10 minutes recovers (per 2.8). Cheap insurance against session expiration during outages.

3. **Detection-based (NEW)** — after every navigation, check whether the page that loaded is actually the page we expected, or whether we got bounced to login. If login-page detected → re-auth on the spot, then re-attempt the original navigation.

**Detection mechanism (post-`page.goto`):**
- Does the URL contain `login.pestpac.com`?
- AND does `a[href*="AutoLogin"]` (the post-login-verify selector) NOT appear within ~1 second of waitForSelector?
- AND does `input[name="uid"]` or `input[name="username"]` appear?

If all three: we're on the login page. Trigger re-auth, re-navigate to original URL, continue the row.

**Why detection-based is core, not a stretch:**
- Catches session loss *immediately* on the next navigation, not on row-after-the-row that failed.
- Eliminates the 20-failed-row recovery window before circuit breaker would otherwise fire.
- Keeps the breaker sharp for *true* structural problems.
- Robust to PestPac's actual session ceiling being different from 6 hours (or changing in the future).

**Logout-then-login mechanism (per locked decision — conservative):**
1. Navigate to PestPac logout URL (or click logout button — TBD during impl, prefer URL if reliable).
2. Wait for login page to load.
3. Fill credentials (in-memory from initial keytar pull at run-start — NOT re-fetched).
4. Submit.
5. Verify post-login by looking for `a[href*="AutoLogin"]` selector.

If step 5 fails: fatal re-auth error → preserve checkpoint per 2.7 → exit. Resume-on-launch handles the recovery.

**Run setting:** "Re-auth every N minutes" — default `120`, range `0-480`. Lives on Run settings card alongside other speed/resilience settings. Persisted to flow JSON.

**Logged as synthetic All-rows entries** with Phase=`reauth`, status=`reauth` (success) or `error` (fail), per 2.10.

**Implementation:**
1. Runner template: factor out `loginToPestPac()` from initial-login code path into a reusable function.
2. Runner template: track `lastAuthAt = Date.now()`. Update at run-start login and on every re-auth.
3. Runner template: between every row, check `Date.now() - lastAuthAt >= reauthIntervalMs && reauthIntervalMs > 0`. If true, run re-auth, reset `lastAuthAt`.
4. Runner template: after every `page.goto`, run detection check. If login-page detected, re-auth, re-navigate, continue row.
5. Runner template: emit `reauth` synthetic event (via stdout JSON) at re-auth start and end.
6. `index.html`: add re-auth interval input. Default 120, min 0, max 480.
7. Persist to flow JSON and IPC payload.
8. Validate (post-ship — needs real PestPac):
   - Set re-auth interval to 5 minutes. Run a small flow. Confirm re-auth fires at 5-min mark, runs cleanly, doesn't break in-flight rows, log entries appear.
   - Manually clear PestPac cookies via devtools mid-run. Confirm next navigation triggers detection-based re-auth.
   - Set re-auth interval to 0. Confirm runner behaves as today (no timer-based re-auth).

**Scope:**
- All three triggers, single shared login function, single shared timer.

**Out of scope:**
- Click-detection on logout button (we use URL-based logout if reliable; click-based fallback only if needed during impl).
- Adaptive re-auth cadence (e.g., learn PestPac's actual session ceiling over time). BUUA.

---

### 2.12 Retry failed rows (NEW)

**Symptom:** When a run completes with skipped rows, the user has no automated way to retry just those rows. They'd have to manually pull failed rows out of the log, build a new spreadsheet, run again. Friction prevents the recovery loop from being a daily-use tool.

**Fix:** Add a "Retry failed rows" capability for completed runs.

**Scope:**

1. **Post-completion only.** Retry-failed appears after a run **finished** (every row processed). Breaker-tripped runs, browser crashes, fatal re-auth fails go through **resume** (2.7), not retry-failed. This split keeps the two concepts cleanly separated:
   - **Resume** = "the run didn't finish, finish it"
   - **Retry-failed** = "the run finished, redo the rows that didn't work"

2. **What rows are included:** any row that wasn't completed successfully — i.e., status in {`skip`, `error`}. Synthetic non-row entries (`init`, `reauth`, `circuit-breaker`) are excluded.

3. **Architecture: runner-mode, not temp spreadsheet.** Pass `retryRowIndexes: [...]` to the runner template. The row loop iterates the original spreadsheet but only processes rows whose index is in the target set. Skipped (not-in-set) rows don't even count toward `totalRows` (which becomes `retryRowIndexes.length`). No new file on disk, no extra disk management.

4. **Flow-lock prompt-on-divergence.** When user clicks "Retry failed rows":
   - If saved flow JSON matches the run's `flowSnapshot` → use it, no prompt.
   - If they diverge → prompt:
     ```
     The flow has been edited since this run. Retry with:
     [Original flow]   [Current flow]   [Cancel]
     ```
   - User picks. Original = use `flowSnapshot` from checkpoint v2. Current = use the saved flow JSON.

5. **Separate log file for the retry run.** Cleaner audit trail. Original log preserved unchanged. Retry-of-the-retry just uses the new log's failed rows.

6. **UI placement:** post-completion summary modal/panel offers a "Retry N failed rows" button when the run finished with at least one failed row. (Run Log tab integration is *not* in this scope — it depends on the v1.2.4 backlog item to make historical logs scannable, which is a separate piece of work.)

7. **Source-row mapping safety.** If user has *modified* the source spreadsheet between original run and retry, indexes may mismap. Retry should read the source workbook and verify row count matches log expectations, refuse to proceed if not. Surface as: "Source spreadsheet has changed (was 6,278 rows, now 6,290). Cannot reliably retry failed rows."

**Implementation:**
1. Runner template: accept `retryRowIndexes` parameter. Row loop: `if (retryRowIndexes && !retryRowIndexes.includes(rowIdx)) continue;`. `totalRows` becomes `retryRowIndexes.length` for progress reporting.
2. Renderer: log-file reader (shared with 2.7) extracts failed-row indexes from completed log.
3. Renderer: post-completion summary gains "Retry N failed rows" button when `failedRowCount > 0`.
4. Renderer: flow-divergence check (compare `flowSnapshot` to current saved flow JSON). Prompt if divergent.
5. Renderer: source-row-count safety check before invoking retry runner.
6. Validate: complete a small run with intentional failures, click Retry, confirm only failed rows are re-attempted, confirm new log file written, confirm successes from original run aren't re-touched.

**Out of scope for v1.2.5:**
- Run Log tab integration (depends on v1.2.4 backlog historical-log scan).
- Automatic re-retry on new failures.
- Merging retry results into original log (deliberately separate logs for audit clarity).

---

## 3. SCOPE BOUNDARIES

### 3.1 What v1.2.5 IS
- **Reliability work:** 2.3, 2.3b, 2.7, 2.8 network-aware, 2.11 (catastrophic-failure prevention).
- **Speed work:** 2.2, 2.8 settings (5x or better throughput on long runs).
- **Diagnostic work:** 2.10 (post-run forensics that's actually useful).
- **Recovery work:** 2.7 resume + 2.12 retry-failed (failed runs are recoverable, not lost work).
- **UX work:** 2.1, 2.4, 2.5, 2.6 (pain points removed).

### 3.2 What v1.2.5 IS NOT
- Not the GitHub raw cache fix (real bug; defer to BUUA which can use a non-cached endpoint).
- Not historical run-log scanning in the Run Log tab (separate v1.2.4 backlog item).
- Not multi-runner / queues / unattended operation (BUUA).
- Not API integration (BUUA, blocked on WorkWave support).
- Not pause-on-disconnect (wait-and-ping is the v1.2.5 substitute; full pause/resume state is BUUA).

### 3.3 What WILL stay
- All v1.2.4 behavior (start-mode picker, pause panels, run-control IPC, unified runner).
- All v1.2.3 instrumentation (logs, checkpoints, heartbeats, retry-on-EBUSY, resume-on-launch as foundation).

---

## 4. IMPLEMENTATION ORDER (SUGGESTED)

Items grouped by safety / dependency.

**Phase 1 — Trivial UI (low logic risk, ~30 min):**
1. **2.2** default delays = 0-0 — single attribute change.
2. **2.6 part 1** Build button rename + icon swap (logic deferred to phase 4).

**Phase 2 — Small logic (config + UI, ~60 min):**
3. **2.1** remember last dir.
4. **2.5 Import-side** convert chip-styled list to plain reference list.
5. **2.3** errHandle dropdown two-option + saved-flow upgrade + runner relabel.

**Phase 3 — Settings infrastructure (~90 min):**
6. **2.8 settings** — three new inputs. Two-column Run settings card. Persistence + IPC pass-through.
7. **2.3b** circuit breaker.
8. **2.11 settings UI** — re-auth interval input (logic in phase 6).

**Phase 4 — Validation revamp (~3-4 hr):**
9. **2.6 parts 2-5** — non-blocking prompt, navigate-to-fix, all-at-once highlighting, live re-validation, delete Validate page.

**Phase 5 — Token chip drag-and-drop (~60-90 min):**
10. **2.5 Build-side** — drag-only chip behavior.

**Phase 6 — Resume + retry semantics (~3 hr):**
11. **2.7** runner: rework `finally`, write `lastError`/`lastStop`, accept retry/resume params.
12. **2.7** renderer: log-file reader, updated resume modal.
13. **2.4** stop path collapse.
14. **2.12** retry-failed.

**Phase 7 — Network resilience (~3 hr):**
15. **2.8 network-aware** — error classifier, ping helper, wait-and-ping loop.
16. **2.11 logic** — factor `loginToPestPac()`, timer + detection.

**Phase 8 — Error log enrichment (~90 min):**
17. **2.10** — runner extends error object, `flush()` writes new columns + auto-filter, synthetic events.

**Phase 9 — Ship:**
18. Bump versions, build, smoke test, commit, tag, push, publish release.

**Total realistic estimate: 15-20 hours.**

---

## 5. INTERACTIONS WORTH NAMING

- **2.3 + 2.8:** "Retry" mode uses 2.8's retry count.
- **2.3b + 2.7:** breaker trip preserves checkpoint with `lastError: { phase: 'circuit-breaker' }`.
- **2.3b + 2.8:** connectivity-class errors do NOT count toward breaker.
- **2.4 + 2.7:** both Stop buttons share clean-shutdown + "Keep checkpoint?" prompt.
- **2.7 + 2.12:** share `extractFailedRowsFromLog(logPath)` helper. Share `retryRowIndexes` parameter.
- **2.8 + 2.11:** connectivity-wait > 10 min triggers re-auth before retry. Re-auth resets the 2-hour timer.
- **2.10 + 2.8:** errorCategory column reflects post-ping classification.
- **2.10 + 2.3b:** breaker trip = synthetic All-rows entry + "Stopped reason" Summary cell.
- **2.11 + 2.7:** re-auth failure = fatal exit = checkpoint preserved.

---

## 6. POST-SHIP VALIDATION (CANNOT BE DONE PRE-SHIP)

- **2.4** stop-from-pause regression — verification mode run, Stop from pause, click Run again immediately.
- **2.11 timer-based re-auth** — set interval to 30 min, confirm re-auth fires, log entries appear.
- **2.11 detection-based re-auth** — clear PestPac cookies via devtools mid-run, confirm next navigation triggers detection.
- **2.8 network-aware retry** — disconnect WiFi during run, confirm wait-and-ping loop activates.
- **2.10 error categorization** — induce known errors, confirm logged categories match.
- **2.12 retry-failed** — complete a run with intentional failures, click Retry, confirm only failed rows re-attempted.

---

## 7. OPEN QUESTIONS DURING IMPLEMENTATION

1. **2.4:** does `proc.on('close')` fire reliably on the runner's clean-exit path?
2. **2.11 logout:** does PestPac have a clean logout URL, or do we click a logout button?
3. **2.8 ping:** what's the right ping mechanism in Node (DNS lookup vs HTTP HEAD vs TCP connect)?
4. **2.6 step ID stability:** are existing step IDs reliable for navigate-to-step, or do we need a stable ID scheme?
5. **2.1 config helper:** does `buu-config.json` already have read/write helpers?

---

## 8. END

After v1.2.5 ships, BUU enters bug-fix-only mode. Anything bigger goes to BUUA.

If a new failure mode surfaces during implementation that isn't covered above, capture it as a new item before implementing. Don't expand scope silently.

**Last updated:** 2026-05-04 (post-walkthrough revision; design fully locked).
