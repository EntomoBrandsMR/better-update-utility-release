# v1.2.5 — Network resilience and recovery

This release exists to close the **5/1 disaster pattern**: a long PestPac run loses connectivity at the 6-hour mark, the session expires, every subsequent row fails, the work is lost. v1.2.5 adds three layers of safety that should make that scenario produce zero failed rows instead of thousands.

## The headline (resilience)

- **Network-aware retry.** When a row fails and PestPac is unreachable, BUU now waits for connectivity to come back BEFORE retrying. Previously, a multi-minute outage would burn every row's retry budget on a dead network. Probe is a TCP connect to `app.pestpac.com:443` (no PestPac HTTP load, no rate-limit risk). Backoff: 5s → 10s → 30s → 60s steady. Status bar shows "Waiting for internet (attempt N, MM:SSs so far)" in amber. Stop button works during the wait.
- **Automatic re-auth.** Three triggers, all calling the same login sequence, all firing at row boundaries (never mid-row):
  - **Timer** — every 120 minutes by default (configurable in Settings → Speed & resilience). Set to 0 to disable.
  - **Post-outage** — after a network wait of more than 10 minutes. Session likely expired during the gap.
  - **Detection** — if BUU lands on PestPac's login page mid-run (URL match), re-auth and continue.
- **Circuit breaker.** After N consecutive errors (default 20, configurable, set to 0 to disable), BUU stops, preserves the checkpoint, and pops a clear alert. Replaces the 1991-row burn pattern.

## Recovery

- **Resume modal redesigned.** Three options (Resume / Skip-and-resume / Discard / Dismiss) with a contextual banner explaining why the run stopped — circuit-breaker / re-auth fail / fatal / user stop / etc. Stop now preserves the checkpoint by default (so you don't lose the option to resume); Discard or Dismiss available next launch.
- **Retry failed rows button.** Appears in the Run progress panel when a run completes with at least one failure. Clicking it re-runs ONLY the failed rows, in a fresh log file. Source-spreadsheet integrity check (path + row count) prevents row-index mis-mapping if the spreadsheet was edited between runs. In-session only for v1.2.5; cross-launch retry deferred.
- **Single Stop path.** Toolbar Stop and pause-panel Stop now route through the same clean-shutdown path (no more "already running" bounce on a fast Run-after-Stop). The Run button is disabled visibly during the stop window so it's clear something's happening.

## Speed & control

New **Settings → Speed & resilience** panel exposes:
- Selector timeout (default 30s)
- Page load mode (`domcontentloaded` vs `load`)
- Retry count (default 2)
- Circuit breaker threshold (default 20, 0 to disable)
- Re-auth interval (default 120 min, 0 to disable)

Other defaults updated:
- Row delays now 0–0 (was 1–3). Idle time was wasteful for jobs that don't need pacing.
- Default error handling is now **Retry**. The legacy "Stop on first error" option is gone — verification modes (step / step-row from v1.2.4) cover the "I want to see what's happening" case.

## UX

- **Validate page deleted.** Validation now lives inline on the Build page with debounced live re-validation as you edit. Pre-run validation gate is non-blocking ("Run anyway / Show me / Cancel").
- **Build-page chips are drag-only** with higher contrast. Drag a column token onto a step's text field to insert at cursor.
- **Import-page chips** are now a non-interactive reference list (plain styling, no chip styling).
- "Remember last upload directory" so the file picker doesn't reset to Desktop every time.
- Build-page Run button renamed to "▶ Run automation" for clarity.

## Diagnostics

The `.xlsx` log file you open after every run is much more useful now:

- **New columns** in All rows / Errors / Skipped sheets: Error category | Phase | Step # | Step type | Step label | Field/selector | Attempted value (truncated to 100 chars)
- **Auto-filter dropdowns** on header rows — sort/filter without manually enabling filtering
- **"Stopped reason" cell** in Summary, populated for non-clean exits (breaker / re-auth fail / user stop / fatal)
- **Synthetic timeline entries** for login, re-auth, and breaker events appear in All rows interleaved with row entries — see when auth events happened relative to row processing
- **Live UI cleanup**: rows that fail-and-skip after exhausting retries now show as "⊘ SKIPPED" in amber instead of being misclassified as "✗ FAILED" in red

## Compatibility

Existing flows, profiles, and credentials carry over unchanged. Pre-v1.2.5 logs read fine for retry-failed and resume — they just lack the rich columns. New logs are forward-only.

## Known limitations (documented in POST-PUSH-NOTES)

- **Freeze-pane on log sheets is NOT shipped.** SheetJS 0.18.5 community edition doesn't write `<pane>` elements even when `!views` is set. Auto-filter alone provides most of the navigation value; manual View → Freeze Panes works fine in Excel if you want it.
- **Mid-row session expiry is NOT caught** by the detection trigger — only at row boundaries. The first row after expiry will burn its retry budget; the next row's row-start will detect the login page and re-auth. Subsequent rows recover.
- **Re-auth failure is fatal** (no retry on the re-auth itself). Better to stop and preserve the checkpoint than to continue producing 4000 confused rows. v1.2.6 candidate: add a small re-auth retry for transient blips.
- **Retry-failed is in-session only.** Quitting BUU between completion and Retry click loses the failed-row list. Cross-launch retry depends on a future "scan historical logs" feature.

## Stats

23 commits since v1.2.4, ~1000 lines added across `src/index.html` and `src/main.js`. Implementation took 9 phases of diff-by-diff work; design doc + POST-PUSH-NOTES tracking impl deviations are in the working tree (untracked).
