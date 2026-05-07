# BUU v1.2.8 DESIGN — Setup and teardown flows

**Status:** Drafting 2026-05-07. Implementation NOT started. This doc must be reviewed and locked before any code is written.
**Author:** Claude (work account), per Matthew.
**History:** Originally drafted as v1.2.7. Renumbered to v1.2.8 on 2026-05-07 when an unrelated dialog-handler crash fix shipped as v1.2.8.
**Priority:** v1.2.8 introduces a single substantial new capability — flow composition. The change is small in user-visible footprint but architecturally meaningful: BUU's run model goes from a single per-row loop to a three-phase pipeline (setup once → main per-row → teardown once). Estimated effort: 15–20 hours.

**Strategic note:** As of 2026-05-07, the BUU/BUUA fork plan from `DESIGN-INDEX.md` is shelved. BUU continues to grow features. BUUA work is parked pending WorkWave API access. The "BUU enters bug-fix mode after v1.2.5" line in the index is no longer current and should be updated when this doc lands.

---

## 1. STRATEGIC CONTEXT

### 1.1 The motivating problem

The chargeback workflow exposed a structural limitation in BUU's run model. Today every flow is a single per-row loop:

```
log in → for each row in spreadsheet { run flow steps } → log out
```

Some real workflows don't fit. Specifically: PestPac's "post service orders to a batch" pattern requires:

1. **Once at start:** create a batch (or, equivalently, click `[ Add ]` on an existing BUU batch row to land on the same posting screen)
2. **Per row:** post a service order into the open batch
3. **Once at end:** release the batch

The "create the batch once and release it once" envelope cannot be expressed in today's flow model. Workarounds (one batch per order; manual release at end; running a second BUU flow as cleanup) are all inferior.

### 1.2 The decision

Add **flow composition** to BUU. A "main" per-row flow can declare a setup flow (runs once before the loop) and a teardown flow (runs once after the loop). All three phases share one logged-in browser session. The composition is a property of the saved main flow, not a per-run pick.

### 1.3 Why this and not something smaller

A "first-row only / last-row only" step-scoping mechanism was considered as a cheaper alternative (~4-6 hours vs ~15-20 hours). Step-scoping was rejected because:

- It bakes setup/teardown logic into the per-row flow, harder to read for non-technical operators
- Setup/teardown logic can't be reused across flows (every batched workflow re-implements create/release)
- It doesn't generalize cleanly to other once-at-start / once-at-end use cases Matthew anticipates (invoicing, reporting headers, etc.)
- The user explicitly chose the larger architecture after being shown both options

### 1.4 Why this is the right scope

Composition stops at one level: a main flow has setup and teardown, and that's it. Specifically:

- Setup and teardown flows are **once-flows** with no row context
- Once-flows cannot themselves have setup or teardown (no recursion)
- No "between rows" or "every Nth row" flows in v1.2.8
- No conditional branching ("run this teardown only if the main flow succeeded fully" etc.) — teardown runs on any non-fatal main-flow exit and that's that

The model is deliberately narrow because broader models (DAGs, conditional execution, nested composition) introduce mental-model complexity that doesn't pay off for the use cases on the table.

### 1.5 What this is not

- Not multi-runner concurrency (still BUUA territory if/when that resumes)
- Not API-based execution (BUUA, blocked on WorkWave)
- Not a new step type — setup and teardown flows use the same step types as today's per-row flows
- Not a UI overhaul — the Build page gets two new dropdowns and a runMode toggle, nothing more

---

## 2. DATA MODEL

### 2.1 Flow JSON schema changes

Today's flow JSON has top-level: `version`, `cols`, `steps`, `activeProfileId`, `ssPath`, `config`. Three new top-level fields:

