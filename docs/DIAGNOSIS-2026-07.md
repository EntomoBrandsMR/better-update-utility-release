# DIAGNOSIS — Phase 1 findings (2026-07-10)

Read-only root-cause pass. No fixes here; fix directions live in TODO.md Phase 3.

## D1 — Lingering "BUU 2.0" processes + no-update-prompt  [DIAGNOSED]

**Verified in source (src/main.js):**
1. Workers are spawned as `spawn(process.execPath, [runnerPath, ...])` with
   ELECTRON_RUN_AS_NODE=1, stdio piped, NOT detached (~line 391). process.execPath
   IS "BUU 2.0.exe" — every worker shows in Task Manager under the app's own name,
   each owning a headless Chromium process tree.
2. NOTHING kills workers on app quit. The only `.kill()` in the codebase is the
   stop-path force-kill loop (~line 1588). There is no before-quit/will-quit
   handler at all, and no mainWindow close handler.
3. Windows does not auto-terminate children when a parent exits. Closing BUU with
   workers alive (mid-run, or wedged in the old 4-step logout dance with its 150s
   budget) orphans them indefinitely. The fragile logout (see item 34 redesign)
   is the main producer of workers that outlive a "finished" run.
4. `second-instance` handler (~line 3626) only restore()+focus(). checkForUpdates
   runs ONLY in `ready-to-show` — i.e. only on a truly fresh launch.

**No-update-prompt mechanism:** reopening BUU while any prior main process is
alive = second instance = focus only, never a re-check. Combined with (1)-(3),
"BUU looks closed but isn't" is common, so fresh launches are rare → prompt
rarely seen.

**Open question (needs a live specimen):** whether the MAIN process itself ever
lingers after window close despite `window-all-closed → app.quit()` (no
preventDefault exists in source). Static reading says it should exit; KNOWN-BUGS
asserts it lingers. Confirm on first reproduction; either way the fixes below
cover both cases.

**Fix directions (already in plan):** pidfile of spawned workers + kill-survivors
sweep on launch; worker self-shutdown on coordinator IPC disconnect (spill →
logout → exit); second-instance calls checkForUpdates; new one-URL logout with
5s budget + 10s force-kill fuse makes wedged workers rare.

## D7 — Reauth dead on long runs  [DIAGNOSED]

**Verified in source (worker template, ~line 2749):**
Reauth is TIMER-ONLY: `if (nextReauthAt > 0 && Date.now() >= nextReauthAt)` at row
boundaries. 0 = off. There is NO failure-triggered reauth anywhere: nothing detects
"I've been redirected to the login page" or "selectors missing because session died."
The code comment claims "per-row failure + network-aware retry gate handles it" —
FALSE: per-row retry re-runs the row's steps against the dead session; every retry
fails identically; the retry gate is network-error-aware, not auth-state-aware.
Result: session drops between timer ticks (or interval=0) → every subsequent row
fails through. Exactly matches the 3,557-row fail-through.
Also: reauth-attempt failure is swallowed with a log line and the row runs anyway.

**Fix direction:** auth-state detection in the engine — on row failure (or before
retry), check page URL/DOM for login page; if logged out → re-login → retry row
ONCE. Timer reauth becomes optional maintenance, not the recovery mechanism.

## D2 — Stop-hang; "worker re-logs-in on stop"  [DIAGNOSED]

**Verified in source:**
1. pool-stop (~line 1570) sends 'drain' only. Drain is checked BETWEEN rows
   (~line 2736, before the reauth check — reauth does NOT fire on drain).
   A worker MID-ROW finishes the ENTIRE row first: NAV_TIMEOUT is hardcoded 90s,
   selector waits 30s, retryCount default 2 — a stuck row legitimately grinds for
   several minutes after Stop is pressed. That is the "hang."
2. Then the old 4-step logout dance runs with its 150s budget. Grind + dance can
   exceed the 180s force-kill → worker killed MID-LOGOUT → session leaked.
3. pool-stop schedules coordRunLogoutSweep at 180s + 4s after stop. The sweeper
   LOGS IN with the run's profile ~3 min after Stop. This is almost certainly the
   observed "re-logs-in on stop" — it's the sweeper (or a worker's logout dance
   bouncing through pages), not a worker restarting work.

