# BUU v2.2.2 — Design Doc

**Status:** Not started. Scope locked 2026-05-28 after a void run on the MISLABELED-336 sheet
reported all 336 rows successful while the post-run scrape showed zero of them persisted. The
full v2.3.0 agenda is deferred; v2.2.2 is a focused interim release with ONLY the two things
that cannot wait: trustworthy reporting and major cleanup.

**Predecessor:** v2.2.1 (lossless reclaim + license-leak fixes). Currently shipped.
**Successor:** v2.3.0 (the big refactor + 25-item agenda — see `BUU-v2.3.0-DESIGN.md`).

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

## SCOPE — TWO BUCKETS ONLY

### Bucket A: Trustworthy reporting (the headline)

**A1. Diagnostic capture on every row failure AND every "ok" row.** Capture per row:
- Full-page screenshot (PNG)
- Gzipped DOM snapshot
- Current URL
- Last 5 step events with timestamps
- Browser console buffer (`page.on('console')` from worker init)
- HTTP response status of the form submission (the POST to detail.asp on save)
Written to `failures/row-<N>-<status>/` under the pool log dir. Opt-in toggle at pool launch,
but defaults to ON for v2.2.2 since the trustworthiness crisis is the whole point.
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
that's ~2 extra hours. On a 10k run that's prohibitive. So v2.2.2 ships verify with a toggle
— ON by default for trustworthiness; user can turn off for a "fast" run knowingly. v2.3 may
refine to verify-on-failure-only once the false-ok pattern is understood/fixed.

**A3. Dialog text always logged.** Whether the row succeeds, fails, or had a dialog
accepted/declined — capture the dialog text (`Playwright` `dialog` event includes the
message) and write it to the per-row log + worker xlsx. The data is free; we throw it away
today. Cheap, high-leverage diagnostic.

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

### Bucket B: Major cleanup

**B1. Repo housekeeping execution** (from the v2.3 design "REPO HOUSEKEEPING / FILE CLEANUP"
section). Wipe `dist/` (5.7 GB, untracked, rebuildable). Delete stale build logs
(`build-buu2-*.log`, `_launch-*.log`). Delete `.bak` editor backups. Untrack
`error-log.txt` and `_skip-analysis.json` and add to `.gitignore`. Add gitignore entries to
prevent re-bloat: `dist/`, `_asar-installed/`, `build-*.log`, `_launch-*.log`, `*.bak`,
`~$*`, `error-log.txt`, `_skip-analysis.json`.

**B2. Working-data convention** (already documented in v2.3 cleanup section):
- `upcoming/` — inputs only (sheets queued to be run)
- `upcoming/results/` — outputs only (what a flow wrote, timestamped)
- `upcoming/Finished/` — archive (runs fully done and reconciled)
Stop hand-moving files mid-process. Copy, don't move, when reusing an output as a new input.

**B3. scripts/ folder archive.** Move one-off diagnostic scripts (`_forensics.js`, `_diag-*.js`,
`_build-*.js`, `_dump-*.js`) into `scripts/_archive/`. Keep the reusable validators at top
level (`_test-coordinator.js`, `_check-html-js.js`, `_validate-*.js`).

**B4. Log retention.** Startup auto-delete of worker `.log` and per-worker `BUU2-log-*.xlsx`
older than N days. Keep merged journals and `.done` markers. N configurable in settings.
Becomes table-stakes now that A1 (diagnostic capture) adds failure-folder artifacts.

---

## EXPLICITLY DEFERRED TO v2.3.0 (do not pull into v2.2.2)

- Runtime unification (the big refactor). Items A1-A5 will get duplicated across single-runner
  / pool-worker template / sweeper as a known cost of shipping v2.2.2 quickly. v2.3 unifies.
- Auto-accept/auto-decline dialog checkboxes (v2.3 item 2). For v2.2.2, the existing Handle
  Dialog step stays.
- Wait/state primitives (URL-change wait, navigation-complete wait, state-aware selectors,
  generic Wait step, per-step action timeout).
- Flow ergonomics (Run Pool as the only Run, step move-up/down, hot-reload, preview).
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
4. Repo root has only navigational docs + tracked code/data. `dist/` cleared.
5. All existing coordinator tests still pass (49/49).
6. Existing flows continue to work (regression: at least one void run and one read-status run
   produce identical journal outcomes to v2.2.1 aside from the verify-pass-added field
   reclassifications).

---

## NOTES FOR FUTURE CLAUDE SESSION

- Matthew explicitly said: ship the major cleanup AND reporting now. Skip everything else.
- The verify pass (A2) is THE feature. Without it, every reported "ok" remains untrustworthy.
- Diagnostic capture (A1) is what gives the human (Matthew) a way to see why a row really
  failed when verify says it did.
- v2.3 still exists as the bigger refactor — read `BUU-v2.3.0-DESIGN.md` for the full
  agenda. Treat v2.2.2 as the interim release that makes v2.3 work meaningful.
- Skill `docs/skills/SKILL-pestpac-reconciliation.md` governs any data-sheet building during
  this work.

