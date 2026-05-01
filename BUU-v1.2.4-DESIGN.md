# BUU v1.2.4 DESIGN — Unified Run with In-Run Verification

**Status:** Design notes only. To be implemented AFTER v1.2.3 ships and is validated.
**Author:** Outgoing Claude (work account, 2026-05-01), per Matthew's spec.
**Priority:** Next thing after v1.2.3 ship.

---

## 1. THE PROBLEM

Today BUU has two completely separate code paths for running a flow:

- **Live Dry Run** (Build/Test page) — spawns chromium, walks through steps with manual `next` / `next-row` / `run-all` controls. Used for verifying selectors and flow logic before going production. Does NOT write logs, checkpoints, or row-progress events. Uses `dryrun-event` IPC channel.
- **Run** (Run page) — spawns chromium via `buildRunner` template, fire-and-forget end-to-end. Writes Excel logs, checkpoints, heartbeats, etc. Uses `automation-event` IPC channel.

**Workflow problem:** Matthew today has to run a Live Dry Run to verify the flow works, then start a *separate* Run from row 1 — duplicating the row-1 work and breaking the mental model. The dry-run results aren't preserved when transitioning to the real run.

**The session that uncovered this** (2026-05-01): Matthew ran what he thought was a real run on a 1k-row test sheet, saw the browser process rows, but Run-progress UI stayed blank and no logs appeared. We thought v1.2.3 was broken. **It wasn't.** He'd actually clicked Live Dry Run from Build/Test, not Run from Run page. Diff 7's instrumentation never fires for dry runs because dry-run is a separate IPC handler entirely. The two-path design itself is the bug.

---

## 2. THE DESIGN (PER MATTHEW'S SPEC)

**One unified concept: just "Run."**

A real automation run with adjustable verification depth at the start. There is no separate "dry run" mode anymore — dry-run-as-a-feature is absorbed into the start-of-run experience.

### 2.1 What the user sees

Run page → click Run. A **start-mode picker** appears (modal or pre-run panel) with these options:

| Mode | What happens |
|---|---|
| **Step through** | Browser opens, executes ONE step, then pauses. User clicks "Next step" to advance. After last step on a row, asks: "next row" / "run all" / "stop". |
| **Step through rows** | Browser opens, executes one full row end-to-end, then pauses. User clicks "Next row" or "Run all" or "Stop". |
| **Pause after row N** | Runs N rows (default 1) end-to-end, then pauses with the same options. |
| **Run all (no verification)** | Current Run behavior. Fire-and-forget through all rows. |

User's chosen mode is the *starting* mode. From any pause point, they can switch to "Run all" to release the brake and let it finish autonomously.

**No matter what mode is chosen, this IS a real run.** Logs are written. Checkpoints are written. If interrupted, it's resumable. No work is wasted — verification rows count toward completion.

### 2.2 Why this is better than today's two-path system

- **No duplicated work.** Verify rows 1-3 carefully, then say "run all" — rows 4-1000 just continue. Today: have to start over from row 1.
- **One mental model.** "I am running an automation" — verification is just a setting, not a different feature.
- **One code path.** All instrumentation (logs, checkpoints, heartbeats, run guards, resume-on-launch) applies uniformly. No more "v1.2.3 fixes don't apply because you used the other thing."
- **One IPC channel.** `automation-event` only. `dryrun-event` is removed.
- **The Build/Test page can stay** for selector probing (paste-HTML auto-selector workflow on individual elements), but loses the "Live Dry Run" button. Selector probing doesn't need a runner — it can be done with a one-shot Playwright call inline.

### 2.3 The state machine in the runner

The runner's main loop today is roughly:

```
for each row:
  for each step:
    execute step
  emit row-complete
emit complete
```

The new loop:

```
mode = startMode  // 'step', 'step-row', 'pause-after-N', 'run-all'
pauseAfterN = N (if applicable)

for each row (rowIndex starting at resumeFrom):
  for each step (stepIndex):
    if mode == 'step' AND not first time at this point:
      emit pause-step  // with rowIndex, stepIndex, current row data, current step
      cmd = await stdin  // 'next-step' | 'next-row' | 'run-all' | 'stop'
      apply cmd to mode
    if mode == 'stop': cleanup and exit
    execute step
  // end of row
  saveChk(rowIndex)
  emit row-complete
  if mode == 'step-row' OR (mode == 'pause-after-N' AND rowIndex == pauseAfterN):
    emit pause-row  // with rowIndex, success/error stats so far
    cmd = await stdin
    apply cmd to mode
  if mode == 'stop': cleanup and exit

emit complete
```