**Fix direction (mostly already in plan):** stop = drain + a step-boundary stop
signal (abandon current row as error reason=stopped, don't grind retries); new 5s
one-URL logout; force-kill fuse ~10s; sweeper stays but fires promptly after
workers exit rather than on a fixed 184s clock; per-step timeout replaces
hardcoded 90s/30s.

## D3 — Typing lockup / flaky inputs  [DIAGNOSED — high confidence, confirm live on big rig]

**Verified in source:**
1. `coordEmitStatus()` fires at the END of `coordHandleWorkerMessage` (main.js ~line
   622) — i.e. on EVERY message from EVERY worker (step events, row-start, row-result,
   log lines). No throttle. N workers × several messages/sec = tens to hundreds of
   status broadcasts per second on big runs.
2. Each broadcast makes the renderer run `renderCoordStatus`, which does
   `grid.innerHTML = (st.workers||[]).map(...)` (index.html ~3356) — a FULL DOM
   teardown+rebuild of every worker card, per message. Plus renderStagedJobs each time.
3. At 100+ workers (the main rig's runs), that's hundreds of heavy full-grid rebuilds
   per second → the renderer main thread saturates → every input in the app starves:
   keystrokes dropped or dead ("can no longer type"), number inputs flaky, UI laggy.
   The step editor's 200ms-debounced validation (runValidation on keystroke) compounds
   under the same thread contention but is not the primary cause.

**Why it feels widespread and intermittent:** severity scales with worker count ×
message rate. Few workers = barely noticeable; big runs = the app is effectively
frozen for input. Matches "happens a lot" without a single reproducible trigger.

**Fix direction:** throttle status emits (coalesce to ~4/sec max, timer-based, not
per-message); renderer diff-updates worker cards (update text/class in place) instead
of innerHTML rebuild; keep all input controls outside any rebuilt container. The
adaptive-scaling sliders (R4) must live outside the status-rebuilt region.

## D4 — Step mode spawns extra workers / burns licenses  [DIAGNOSED]

Step-then-Release works by launching the pool with startMode='step'. Nothing gates
the ELASTIC LICENSE TIMER or desiredWorkers on step mode: pool-start (~1560) starts
COORD.licenseTimer unconditionally when elastic is on, and coordLicenseScale will
scale up workers while the user is still stepping through row 1 in worker 1.
Each scaled-up worker runs a full PestPac login (setupScope per-worker) = burned
licenses during verification. Fix (already in R5 spec): step mode pins the pool at
1 worker, elastic timer does not start until Release.

## D5 — Phantom "delete this note?" confirm  [DIAGNOSED — mechanism; needs flow repro to name the trigger step]

The dialog is not new behavior — it's newly VISIBLE. v2.2.3's blanket dialog listener
(worker template ~2642) observes and journals every dialog; before that, unhandled
dialogs were silently auto-dismissed by Playwright (= Cancel/dismiss) and never seen.
So: some action in the add-note flow has ALWAYS triggered PestPac's
confirm('Do you want to delete this note?'), it was auto-dismissed (Cancel path taken
silently), and since v2.2.3 it shows up in logs. Open sub-question: WHICH step fires
it (likely a mis-targeted click in the note editor). One step-debugger pass over the
add-note flow will name it. R3's explicit dialog checkboxes make the handling
deliberate either way.

## D6 — Overlay covers Add Profile modal  [CARRIED — fix direction known]

Per KNOWN-BUGS: setupOverlay/resumeOverlay/pasteModal sit above the Add Profile modal
(z-index/default-display ordering). Fix in rebuild: all overlays default display:none,
shown explicitly; audit z-index ladder once during the renderer cleanup. Not deeper-
diagnosed — the fix is structural and lands in R11's renderer pass.

## D8 — Step-then-Release logic  [DOCUMENTED — verified in source]

pool-start (~1500): startMode 'step'/'step-row' FORCES workers=1, batchSize=1;
the configured targets are remembered in COORD.startModeTarget and restored when the
user releases to Run-All via pool-run-control. Step modes launch the browser HEADED
(worker template ~2638: headless = !(step||step-row)); run-all launches headless.
This is the exact behavior to preserve through the rebuild (acceptance check).
GAP (=D4): the elastic license timer starts unconditionally at pool-start when
elastic is on — NOT gated on step mode — so elastic scale-up can spawn extra headed
workers mid-stepping. R5 spec: elastic timer must not start until Release.

## Phase 1 additional finding

verifyAfterAction defaults ON at pool-start (~1536) and adds one re-navigation per
row (5-15s) on top of being the false-mismatch generator (KB3). Its planned removal
(teardown list) also removes a hidden per-row time tax.

— Phase 1 complete. 8/8 diagnosed or documented. —
