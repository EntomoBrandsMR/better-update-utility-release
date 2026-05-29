# BUU v2.2.3 — Design Doc

**Status:** Not started. Scope deferred from v2.2.2 on 2026-05-28 when v2.2.2's scope shifted
to runtime unification + cleanup. The trustworthy-reporting work and remaining cleanup items
that originally targeted v2.2.2 now ship in v2.2.3 on top of the v2.2.2 unified runtime.

**Predecessor:** v2.2.2 (runtime unification + repo/docs cleanup + login dedup).
**Successor:** v2.3.0 (the bigger 25-item agenda — see `BUU-v2.3.0-DESIGN.md`). Several items
on that list are explicitly carried into v2.2.3 (verify pass, diagnostic capture, counter
fix, log retention) because v2.2.2 grew to absorb the runtime-unification work and v2.2.3
inherits the trustworthy-reporting work that originally motivated v2.2.2 itself.

---

## WHY THIS RELEASE EXISTS

On 2026-05-28, a Void Lead run against 336 leads that should be re-closed with Close Reason =
DUPLICATE behaved as follows:
- Journal recorded 313 ok / 23 skip. Counter showed 342/336 done (the 6 extras were reclaim
  pick-back-ups, expected).
- Every worker log shows clean step 1→9 progression per row, `row-result: status=ok`, zero
  exceptions, ~25s/row, clean logout, `exit code=0`.
- A fresh Read Lead Status scrape 3 minutes after the run finished showed **all 336 still
  `Open / blank`**. Zero persisted. Matthew also watched it live: "the flow opened them then
  stopped" — the reopen took (Void→Open) but the re-void didn't happen.
- A second attempt: ran the close flow again, again reported all complete, scrape again
  showed all 336 still Open. Same pattern, repeatable.

This is the worst class of bug we have: **BUU reports success when nothing happened.** It is
strictly worse than the earlier-discovered false-skip pattern (where BUU reported skip on
rows that had actually succeeded — annoying, but the work got done). False positives mean
Matthew walks away believing 336 leads were fixed when zero were. Without trustworthy
reporting, no other diagnostic effort is reliable — every run's log is now suspect.

The unification work in v2.2.2 is the necessary precondition: every reporting item below
(A1-A5) gets implemented ONCE in the unified runtime instead of three times across
single-runner / pool-worker / sweeper. That's the entire reason v2.2.2 got prioritized.

## SCOPE — TWO BUCKETS

### Bucket A: Trustworthy reporting (the headline)

**A1. Diagnostic capture on every row failure AND every "ok" row.** Capture per row:
- Full-page screenshot (PNG)
- Gzipped DOM snapshot
- Current URL
- Last 5 step events with timestamps
- Browser console buffer (`page.on('console')` from worker init)
- HTTP response status of the form submission (the POST to detail.asp on save)
Written to `failures/row-<N>-<status>/` under the pool log dir. Opt-in toggle at pool launch,
but defaults to ON for v2.2.3 since the trustworthiness crisis is the whole point.
Per-error-bucket sampling cap (default 10) prevents explosion on 1000s-of-rows runs.
End-of-run prompt: save / discard / delete in 7 days.

**A2. Verify-after-action pass.** After every row, regardless of "success," re-navigate to the
row and read back the fields the flow tried to write. Compare actual vs intended:
- All intended values match → row is genuinely `ok`.
- Any value missing/wrong → reclassify as `error` with the specific field that failed.
Derives its checks automatically from the flow's Select/Type/Check steps — no separate scrape
flow per automation. **MUST be a fresh-navigate read** (proves PestPac persistence), not a
same-page inline read (only proves the field accepted input pre-Save). This is item 25 from
v2.3 pulled forward; the void-flow failures CANNOT be diagnosed without this.

Note on cost: verify pass adds ~15-25s per row (one extra navigate + read). On a 336-row run
that's ~2 extra hours. On a 10k run that's prohibitive. So v2.2.3 ships verify with a toggle
— ON by default for trustworthiness; user can turn off for a "fast" run knowingly. v2.3 may
refine to verify-on-failure-only once the false-ok pattern is understood/fixed.

**A3. Dialog text always logged.** Whether the row succeeds, fails, or had a dialog
accepted/declined — capture the dialog text (`Playwright` `dialog` event includes the
message) and write it to the per-row log + worker xlsx. The data is free; we throw it away
today. Cheap, high-leverage diagnostic. After v2.2.2 unification this is a one-place change.