```json
{
  "version": "1.1",
  "name": "chargeback-row",
  "runMode": "per-row",
  "setupFlowId": "release-batch-create",
  "teardownFlowId": "release-batch-cleanup",
  "cols": [...],
  "steps": [...],
  "activeProfileId": "...",
  "ssPath": "...",
  "config": {...}
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | string | yes (new flows) | filename stem | Human-readable identifier. Existing flows back-fill from filename on first save. |
| `runMode` | `'per-row' \| 'once'` | yes (new flows) | `'per-row'` | Existing flows upgrade silently to `'per-row'` on load. |
| `setupFlowId` | string \| null | no | null | The `name` of another saved flow with `runMode: 'once'`. Only valid when this flow has `runMode: 'per-row'`. |
| `teardownFlowId` | string \| null | no | null | Same constraints as setupFlowId. |
| `version` | string | yes | bumped to `'1.1'` | Used to recognize upgrade-needed flows. |

**Why `name` not `id`:** flow filenames already serve as identifiers. A separate stable ID is over-engineering for v1.2.8. If someone renames a flow, references break — that's acceptable for a small saved-flow library and makes the data file readable.

### 2.2 Once-flows: runMode semantics

A flow with `runMode: 'once'` differs from a per-row flow in three ways:

1. **No spreadsheet binding.** Setup/teardown flows have no `ssPath` or `cols` (those fields are ignored if present). The flow is invoked once per run, not once per row.
2. **No per-row tokens allowed.** Step values cannot reference per-row column tokens like `{{Account_Code}}`. Validation enforces this at flow-save time and at run-start.
3. **Limited token sources.** Once-flows can use:
   - **Static values** baked into the flow definition (e.g., a hardcoded URL, a static field value)
   - **Header-row tokens** sourced from the parent flow's spreadsheet (TBD scope — see §2.3)
   - **Run-context tokens** like `{{TODAY}}`, `{{RUNID}}`, `{{PROFILE_USERNAME}}` (a small fixed set, defined below)

### 2.3 Header-row tokens (deferred)

The v1.3.0/BUUA design specified a vertical A:B metadata format for spreadsheets (rows 1-N as `priority/flow/profile/...` key-value pairs, row N+1 blank as separator, row N+2 onward as data with column headers). That metadata, when present, would be a natural source for once-flow tokens (e.g., setup needs to know which branch to operate on).

**v1.2.8 does NOT implement header-row tokens.** Reason: the v1.3.0 spreadsheet format itself isn't shipped. Implementing one half (token-source) without the other (the format itself) introduces dead code. v1.2.8 ships once-flows that use only static values and run-context tokens. When the v1.3.0 spreadsheet metadata format ships in a later release, header-row tokens become the natural extension.

**For the chargeback case specifically,** static values are sufficient. The teardown flow is "navigate to batch list, find BUU row, click Release" — no per-job parameterization needed.

### 2.4 Run-context tokens

A small fixed set of tokens available in all flows (per-row and once):

| Token | Value | Notes |
|---|---|---|
| `{{TODAY}}` | `MM/DD/YYYY` of run start | Already-saved flows that hardcoded dates can switch to this. |
| `{{RUNID}}` | The run's UUID | Useful for batch-name generation, log correlation. |
| `{{PROFILE_USERNAME}}` | The PestPac username of the active profile | The "BUU" username. Critical for teardown flow's "find my batch" logic. |

Implementation: token resolver lives in the runner template, expanded at step-execution time. Per-row tokens (the `{{ColumnName}}` form) continue to come from the row data; run-context tokens come from a runner-level context object.

### 2.5 Validation rules

At flow-save time and at run-start, the validator enforces:

| Rule | Severity | Message |
|---|---|---|
| `runMode == 'once'` AND any step uses a `{{ColumnName}}` token | Error (blocks save) | "Once-flows cannot reference spreadsheet columns. Use a static value or a run-context token." |
| `runMode == 'once'` AND `setupFlowId` or `teardownFlowId` is set | Error (blocks save) | "Setup and teardown flows cannot themselves have setup or teardown." |
| `runMode == 'per-row'` AND `setupFlowId` references a flow with `runMode != 'once'` | Error (blocks save / run-start) | "Setup flow must have runMode 'once'." |
| Same for `teardownFlowId` | Error | "Teardown flow must have runMode 'once'." |
| `setupFlowId` or `teardownFlowId` references a flow that doesn't exist on disk | Error (run-start) | "Setup flow 'X' not found. Save it or remove the reference." |
| Once-flow's step uses a token outside the run-context allowlist | Warning | "Token `{{XYZ}}` is not a recognized run-context token. It will be passed through literally." |

The validation surface is shared with v1.2.5's non-blocking validation prompt: errors block save / run-start, warnings let the run proceed.

---

## 3. RUNNER ARCHITECTURE

### 3.1 Three-phase pipeline

The runner template (`buildRunner` in `src/main.js`) currently produces JS that does:

```
1. Launch browser
2. Log in to PestPac
3. Open spreadsheet, iterate rows, run main steps per row
4. Close browser
```

In v1.2.8 it produces JS that does:

```
1. Launch browser
2. Log in to PestPac
3. (if setupFlowId) Run setup steps once
4. Open spreadsheet, iterate rows, run main steps per row
5. (if teardownFlowId) Run teardown steps once
6. Close browser
```

All three phases share the same `browser` and `page` objects. No re-login between phases. No new process; everything runs in the existing single runner subprocess.

### 3.2 buildRunner signature change

Today's signature (`src/main.js:404`):

```js
function buildRunner(steps, logPath, checkpointPath, resumeFrom, headless, errHandle,
                    rowDelayMin, rowDelayMax, chromiumExePath, startMode,
                    selectorTimeout, pageLoadMode, retryCount, breakerThreshold,
                    reauthInterval, retryRowIndexes)
