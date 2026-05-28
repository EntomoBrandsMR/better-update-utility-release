# BUU v2.2.2 — Design Doc

**Status:** Tier 1 SHIPPED 2026-05-28 (commits 4ec3bac, 09b553a, 3f20747, 84b624e on
`v2.0.0-elastic`). Tier 2 IN PROGRESS — multi-session work, see PROGRESS section below.
Version is NOT bumped until Tier 2 lands and validates. `CURRENT_VERSION` stays at `2.2.1`
until then.

**Scope shift from original v2.2.2 plan:** The original v2.2.2 plan was trustworthy
reporting (A1-A5) + cleanup (B1-B4) — see `BUU-v2.2.3-DESIGN.md` for that work, which now
ships as v2.2.3. v2.2.2 instead absorbs the runtime-unification work that v2.3.0's design
calls "the largest single item — do first, by itself." Matthew's reasoning:

> "do run time unification and code review as 2.2.2 and well do the rest as 2.2.3 idc just
>  get going"

The v2.3 doc's own build order says runtime unification must come first because every
feature item built on top of three duplicated runtimes pays the duplication cost three
times. v2.2.2 pays that cost once.

**Predecessor:** v2.2.1 (lossless reclaim + license-leak/logout/free-count fixes).
**Successor:** v2.2.3 (trustworthy reporting + remaining cleanup — see its design doc).

---

## WHAT v2.2.2 SHIPS

**Tier 1 (DONE — pushed 2026-05-28):**
- Docs cleanup: 20 historical files deleted (7 design docs for shipped versions, 11 release
  notes, POST-PUSH-NOTES, GITHUB_GUIDE). Section 0 of `BUU-PROJECT-HANDOFF.md` and the full
  `DESIGN-INDEX.md` updated to reflect current state.
- Repo bloat cleanup: `dist/` (5.7 GB), `_asar-installed/`, 14 build logs, 2 .bak files, both
  launch logs deleted. `error-log.txt` and `_skip-analysis.json` untracked. `.gitignore`
  extended with `~$*`, `error-log.txt`, `_skip-analysis.json`, `_commitmsg-*.txt`.
- `skip-analysis/` forensic artifacts removed (separate commit per handoff note).
- `scripts/` reorganized on disk: 56 one-off forensics moved into `scripts/_archive/`,
  8 keepers at top level (validators + creds.ps1). Disk-only — `scripts/` is gitignored.
- **`loginToPestPac` dedup'd** from 5 inline copies to 1 source of truth. Single function
  `loginToPestPacInPage(page, creds)` in main.js (called directly by `check-license-cap`),
  plus `LOGIN_TO_PESTPAC_SRC` string constant interpolated into all four template builders
  via `${LOGIN_TO_PESTPAC_SRC}`. All 5 call sites now use the hardened sequence including
  the `LoginForm-loginBtn` third-fallback. **Drift is now structurally impossible.**

Tier 1 validation: 49/49 coordinator tests, all template validators clean, main.js +
preload.js + index.html script all parse.

**Tier 2 (IN PROGRESS — multi-session):**

The remaining duplication and the single-runner/pool split. Done across multiple sessions
because the gap between single-runner and pool-worker is large and the cost of doing it
wrong is silent regressions. Build order, with each session locking in committed +
validated progress before moving on:

**Session 2A — Helper dedup.** The shared helpers I intentionally de-scoped from Tier 1
because they were marginal-payoff for runtime drift but are necessary preconditions for
later sessions. `findLocator`, `matchesText`, `findInContainer`, `resolveStepLocator`, `dec`,
`emit`, `ms`, `_require` — extract to string constants interpolated into all four template
builders. The buildLogoutSweeper's deliberately-minimal `findLocator` stays separate (named
`findLocatorMinimal` or kept inline with a comment explaining why). Validation: all parse
checks + 49/49.

**Session 2B — Step-type parity.** The buildRunner step engine has `textedit` (multi-mode
in-place text manipulation) that the pool worker doesn't. The pool worker has `readfield`
(v2.2.0 scrape step) that the buildRunner doesn't. Port BOTH directions so the two engines
have identical step type catalogs. Without this, "fold step-by-step into pool" loses
`textedit` capability for flows that use it. Validation: a flow using `textedit` runs
identically in both runtimes; a flow using `readfield` runs identically in both.

**Session 2C — Pool worker gains step-by-step.** Port from buildRunner: `waitForCommand`,
`currentMode` state, stdin command reader supporting `next-step`/`next-row`/`run-all`/
`stop`, pause points before each step (when mode==='step') and after each row (when
mode==='step-row'), `pause-step` and `pause-row` event emission, `resolvePreview` for
rendering what's about to execute. The pool launch UI gets the start-mode dropdown the
single-runner has today; renderer treats pool pause events the same way it treats
single-runner pause events.