**A4. Skip vs error reclassification.** Today the journal status is `ok | skip | error |
ok (retry)`. PestPac-blocked saves (validation, required field, server reject) are currently
lumped into `skip`. Distinguish:
- `ok` — verified success (A2 confirmed).
- `error` — verified failure or unhandled exception.
- `skip` — user-chosen filtering only (not used by void flow at all).
Counters in the status panel split these three.

**A5. Counter display refinement (carry over from v2.3 item 24a).** Show distinct rows as the
headline: `336/336 done · 0 left`. Below it, the reclaim breakdown: `+6 re-processed (4
close-down, 2 crash)`. Tag each reclaim with reason at requeue time so the panel can tally.

### Bucket B: Remaining cleanup

**B2. Working-data convention** (already documented; not enforced in code yet):
- `upcoming/` — inputs only (sheets queued to be run)
- `upcoming/results/` — outputs only (what a flow wrote, timestamped)
- `upcoming/Finished/` — archive (runs fully done and reconciled)
Stop hand-moving files mid-process. Copy, don't move, when reusing an output as a new input.

**B4. Log retention.** Startup auto-delete of worker `.log` and per-worker `BUU2-log-*.xlsx`
older than N days. Keep merged journals and `.done` markers. N configurable in settings.
Becomes table-stakes now that A1 (diagnostic capture) adds failure-folder artifacts.

Note: B1 (repo bloat cleanup) and B3 (scripts/_archive/ reorganization) already shipped in
v2.2.2 Tier 1.

---

## EXPLICITLY DEFERRED TO v2.3.0 (do not pull into v2.2.3)

- Auto-accept/auto-decline dialog checkboxes (v2.3 item 2). For v2.2.3, the existing Handle
  Dialog step stays.
- Wait/state primitives (URL-change wait, navigation-complete wait, state-aware selectors,
  generic Wait step, per-step action timeout).
- Flow ergonomics (step move-up/down, hot-reload, preview verification mode).
- Logout-attempt warnings, smarter logout retry.
- Spreadsheet-free flow type, sequential flow queueing, scheduled runs.
- Adaptive worker scaling, per-row total-time timeout.
- Field Catalog (v2.4).
- PestPac API integration (v3.0 branch).

---

## ACCEPTANCE CRITERIA

1. Run the void flow against the MISLABELED-336 sheet (or its current equivalent). Within 5
   minutes of run completion, Matthew can answer "did each lead actually persist?" without
   opening PestPac. Numbers must match a follow-up live scrape exactly.
2. For any row marked `error`, the `failures/` folder contains screenshot + DOM + console
   buffer + dialog text + the specific field that didn't match intended value.
3. Counter shows distinct rows + labeled reclaim breakdown.
4. All existing coordinator tests still pass (49/49 minimum; new tests welcome).
5. Existing flows continue to work (regression: at least one void run and one read-status run
   produce identical journal outcomes to v2.2.2 aside from the verify-pass-added field
   reclassifications).
6. A1-A5 each implemented in ONE place in the unified runtime, not three. The "known cost"
   of v2.2.2 (3× duplicated reporting work) was paid by v2.2.2's unification; v2.2.3 must
   not reintroduce it.

---

## SCOPE CALIBRATION (added 2026-05-28 at v2.2.3 kickoff)

Acceptance criterion 6 reads "one place in the unified runtime, not three." Reality check
on the state v2.2.2 actually shipped: the single-runner was deleted, but the pool worker,
once-flow runner, and logout sweeper are still three separate template builders with their
own `runStep` switches. They share helper SRC constants (login, selectors, network probe,
classifiers) but the per-step engine itself is duplicated.

What this means for v2.2.3:
- A1 (diagnostic capture per row), A2 (verify-after-action), A4 (skip/error
  reclassification), A5 (counter display) — these are PER-ROW concerns that live in the
  pool worker's batch loop. ONE place. Criterion 6 is met for them as written.
- A3 (dialog text always logged) — touches the `dialog` step type. That step lives in
  the pool worker's runStep AND the once-flow runner's runStep. Two places. The once-flow
  runner is short (only setup/teardown), so the cost is minor — but I'm flagging this in
  case "true one-place" is the bar Matthew wants. If so, that's an extra structural step
  (extract runStep into a canonical SRC constant) that should come BEFORE A3 implementation.
- B2 / B4 / B5 — pure renderer + main-process changes, not runtime-template changes.

Default plan: ship A1, A2, A4, A5 in the pool worker. Ship A3 in both the pool worker AND
the once-flow runner (two-line dup). If Matthew wants A3 to be "one place" before shipping,
flag it on review and extract runStep then. The acceptance criterion is still met for the
work that motivated v2.2.3 (false-ok reporting on per-row work).