Key implementation notes:
- **Stdin is the control channel** (already used by dry-run today). Runner reads JSON-line commands from stdin: `{"cmd":"next-step"}`, `{"cmd":"next-row"}`, `{"cmd":"run-all"}`, `{"cmd":"stop"}`, `{"cmd":"pause-after","n":5}`.
- **Main process exposes IPC handlers**: `run-control` accepting `{runId, cmd, payload}` that writes to the runner's stdin. Plus existing `stop-automation`.
- **Browser stays open during pauses.** Important: do NOT close+reopen between steps. Login state, cookies, navigation context all persist.
- **Pause emits include the rendered row data** so the UI can show "About to type 'John Smith' into First Name field for row 47" — making verification meaningful.
- **`headless: false` is implied** for any verification mode. Step-through with headless makes no sense. UI should disable headless when a verification mode is selected.

### 2.4 UI on the Run page

Existing Run page gets:
- A "Start mode" radio group or dropdown above the Run button
- During a run, if currently paused: status shows "Paused at row N, step M" with control buttons:
  - **Next step** (only in step mode)
  - **Next row** (in step or step-row mode)
  - **Pause after [N] more rows** (input + button, switches to pause-after mode with a fresh counter)
  - **Run all** (releases brake, runs to end)
  - **Stop** (clean shutdown, saves checkpoint)
- During autonomous "Run all" phase: the existing v1.2.3 progress UI (heartbeat, elapsed counter, stats boxes) — unchanged.

### 2.5 What to KEEP from today's Live Dry Run

The actual UX of stepping through one step at a time is good. The mistakes were architectural (separate path, no logs, no checkpoint, separate IPC channel), not UX. Keep:
- Visual highlight of the element being acted on before the action fires
- Display of the rendered value (after `{{column}}` substitution) before typing/clicking
- Display of the current row's data on the side
- The ability to skip a step or retry a failed step

These move into the unified run's pause UI on the Run page.

---

## 3. SCOPE BOUNDARIES