```

The signature is already 16 parameters. We're going to refactor to take a single config object, and add three new fields:

```js
function buildRunner(config) {
  // config.mainSteps, config.setupSteps, config.teardownSteps,
  // config.logPath, config.checkpointPath, config.resumeFrom,
  // config.headless, config.errHandle, config.rowDelayMin, config.rowDelayMax,
  // config.chromiumExePath, config.startMode, config.selectorTimeout,
  // config.pageLoadMode, config.retryCount, config.breakerThreshold,
  // config.reauthInterval, config.retryRowIndexes,
  // config.runContext: { runId, today, profileUsername }
  // ...
}
```

`setupSteps` and `teardownSteps` are arrays in the same shape as `steps` (re-using the existing step types). Either may be `null`/empty.

**Why the refactor:** 16 parameters is already past the readable bound. Adding `setupSteps`, `teardownSteps`, and `runContext` would push it to 19. The refactor is mechanical (shape is the same, access pattern changes from positional to named) and pays off for future additions. **Risk:** every call site of buildRunner has to change. There's effectively one — the spawn site in `start-automation`. Low refactor risk.

### 3.3 Browser session sharing

All three phases use the same `browser`, `context`, and `page` objects. Login happens once in the shared init. PestPac sessions persist across phases without re-auth (re-auth from v1.2.5 is timer-based and applies during the per-row phase as today; setup and teardown phases are short enough that intra-phase re-auth is not a v1.2.8 concern).

If setup phase ends on a different page than the per-row phase wants to start on (likely — setup might land on the new-batch screen), the per-row phase's first step is responsible for navigating to wherever it needs to be. Per-row flows already navigate at step 1 of every row; this is unchanged.

### 3.4 Phase transitions and the row loop

Pseudocode for the runner's main function:

```js
async function run() {
  await launchBrowser();
  await loginToPestPac();

  // Phase 1: setup
  if (setupSteps && setupSteps.length > 0) {
    emitPhaseEvent('setup-start');
    try {
      await runOnceFlow(setupSteps, runContext);
      emitPhaseEvent('setup-success');
    } catch (e) {
      emitPhaseEvent('setup-failed', { error: e.message });
      // Setup failure is fatal — no rows attempted, no teardown attempted
      await flushLog({ stoppedReason: 'setup-failed' });
      await closeBrowser();
      process.exit(1);
    }
  }

  // Phase 2: per-row main loop
  emitPhaseEvent('main-start');
  let mainExitReason = 'completed';  // 'completed' | 'breaker' | 'fatal' | 'user-stop'
  try {
    for (const row of rows) {
      if (_stopRequested) { mainExitReason = 'user-stop'; break; }
      if (consecutiveErrors >= breakerThreshold) { mainExitReason = 'breaker'; break; }
      await runMainRow(row);
    }
  } catch (e) {
    mainExitReason = 'fatal';
    emitPhaseEvent('main-fatal', { error: e.message });
  }
  emitPhaseEvent('main-end', { reason: mainExitReason });

  // Phase 3: teardown (runs on completed, breaker, user-stop; NOT on fatal)
  if (teardownSteps && teardownSteps.length > 0 && mainExitReason !== 'fatal') {
    emitPhaseEvent('teardown-start');
    try {
      await runOnceFlow(teardownSteps, runContext);
      emitPhaseEvent('teardown-success');
    } catch (e) {
      emitPhaseEvent('teardown-failed', { error: e.message });
      // Teardown failure is recorded but doesn't change the run's overall status —
      // the per-row work is what it is. User notified prominently.
    }
  }

  await flushLog({
    stoppedReason: mainExitReason === 'completed' ? null : mainExitReason
  });
  await closeBrowser();
}
```

### 3.5 When does teardown run?

| Main phase exit | Teardown runs? | Rationale |
|---|---|---|
| Completed cleanly (all rows done) | Yes | Normal happy path |
| Circuit breaker tripped (v1.2.5 §2.3b) | Yes | Per-row work that succeeded should be released. User can see "released a partially-filled batch" in the log. |
| User clicked Stop | Yes | Same reason — release what we've got |
| Fatal error before main loop started | N/A — main never started. Teardown does NOT run. | Nothing to clean up. |
| Fatal error during main loop (browser crash, fatal re-auth fail) | **No** | Browser/session is broken. Teardown can't run on a broken browser anyway. Recovery happens via resume-on-launch (v1.2.3 + v1.2.5 §2.7). |
| Setup failed | No | Setup failure is fatal-style; nothing to teardown. |

**Implication:** if teardown is meant to "release the batch," and main fatals out, the batch is left open. The resume flow needs to handle this: on resume, the user gets a choice of "resume main" + "still run teardown after." More on this in §3.6.

### 3.6 Checkpoint and resume

Checkpoint v2 (from v1.2.3) needs additions to track phase:

```json
{
  "schemaVersion": 3,
  "runId": "...",
  "phase": "main",
  "phaseProgress": {
    "setupCompleted": true,
    "mainRowIndex": 4213,
    "teardownCompleted": false
  },
  ...everything from v2...
}
```

Schema version bumps to 3. v2 checkpoints continue to be readable (legacy resume path treats them as `phase: 'main'`, `setupCompleted: true`, `teardownCompleted: false`).

**Resume modal behavior changes:**
- A v3 checkpoint with `setupCompleted: false` means setup never finished → resume re-runs setup (it's idempotent for the chargeback case; we'll document that idempotency is the user's responsibility for other cases — see §6).
- A v3 checkpoint with `setupCompleted: true` and `mainRowIndex` mid-loop is the standard resume case (same as today).
- A v3 checkpoint with `setupCompleted: true`, main loop done, `teardownCompleted: false` is a new case: "main finished, teardown didn't run / failed." Resume modal offers "Run teardown now" as a single-action recovery.

### 3.7 Stop semantics across phases

User clicks Stop:
- **During setup:** abort the current step, wait for it to finish safely if mid-DOM-operation, exit. No main, no teardown. Log says "Stopped during setup at step X."
- **During main:** finish current row safely (existing v1.2.5 behavior), then run teardown if configured, then exit.
- **During teardown:** abort the current step safely, exit. Log says "Stopped during teardown at step X." Recovery is manual.

The "finish current row, then teardown, then exit" path on Stop during main is important: it preserves the user's instinct that "Stop means clean shutdown including any cleanup that was supposed to happen." Without this, a Stop in main would leave the batch open and the user would have to do something else to release it — defeats the purpose of teardown.

### 3.8 Verification modes (Step / Step-Row from v1.2.4)

Verification modes pause before each action so the user can confirm. With three phases, the question is whether setup and teardown also pause.

**Decision: yes, all phases participate in verification mode.** A user verifying a chargeback flow wants to see setup pause-and-confirm just like main. Implementation: the existing pause-panel logic works at the step level; it doesn't care which phase the step belongs to. The pause panel labels each pause with "[Setup]" / "[Main, row 47]" / "[Teardown]" so the user has context.

**Open question for impl:** "Run all from here" is currently per-run. Does it skip ahead to "no more pauses for the rest of the run including teardown" or does it reset between phases? Recommendation: skips for the rest of the run. Resetting between phases is more clicks for no benefit.

---

## 4. UI CHANGES

### 4.1 Build Steps page additions

A new collapsible card at the top of the Build steps page, above the existing step list:

```
┌─ Flow type ─────────────────────────────────────────────┐
│  ⦿ Per-row flow    ○ Once flow                          │
│                                                          │
│  [Per-row flow only:]                                    │
│  Setup flow:    [None ▼]                                 │
│  Teardown flow: [release-batch-cleanup ▼]                │
└──────────────────────────────────────────────────────────┘
```

Behavior:
- **Flow type radio:** toggles `runMode`. Switching from per-row to once disables and clears the setup/teardown dropdowns. Switching once → per-row re-enables them.
- **Setup/teardown dropdowns:** populated from `flows/` directory, filtered to only flows where `runMode == 'once'`. The active flow itself is excluded from the list (no self-reference). If a referenced flow is missing, the dropdown shows "[missing: filename]" in red and the runMode validation surfaces an error.
- **None option:** explicit "None" entry at the top of each dropdown. Clears the field (`setupFlowId: null`).

### 4.2 Token chip behavior in once-flows

When `runMode == 'once'` is selected:
- The column-token chips (drag sources from v1.2.5) are hidden or disabled
- A new section "Run-context tokens" shows draggable chips for `{{TODAY}}`, `{{RUNID}}`, `{{PROFILE_USERNAME}}`
- The Import Data page is hidden entirely for once-flows (no spreadsheet to import)

This keeps the once-flow editor visually constrained to what's actually allowed, instead of presenting per-row affordances that would error at validation.

### 4.3 Run Settings card visibility

Several Run Settings fields are per-row concepts:
- `rowDelayMin` / `rowDelayMax`
- `errHandle` (retry/skip)
- `breakerThreshold` (consecutive errors)
- `retryRowIndexes`-related UI (retry-failed)

For once-flows, these are hidden. What remains visible:
- Headless toggle
- Selector timeout
- Page load mode
- Retry count (still relevant for individual step retries)
- Re-auth interval (irrelevant in practice for short once-flows but cheap to leave visible)

### 4.4 Run progress / log display for multi-phase runs

Today's "Run progress" panel shows row-by-row stats (Done, Errors, Rows/Min, Elapsed, etc.). With three phases, it grows to:

```
Phase: Setup → ●Main → Teardown   |   Elapsed: 00:14:33
[Setup] ✓ Completed in 00:00:08
[Main]  Row 4,213 of 6,278 (67%)  ✓ 4,180  ✗ 12  ⊘ 21  | 47/min  | Est. left: 00:33:14
[Teardown] (pending)
```

When a phase completes, its row in the panel collapses to a one-line summary. The active phase shows its detail. Pending phases show "(pending)".

### 4.5 Validation prompt copy

Pre-run validation (v1.2.5 §2.6) gains messages for the new error rules from §2.5. Copy is enumerated in §2.5 already.

### 4.6 Resume modal copy additions

The resume modal (v1.2.3, expanded in v1.2.5 §2.7) gains new variants:
- "Last run's setup failed at step X. Resume re-runs setup from the start."
- "Last run completed all rows, but teardown didn't run. Run teardown now?" (single-action recovery — Yes runs teardown only, No discards the checkpoint)
- "Last run's teardown failed at step X. Resume re-runs teardown from the start."

Idempotency disclaimer: "Resume will re-execute the [setup/teardown] from its first step. Make sure your [setup/teardown] flow is safe to run more than once."

---

## 5. IPC AND PRELOAD CHANGES

### 5.1 start-automation payload

Today's `start-automation` IPC accepts `stepsJson` (single steps array). Changes to:

```js
ipcMain.handle('start-automation', async (_, {
  flowJson,            // NEW: the entire main flow (replaces stepsJson; we need name, runMode, setupFlowId, teardownFlowId from it)
  spreadsheetPath, profileId, headless, runId, resumeFromRow,
  errHandle, rowDelayMin, rowDelayMax, selectorTimeout, pageLoadMode,
  retryCount, breakerThreshold, reauthInterval, retryRowIndexes, startMode,
  resumePhase,         // NEW: 'setup' | 'main' | 'teardown' | undefined
  resumeAction,        // NEW: 'continue' | 'run-teardown-only' | undefined
})
```

The handler resolves setup/teardown flows by reading the referenced flow JSONs from disk, then passes their `steps` arrays into `buildRunner` as `setupSteps` and `teardownSteps`.

**Resolving missing flows:** if `setupFlowId` or `teardownFlowId` references a non-existent flow, the handler rejects the call with a clear error. The renderer surfaces this as the validation error from §2.5.

### 5.2 New IPC handlers

| Handler | Purpose |
|---|---|
| `list-once-flows` | Returns the list of saved flows with `runMode == 'once'`. Used to populate setup/teardown dropdowns. |
| `validate-flow-references` | Given a flow JSON, checks that referenced setup/teardown flows exist on disk. Returns array of issues. |

### 5.3 New preload bridges

```js
listOnceFlows:           () => ipcRenderer.invoke('list-once-flows'),
validateFlowReferences:  (d) => ipcRenderer.invoke('validate-flow-references', d),
```

### 5.4 New automation-event types

The runner emits new event types via stdout JSON:

| Event type | Payload | Renderer behavior |
|---|---|---|
| `phase-start` | `{ phase: 'setup' \| 'main' \| 'teardown' }` | Update phase indicator in run progress panel |
| `phase-end` | `{ phase, status: 'success' \| 'failed' \| 'skipped', error? }` | Collapse phase row to summary |
| `phase-step` | `{ phase, stepIndex, stepType }` | Update detail line during once-flow execution (akin to per-row heartbeat) |

Existing per-row events (`row-start`, `row-end`, etc.) continue unchanged inside the main phase.

---

## 6. IDEMPOTENCY AND USER RESPONSIBILITY

Setup and teardown flows can be re-run on resume. Two cases where idempotency matters:

1. **Resume after setup-fail:** the new run will re-run setup from step 1. If setup creates a record (e.g., creates a batch), the second run creates a second batch. The flow author needs to either (a) make setup idempotent (check if a batch already exists; create only if not), or (b) accept the artifact and clean up manually.

2. **"Run teardown only" recovery:** if a previous run completed main but never ran teardown, the user can click "Run teardown now" in the resume modal. This invokes only the teardown phase. If the teardown flow assumes "the batch I created in setup is the one to release," and the user has done other PestPac work between runs that opened other batches, teardown might release the wrong batch.

**v1.2.8 does not solve idempotency.** The doc explicitly says: idempotency is the flow author's responsibility. The validation system does NOT analyze flows for idempotency. The UI does NOT warn about non-idempotent operations. Operators are expected to test their own flows.

For the chargeback case specifically:
- Setup is "click Create New Batch and submit the form" — non-idempotent (creates a new batch every time)
- Teardown is "navigate to batch list, find row where Opened By = BUU, click Release" — idempotent if there's only one BUU batch at a time, which holds with concurrency cap = 1

**Documentation:** the design doc, the README, and inline help text in the UI all carry the idempotency note. We do not engineer around it.

---

## 7. LOGGING

The Excel run log gains a "Phases" sheet alongside the existing All-rows / Errors / Skipped / Summary sheets. Columns:

| Phase | Status | Started At | Finished At | Duration | Steps Run | Notes |
|---|---|---|---|---|---|---|
| Setup | success / failed / skipped | ISO timestamp | ISO timestamp | sec | N | error msg if failed |
| Main | completed / breaker / user-stop / fatal | ... | ... | ... | rows | "4,213 of 6,278 rows processed" |
| Teardown | success / failed / skipped / not-attempted | ... | ... | ... | N | reason if not-attempted |

The Summary sheet's "Stopped reason" cell (v1.2.5 §2.10) is extended to phase-aware messages: "Setup failed at step 3", "Teardown failed: Release link not found", etc.

The All-rows sheet stays focused on per-row events from the main phase. Setup and teardown step events go to the new Phases sheet's detail (one row per step, optional — TBD whether per-step granularity is useful or just per-phase summary; lean toward per-phase summary plus the existing Errors sheet capturing any setup/teardown errors that occurred).

---

## 8. SCOPE BOUNDARIES

### 8.1 What v1.2.8 IS

- Three-phase pipeline: setup (once) → main (per-row) → teardown (once)
- Flow-level composition: main flows reference setup and teardown flows by ID
- runMode property on flows (per-row / once)
- Once-flow validation rules (no per-row tokens, no nested composition)
- Run-context tokens: `{{TODAY}}`, `{{RUNID}}`, `{{PROFILE_USERNAME}}`
- buildRunner refactor to config object
- Resume model expanded to handle phase-aware checkpoints and "teardown-only" recovery
- UI: flow type radio, setup/teardown dropdowns, phase indicator in run progress panel
- Logging: Phases sheet, phase-aware Summary

### 8.2 What v1.2.8 IS NOT

- **Not header-row tokens.** Once-flows can use static values and run-context tokens only. Header-row tokens land when the v1.3.0 spreadsheet metadata format does.
- **Not idempotency analysis.** Flows are run as-written; the system doesn't verify they're safe to re-run.
- **Not multi-runner.** Concurrency cap stays at 1.
- **Not arbitrary phase composition.** Three phases, that's it. No "between rows" or "every Nth row" or conditional teardown.
- **Not API-based execution.** All phases run via Playwright/browser like today.
- **Not per-run setup/teardown override.** Linkage is on the flow; if you want different teardown for different runs, save different flows. Per-run override may come in v1.2.8 or v2.0.

### 8.3 What stays unchanged

- Existing per-row flows continue to work without modification (silently upgraded with `runMode: 'per-row'`, no setup/teardown).
- Per-row token semantics (the `{{ColumnName}}` form) are unchanged.
- All v1.2.5 features (retry, breaker, network-aware retry, re-auth, error log enrichment, retry-failed) work in the main phase as today.
- Verification modes (Step / Step-Row) work across all phases.

---

## 9. IMPLEMENTATION ORDER

Items grouped by safety / dependency. Each phase ends at a "could-ship-here" boundary if priorities shift.

**Phase 1 — Data model and validation (~2 hr):**
1. Bump flow JSON version to 1.1
2. Add `name`, `runMode`, `setupFlowId`, `teardownFlowId` fields with default-on-load semantics
3. Add validation rules from §2.5 to existing validator
4. New IPC: `list-once-flows`, `validate-flow-references`

**Phase 2 — buildRunner refactor (~2 hr):**
5. Refactor `buildRunner` from 16-arg signature to single config object
6. Update the one call site in `start-automation`
7. Validate via `_validate-runner.js` (existing test rendering pattern)

**Phase 3 — Three-phase runner (~4 hr):**
8. Restructure runner template main function to setup → main → teardown pipeline
9. Add `runOnceFlow(steps, runContext)` helper inside the runner template (a stripped-down loop that runs a step list once with no row binding)
10. Add run-context token resolver alongside the existing per-row token resolver
11. Wire phase events (`phase-start`, `phase-end`, `phase-step`) through stdout JSON

**Phase 4 — Checkpoint and resume (~3 hr):**
12. Bump checkpoint to v3 with phase-tracking fields
13. Update checkpoint reader/writer to handle v3 (and read v2 with phase defaults)
14. Update resume modal logic for new phase scenarios (setup-fail resume, teardown-only recovery)
15. Modal copy additions

**Phase 5 — UI (~3 hr):**
16. Add flow type radio + setup/teardown dropdowns to Build steps page
17. Hide/show per-row UI elements based on `runMode`
18. Add run-context token chips section for once-flows
19. Update run progress panel with phase indicator + per-phase summary lines
20. Wire up phase-event handlers in renderer

**Phase 6 — Logging (~2 hr):**
21. Add Phases sheet to Excel output
22. Update Summary "Stopped reason" cell for phase-aware messages
23. Wire phase events into logEntries for the All-rows view (synthetic events, per v1.2.5 §2.10 pattern)

**Phase 7 — Stop and edge case handling (~2 hr):**
24. Stop semantics across phases (§3.7)
25. Teardown-runs-on-Stop logic (§3.5)
26. "Run teardown only" recovery action

**Phase 8 — Build chargeback flows (~1 hr):**
27. Build `release-batch-cleanup` once-flow (manual UI work — paste outerHTML, build steps)
28. Update existing chargeback flow: set `runMode: per-row`, `teardownFlowId: 'release-batch-cleanup'`, fix the broken Post1 step
29. Test on 2-3 real chargeback orders

**Phase 9 — Ship (~1 hr):**
30. Bump version to 1.2.7
31. Build, smoke test, commit, tag, push, publish release

**Total realistic estimate: 18-22 hours.** Higher end of the 15-20 range from earlier; the chargeback flow build (Phase 8) is genuinely an hour and I hadn't accounted for it before.

---

## 10. INTERACTIONS WORTH NAMING

- **§3.5 + v1.2.5 §2.3b:** breaker trip in main phase still runs teardown. Operationally desirable.
- **§3.5 + v1.2.5 §2.7:** main-fatal exit preserves checkpoint (existing v1.2.5 behavior); resume offers teardown-only recovery if main was completed.
- **§3.6 + v1.2.5 §2.7:** checkpoint v3 schema is a strict superset of v2; v2-on-launch still works.
- **§3.8 + v1.2.4:** verification modes pause during all phases including setup/teardown.
- **§3.7 + v1.2.5 §2.4:** Stop button shared shutdown path now includes "run teardown" between current-row finish and process exit.
- **§4.3 + v1.2.5 §2.8:** speed/resilience settings remain visible for per-row flows; once-flows see a slimmed Run settings card.
- **§5.4 + v1.2.5 §2.10:** new phase events become synthetic All-rows entries in the Excel log per the v1.2.5 logging pattern.

---

## 11. POST-SHIP VALIDATION

Cannot be done pre-ship. Validation plan:

1. **Chargeback end-to-end:** Run the real chargeback flow on 5 test rows. Verify: setup creates batch, main attaches 5 orders, teardown releases batch, log shows all three phases.
2. **Setup failure:** Intentionally break a step in the setup flow. Run. Verify: setup-fail logged, no main, no teardown, checkpoint preserved with `setupCompleted: false`. Relaunch BUU, verify resume modal offers "re-run setup from start."
3. **Main-mid Stop:** Start a 50-row run, click Stop at row 20. Verify: row 20 finishes, teardown runs, log shows "Stopped by user" + teardown success.
4. **Breaker trip:** Set breaker to 3, intentionally break main steps. Run. Verify: main breaks at row 3, teardown still runs.
5. **Teardown failure:** Intentionally break the teardown selector. Run a 5-row job. Verify: main completes, teardown fails with clear error, log captures it, resume modal on relaunch offers "Run teardown now."
6. **Once-flow validation:** Try to save a once-flow with a `{{ColumnName}}` token. Verify error blocks save with copy from §2.5.
7. **Migration:** Open an existing pre-1.2.7 flow. Verify it loads with `runMode: 'per-row'` defaulted in. Save it. Verify the saved JSON now has `version: '1.1'` and the new fields.
8. **Verification mode across phases:** Run in Step mode. Verify pause-panel labels phase context correctly for setup/main/teardown steps.

---

## 12. OPEN QUESTIONS DURING IMPLEMENTATION

1. **Phase event granularity:** Should the runner emit per-step events for setup/teardown phases (akin to per-row heartbeats), or just phase-start/end? Recommendation: phase-start/end + step events at error time only. Reduces UI noise for short setups.
2. **runOnceFlow error handling:** Should once-flows participate in the retry-count setting (v1.2.5 §2.8) or always be one-shot? Lean: participate in retry-count, since the underlying step types are the same and transient PestPac slowness affects both.
3. **Flow rename:** if a user renames `release-batch-cleanup.json` to something else, every flow that referenced it breaks. Recommendation: at flow-rename time, scan other flows for the old name and warn. Possibly auto-update references. Defer the auto-update to a follow-up; warn-only is enough for v1.2.8.
4. **The "name" field bootstrap:** v1.0 flows don't have a `name` field. Default it from the filename stem on first load. If the user saves the flow later with a different name (e.g., they typed in the name field), we have a divergence between filename and name. Convention: the dropdown in §4.1 should display `name` if present, else the filename stem. Decision deferred to impl.
5. **Teardown timing on user-Stop:** if the user clicks Stop and immediately closes BUU before teardown finishes, what happens? Hard-kill kills teardown mid-step. Lean: same recovery path as fatal — checkpoint preserved with `teardownCompleted: false`, resume modal offers "run teardown now."
6. **`runOnceFlow` access to v1.2.5 features:** does the wait-and-ping loop, re-auth detection, etc. apply during setup/teardown? Lean: yes, full v1.2.5 resilience applies to all phases (it's the same step-execution code path). Confirm during impl.

---

## 13. DOCS TO UPDATE WHEN THIS LANDS

- `DESIGN-INDEX.md`: BUU/BUUA fork plan is shelved. Reflect that BUU continues to grow features. v1.2.8 row added.
- `BUU-PROJECT-HANDOFF.md`: architecture section gains "three-phase pipeline" subsection. Note that flow JSON v1.1 has new fields.
- `README.md`: setup/teardown concept gets a short user-facing explanation.
- `BUUA-DESIGN.md`: note that flow composition is now in BUU, not deferred to BUUA.

---

## 14. END

This design is locked when Matthew has read it and approved each section. Push back is expected and welcome — see §1.4 for what's deliberately narrow and §8.2 for what's deliberately out of scope.

If a new requirement surfaces during implementation that isn't covered above, capture it as a new section before implementing. Don't expand scope silently.

**Last updated:** 2026-05-07 (initial draft, awaiting review).