---

## TIER 3 PROGRESS

Updated as each session lands.

- [x] 3A — A3 (dialog text always logged) + A4 (skip/error reclassification). Pool worker installs a blanket page.on('dialog') listener at page setup that captures every dialog (alert/confirm/prompt/beforeunload), stashes it on row.__dialogs for the per-worker xlsx Log, and emits a 'dialog' event to the coordinator. _currentRowNum/_currentRow track the in-flight row so dialogs are correctly attributed. The existing Handle Dialog step's specific accept/dismiss handler is unchanged (Playwright calls multiple listeners). Coordinator writes dialog records to the journal as discriminated entries {t:'dlg',j,r,m,k,ts} — journal-read paths (orphan scan, resume, pool-read-journal) updated to filter dialog records out of completion counts. Renderer exposed onPoolDialog via preload. A4: retry-exhaustion and errHandle='skip' paths now return status='error' instead of 'skip'. 'skip' is reserved for user-chosen filtering (Next-row sentinel + retry-row-filter exclusions). Circuit-breaker logic updated: any status='skip' is a user skip (doesn't count toward the breaker), errors count, ok/ok-retry reset.
- [x] 3B — A5 (counter display refinement). Reclaims are now tagged with one of four reasons at requeue time: 'drain' (coordinator drain command — scale-down/pool-stop/sweep), 'user-stop' (user clicked Stop mid-step or at a step-row pause), 'breaker' (circuit breaker tripped), or 'crash' (process closed without sending a reclaim message — coordinator's catch-all path). Worker emit gained a `reason` field; coordinator's reclaim case + catch-all crash path tally into job.reclaimsByReason and job.reclaimsTotal. Tally uses an alreadyRequeued guard to avoid double-counting when both paths fire for the same rows. coordEmitStatus exposes distinctDone (j.completedRows.size — the trustworthy headline that doesn't double-count reclaim re-processes), reclaimsTotal, and reclaimsByReason. pool-submit-job initializes completedRows + reclaim tally on fresh jobs. Renderer's renderCoordStatus uses distinctDone for the headline counter and shows '+N re-processed (X scale-down, Y user-stop, Z breaker, W crash)' as a breakdown line below the stats grid. New rs-reclaim stat tile and rs-reclaim-breakdown div added to index.html. Reclaim tally is NOT persisted in the journal meta (it's in-memory only) — a resumed run starts the tally fresh; documented as acceptable for v2.2.3.
- [x] 3C — A1 (diagnostic capture on every row). Pool worker now captures per-row diagnostic dumps to `<logsDir>/failures-<poolId>/row-<N>-<status>-<errorCategory>/` containing: screenshot.png (visible viewport, 5s timeout), dom.html.gz (gzipped HTML snapshot, last so a slow page doesn't block faster captures), url.txt, steps.json (meta + step trail with per-step timestamps + ok/error flag captured into row.__stepTrail inside processRow), console.log (ring-buffered browser console messages, last 200), responses.log (non-OK HTTP responses + every non-GET request, last 50), dialogs.json (existing __dialogs array from 3A). Per-(status, errorCategory) bucket cap (default 10) prevents disk blowout on 10k-row runs; counters are per-worker so an N-worker pool gets up to N*cap per bucket (acceptable trade-off — exact pool-wide capping would need IPC roundtrips). Capture helper is best-effort: every step is wrapped in try/catch so a closed page or read-only disk never breaks the run. Pool-launch UI adds a 'Diagnostic capture' checkbox + bucket-cap number input between Setup/teardown and Run pool (ON by default). pool-start IPC accepts diagnosticCapture + captureBucketCap; stored on COORD and forwarded to buildPoolWorker via coordSpawnWorker (captureDir = `logs/failures-<poolId>`). Persisted in journal meta for resume. Preload shim's startAutomation path forces diagnosticCapture=true so the legacy Start button also gets captures. Bug fix carried in: pool-start now also resets Session 3B's reclaim tally on fresh runs (was inherited from prior run in same app session). End-of-run save/discard/delete-in-7-days prompt deferred to v2.3 (renderer follow-up; doesn't block the diagnostic value).
- [x] 3D — A2 (verify-after-action pass). THE headline feature. After every row, pool worker re-navigates to the row's primary URL (first 'navigate' step in DATA_STEPS, row-substituted) and reads back the fields the flow's write steps tried to set. Expected map auto-derived from DATA_STEPS: type → inputValue, select → selected option textContent, checkbox(check/uncheck) → isChecked. Comparison is trim+lowercase by default (PestPac forms render with whitespace/capitalization variance). Mismatches reclassify ok/ok(retry) rows to status='error' with errorCategory='verify-mismatch' and error='Verify failed: <field> expected=X got=Y'. For already-error/skip rows, the verify result is appended to the existing error. If verify reports OK on an already-error/skip row, status is preserved but res.verifyOk=true is flagged so the user can spot false-fail cases during reconciliation. verifyFailedFields + verifyOk columns added to the per-worker xlsx Log and row-result emit. Skips when no navigate step is present, navigate URL substitutes empty, no verifiable writes in the flow, or VERIFY_AFTER_ACTION=false. textedit verification deferred to v2.3 (sub-mode complexity — append/prepend/replace/regex need the pre-edit value to know the expected post-edit value). Multi-page forms produce false positives on later-page fields (legitimate diagnostic signal — BUU thinks it wrote them but fresh navigate can't find them). pool-start IPC accepts verifyAfterAction (default true); persisted in journal meta for resume. Pool-launch UI adds 'Verify after action' checkbox right after diagnostic capture. Preload shim's legacy startAutomation path also defaults verifyAfterAction=true. Cost: one re-navigation per row (~5-15s); toggle lets users turn it off knowingly for trusted high-volume runs.
- [x] 3E — B4 (log retention). cleanupOldLogs(maxAgeDays) helper added after the config block. Walks `<userData>/logs` at app startup (kicked off via setImmediate after createWindow so it never blocks the UI). Deletes files matching `buu2-worker-*.log` (per-worker debug streams) and `BUU2-log-*.xlsx` (per-worker xlsx logs) and directories matching `failures-pool*` (Session 3C diagnostic capture dirs, removed recursively) when their mtime is older than the configured cutoff. Default 30 days. 0 disables. Defensive — any file or directory NOT matching those three patterns is left alone, so unknown contents never get clobbered. Journals live in userData directly (not under logs/) and read-field results live under the source spreadsheet's `results/` folder (not under logs/), so neither is in scope for this cleanup — both are preserved for forensics and resume. Config key: `logRetentionDays`. No renderer UI added this session (deferred — config is editable via the existing get-config/set-config IPC). Reports counts to console on cleanup.
- [x] 3F — B2 (working-data convention enforcement). Narrowly-scoped: one IPC + one renderer button. The convention rule (upcoming/ inputs, upcoming/results/ outputs, upcoming/Finished/ archive) is largely behavioral — code can't stop the user from hand-moving files, but it CAN provide a one-click archive action so the user doesn't have to. archive-spreadsheet IPC moves a sheet from <parent-dir>/ to <parent-dir>/Finished/, creating the dir if needed, suffixing with an ISO timestamp if the destination already exists (never silently overwrite). Preload exposes archiveSpreadsheet. coordEmitStatus now includes spreadsheetPath in each job's payload so the renderer can call archive on demand. renderStagedJobs shows an Archive button next to Remove when the job has finished AND the pool isn't running AND spreadsheetPath exists. poolArchiveJob helper reads from a renderer-cached lastPoolStatus (populated in the onPoolStatus subscriber), confirms with the user, calls the IPC, then removes the staged job + refreshes status. No code added for warning on opening a non-upcoming/ file — high-noise low-signal; skipped. Read-field results workbook already writes to <spreadsheet-dir>/results/ (line 650 of coordWriteReadResults from v2.2.0), so it already conforms to the convention when sheets are placed under upcoming/.
- [ ] 3G — Validation + version bump to 2.2.3

---

## NOTES FOR FUTURE CLAUDE SESSION

- Matthew explicitly said: ship the major cleanup AND reporting. v2.2.2 took unification +
  cleanup. v2.2.3 takes reporting. Don't pull v2.3 items in beyond what's listed here.
- The verify pass (A2) is THE feature. Without it, every reported "ok" remains untrustworthy.
- Diagnostic capture (A1) is what gives the human (Matthew) a way to see why a row really
  failed when verify says it did.
- After v2.2.2's unification, A1-A5 are one-place changes, not three. If you find yourself
  patching three runtimes, stop — something went wrong with v2.2.2's work.
- v2.3 still exists as the bigger refactor — read `BUU-v2.3.0-DESIGN.md` for the full
  agenda. Treat v2.2.3 as the interim release that makes v2.3 work meaningful by giving
  every other diagnostic effort trustworthy data to start from.
- Skill `docs/skills/SKILL-pestpac-reconciliation.md` governs any data-sheet building during
  this work.