### 3.1 What v1.2.4 IS
- Unified runner with mode-aware pause/resume
- Run page UI updates (start-mode picker, in-run pause controls)
- Selector probe replacement on Build/Test page (one-off, doesn't need a runner subprocess)
- Removal of `start-live-dryrun`, `dryrun-next`, `dryrun-nextrow`, `dryrun-runall`, `stop-dryrun` IPC handlers
- Removal of `dryrun-event` channel and `buildDryRunner`
- Removal of `buu-dryrun-*.js` temp file pattern (folded into runner)

### 3.2 What v1.2.4 IS NOT
- Not multi-runner concurrency (still v1.3.0)
- Not the queue/folder system (still v1.3.0)
- Not email pickup (still v1.4.0)
- Not changes to flow/profile/credential storage
- Not changes to checkpoint format (already v2 from v1.2.3 — just keeps using it)
- Not changes to the Excel log format

### 3.3 What WILL stay
- v1.2.3's Diff 7 fixes (logs created up front, loud-fail alerts, retry-on-EBUSY, summary-always-written) — all carry over uniformly
- v1.2.3's resume-on-launch — works the same; resumable from any pause point because checkpoints are written per-row regardless of mode
- v1.2.3's heartbeat events during long phases (login, cleanup) — unchanged
- v1.2.3's run guard (single concurrent run) — unchanged

---

## 4. IMPLEMENTATION ORDER (SUGGESTED)

Once v1.2.3 ships and is validated:

1. **Refactor `buildRunner` to support pause states.** Add stdin command reader, mode state, pause-emit logic. Test with run-all mode first to ensure no regression.
2. **Add `run-control` IPC handler in main.js** that writes to runner stdin.
3. **Update Run page UI** with start-mode picker.
4. **Update Run page UI** with pause-state controls (only show when paused).
5. **Validate end-to-end:** run in step mode, verify it pauses, click next-step, verify it advances, switch to run-all, verify it completes.
6. **Replace the Build/Test selector test mechanism** with inline Playwright (one-shot, no runner). This is a separate small change.
7. **Remove dry-run code paths** (`start-live-dryrun` handler, `buildDryRunner`, `dryrun-event` listeners, dry-run UI on Build/Test page).
8. **Smoke test the full set of v1.2.3 scenarios** under the new runner to confirm no regressions:
   - Run guard (already running)
   - Heartbeat during login
   - Live counters during run
   - Excel log Summary always written
   - Resume from checkpoint after Stop
9. **Ship as v1.2.4.**

---

## 5. OPEN QUESTIONS FOR MATTHEW

These don't block design but should be settled before coding:

1. **Default start mode?** Suggest "Step through rows" (pause after each row) — feels safest as the default. "Run all" stays one click away.
2. **Where does the start-mode picker live?** Above the Run button as a dropdown (compact), or in a modal that appears after clicking Run (more deliberate)?
3. **When in step-through-step mode, should it pause BEFORE executing each step (preview) or AFTER (review)?** Preview is more useful — lets you verify the action *before* it commits. But the value substitution happens at execute-time, so preview means we have to render values up front and pass them to the pause emit.
4. **Pause-after-N: does N reset on each pause?** I.e., user says "pause after 5 more rows" while paused at row 3 — does it pause at row 8 (N additional from current)? Suggest yes.
5. **What happens if a step errors during step-through?** Today's `errHandle` is `'stop'` or `'skip'`. In step mode, suggest a third option appears at the pause: "Retry this step / Skip this row / Stop run."

---

## 6. CONTEXT FROM 2026-05-01 SESSION

The misclick-and-misdiagnose chain that led to identifying this as a real design issue:

1. Matthew installed v1.2.3 yesterday (4/30), ran a 16k file via what he thought was Run, it "quit somewhere in the middle, no log, no progress."
2. He told me today: "i need to start using this again asap." Re-ran on a 1k test today. Same symptoms.
3. I confirmed BUU had been running continuously since 4/30 8:33 AM — Electron caches in-memory, so v1.2.3 binary on disk wasn't loaded into the running process. We restarted BUU.
4. Re-ran with fresh BUU. Same symptoms. Investigated disk: no log files written, no checkpoints, but bundled chromium WAS spawned.
5. Found `buu-dryrun-1777660971359.js` in TEMP. **The runner subprocess was a dryrun, not a real run.** Matthew had been clicking Live Dry Run from Build/Test, not Run.
6. Confirmed v1.2.3 hasn't actually been smoke-tested yet — still need to run it from the Run page.
7. Matthew responded: this two-path design is wrong and shouldn't have shipped that way. Unify them. Hence this design doc.

The takeaway for the next Claude: **don't theorize about why instrumentation isn't firing without checking which IPC handler actually got called.** A `buu-dryrun-*` temp file is the smoking gun for "this was a dry run, not a real run."

---

## 7. END

Once v1.2.3 ships, delete this file and replace it with the actual v1.2.4 implementation diffs. Or fold its content into the main HANDOFF.md if a new handoff is being written.

---

## 8. v1.3.0 ADDITION — FAILURE NOTIFICATIONS

**Added by Matthew on 2026-05-01 during the v1.2.3 first production run.**

**The need:** When a long run fails or completes mid-day-or-overnight while Matthew is away from his computer, he needs to know immediately rather than discovering it hours later. No mechanism exists today.

**Scope:** Notifications on these events, configurable per-event:
- Run started (optional, off by default)
- Run completed successfully
- Run failed (fatal error)
- Run hit error threshold (e.g., >5% errors in last N rows — early-warning signal that something is structurally wrong)
- Run paused awaiting input (when v1.2.4 verification mode is in use and BUU has been waiting >10 min)
- Resume modal needs attention on launch (orphan checkpoint detected)

**Channels — easiest to hardest:**
1. **Email** — easiest. SMTP config in profile/settings, nodemailer module. Works to any phone via carrier email-to-SMS gateway as a fallback.
2. **Push notification via a service like Pushover or ntfy.sh** — slightly more involved, requires Matthew sets up an account. Better UX than SMS.
3. **Direct SMS** — requires Twilio or similar paid service. Best UX for "you must look at this NOW" but operational overhead.
4. **Phone call** — Twilio Voice. Heavy weapon. Save for catastrophic failures only.

**Suggested v1.3.0 implementation:** ship email-only first (low complexity, covers 80%), structure the code so additional channels are pluggable. Push and SMS can come in 1.3.1 / 1.3.2.

**Design notes:**
- Notifications live alongside the queue/job system, so per-job overrides are possible (priority job = also text me, low-priority = email only)
- Throttle/debouncing — never send more than 1 notification per 5 min for the same run
- Test-notification button in settings so Matthew can verify config without waiting for a real failure
- Email body should include log path, run summary, and the BUU URL for the offending row if applicable