When `startMode` is 'step' or 'step-row', pool forces workers=1, batch=1 (Matthew's Q1
confirmation: "yes but when automation is started after testing i want it to respect the
worker pool settings"). When the user clicks Run-All mid-step, coordinator scales the pool
from 1 worker up to the configured target (`workerCount` / `batchSize` / `elastic` /
license buffer all from the same pool launch config). Validation: a flow run end-to-end
in step mode, then transitioning to run-all, produces equivalent results to v2.2.1's
single-runner step-then-run-all run.

**Session 2D — Network-aware retry + error classification port.** From buildRunner:
`probeNetwork` / `waitForNetwork` (v1.2.5 item 2.8 — TCP probe to PestPac, backoff loop
when disconnected), `classifyError` / `classifyPhase` (v1.2.5 item 2.10 — error category
column in the Excel log). These exist only in single-runner today; pool worker has no
network-aware retry and no error classification. Both port verbatim from the buildRunner
template into the pool worker template. Validation: induce a network disconnect mid-run
in pool mode; expect the heartbeat 'waiting-for-internet' phase + clean resume on
reconnect. Excel log shows error categories.

**Session 2E — Retry config port.** From buildRunner: `retryCount` per-row retry,
`breakerThreshold` consecutive-error circuit breaker, `retryRowIndexes` for "retry only
these specific rows" mode, `reauthInterval` timer-based re-auth. These exist in the pool
worker either partially or not at all. Need exact audit per item. Validation: a small
flow with intentional failures retries per the configured retryCount. The retry-failed-
rows UI workflow works against pool runs.

**Session 2F — Resume audit + gap closure.** Pool already has resume via the journal
(`pool-journal-*.jsonl` + meta sidecar). Single-runner has checkpoint v3
(`checkpoint-<runId>.json`). Audit whether the pool meta sidecar captures every field
checkpoint v3 captures — specifically `phaseProgress` (setup/teardown completion tracking)
and `flowMeta` (runMode + setup/teardown refs). Anything missing gets added to the pool
meta. Validation: a run interrupted mid-setup, mid-row-loop, mid-teardown each resume
correctly through the pool resume UI. Discard single-runner checkpoint v3 only AFTER
parity is confirmed.

**Session 2G — Kill the single-runner.** With all capabilities ported, retire `buildRunner`
(the 1,506-line template), `start-automation` IPC handler, `stop-automation` IPC handler,
the `automationProcesses` Map, the checkpoint v3 read/write/find-orphan IPC handlers.
Renderer: remove the start-automation call path; route the start-mode dropdown into
`pool-start`. The `run-control` IPC stays but is repurposed to route commands to the
single live pool worker when in step/step-row mode. Validation: full end-to-end smoke
on a real PestPac flow in all three start modes; 49/49 coordinator tests still green;
all template validators (now reduced from 4 templates to maybe 1-2) still pass.

**Session 2H — Validation pass and version bump.** Run the void flow against a small
test sheet. Run the read-status flow. Run a step-by-step debug session. All three modes
work. Bump `CURRENT_VERSION` in `src/main.js` to `'2.2.2'`, bump `package.json` to
`2.2.2`, commit, tag `v2.2.2`, push branch and tag, `npm run build`, `gh release create`,
update `version-buu2.json` on `main` BOM-free.

---

## ACCEPTANCE CRITERIA

1. **Single runtime path.** No "single-runner vs pool" code paths. One step engine, one
   login routine, one logout routine, one error/retry handler. Single-runner's
   `buildRunner` template removed entirely (or trivially shrunk to a configuration shim).
2. **Step-by-step works in the pool.** Run-mode dropdown on the pool launch UI offers
   step / step-row / run-all. Step + step-row force workers=1 batch=1; clicking Run-All
   mid-step scales to the configured pool size.
3. **Step type parity.** A flow using `textedit` runs in any mode. A flow using `readfield`
   runs in any mode. No "this step only works in single-runner" or "only in pool" failures.
4. **Network-aware retry works in the pool.** Disconnecting the network mid-run produces
   a `waiting-for-internet` heartbeat and the run resumes cleanly on reconnect.
5. **Error classification works in the pool.** The Excel log has the error-category
   column populated for failed rows, same set of categories as v2.2.1 single-runner.
6. **Retry config works in the pool.** `retryCount`, `breakerThreshold`, `retryRowIndexes`,
   `reauthInterval` all honored, with the same semantics as v2.2.1 single-runner.
7. **Resume works in the pool with full fidelity.** Setup-completed and teardown-completed
   state survives a kill mid-phase. The pool resume UI offers every interrupted run that
   the single-runner used to offer via checkpoint v3.
8. **49/49 coordinator tests still pass.** New tests welcome for ported capability.
9. **All existing flows still work.** No regression on a void run, a read-status run, or
   a step-by-step debug session.
10. **Login dedup holds.** `loginToPestPac` remains a single source of truth across every
    call site. (Already done in Tier 1; just must not be undone.)

---

## EXPLICITLY DEFERRED TO v2.2.3 OR v2.3.0

- **All of A1-A5 (trustworthy reporting)** — diagnostic capture, verify pass, dialog text
  logging, skip/error reclassification, counter display fix. See `BUU-v2.2.3-DESIGN.md`.
- **B2, B4** — working-data convention enforcement, log retention auto-delete. Also v2.2.3.
- Everything else in `BUU-v2.3.0-DESIGN.md` items 2-25.

---

## TIER 2 PROGRESS

Updated as each session lands. Read this section first when picking the work back up.

- [x] 2A — helper dedup (_require, findLocator + minimal variant, matchesText, findInContainer, resolveStepLocator). Shipped as commits TBD on 2026-05-28. dec/emit/ms intentionally NOT dedup'd (trivial one-liners, no drift risk, churn cost > payoff).
- [x] 2B — step-type parity. textedit ported buildRunner→buildPoolWorker, readfield ported buildPoolWorker→buildRunner. Both engines now share the same 14-step catalog. Fixed a pre-existing `replace`/`replaceStr` undefined-variable bug in the regex sub-mode of textedit (would have thrown on any user flow using editMode=regex).
- [x] 2C — pool worker gains step-by-step. Worker template gets START_MODE, currentMode state, the existing readline demuxes step commands (mode/next-step/next-row/run-all/stop), pause-step before each step, pause-row after each row, resolvePreview for the pause panel. Coordinator: COORD.startMode + startModeTarget; pool-start forces workers=1/batchSize=1 in step modes; new pool-run-control IPC forwards commands to workers and handles Run-All transition (scales to startModeTarget.workers, restores batchSize). Renderer: currentPoolPause flag routes Next-step/Next-row/Run-All buttons to poolRunControl when triggered by a pool pause; onPoolPause translates the new pool-pause event into the existing showPause() flow; pool-start now passes startMode from the existing start-mode dropdown.
- [x] 2D — network-aware retry + error classification port. Probe + wait + classifyError + classifyPhase factored into canonical SRC constants used by BOTH templates. Pool worker now does post-failure network probe + bounded wait before retrying, and surfaces errorCategory/phase in row-result + per-worker log.
- [x] 2E — retry config port. retryCount, breakerThreshold, retryRowIndexes, reauthIntervalMin accepted per-job via pool-submit-job; forwarded to buildPoolWorker; emitted as constants in the worker template; wired into the batch loop (circuit breaker bookkeeping + drain on trip, retry-row filter with synthetic row-result emit so coord bookkeeping stays consistent, proactive re-auth at row boundary). Coordinator handles circuit-breaker event.
- [x] 2F — resume audit + gap closure. Pool journal meta now persists setupScope, startMode, startModeTarget, per-job retry knobs (retryCount/breakerThreshold/retryRowIndexes/reauthIntervalMin), and a phaseProgress {setupCompleted, teardownCompleted} sidecar. coordMarkPhaseProgress() updates phaseProgress as coordinator-driven once-flows finish. coordResumeFromJournal restores all of it and skips already-completed coordinator-driven setup on resume.
- [x] 2G — kill the single-runner. Deleted from main.js: automationProcesses Map; buildRunner template (~1376 lines); IPC handlers start-automation / stop-automation / run-control / get-checkpoint / find-orphan-checkpoints / load-checkpoint / discard-checkpoint. ~1755 lines removed total. preload.js gains a SHIM LAYER that maps the old call surface to pool equivalents (startAutomation → poolSubmitJob+poolStart with workers=1, stopAutomation → poolStop, runControl → poolRunControl, checkpoint v3 APIs → no-ops returning safe defaults) and bridges pool-status / pool-complete events back to the old 'automation-event' shape the renderer's handleRunEvent expects. The renderer is intentionally NOT rewritten this session — its existing single-runner code paths now route through the shim to the pool runtime. Renderer rewrite deferred to a later cleanup. Trade-off: row-start/row-done synthesis from pool-status snapshots is approximate (status of completed rows inferred from aggregate counter deltas, not exact); decorative events (heartbeat, mode, phase-step) are skipped.
- [ ] 2H — validation pass and version bump

---

## NOTES FOR FUTURE CLAUDE SESSION

- Read the Tier 2 PROGRESS list first. Pick up at the first unchecked item.
- Diff-by-diff sign-off is the rule. No 200-line drops.
- Validators after every session: `node --check src/main.js`, `node --check src/preload.js`,
  `node scripts/_check-html-js.js`, `node scripts/_validate-pool-worker.js`,
  `node scripts/_test-coordinator.js` (49/49).
  (Note: `_validate-runner.js` was removed in Session 2G since buildRunner no longer exists.)
- The v2.3 design doc's "do unification by itself, don't mix with feature work" rule
  applies here. Don't pull any A1-A5 work into a Tier 2 session no matter how tempting.
- Step-by-step is a Matthew-uses-this feature, not optional. If a session ends with
  step-by-step broken, it's a session that didn't ship.
- Brutal honesty over softened status. If a session reveals a capability the pool can't
  match without rewriting more than expected, stop and report. Don't paper over it.
- v2.2.2 ships when all Tier 2 items are checked AND validation pass clean AND Matthew
  signs off. Not before.
