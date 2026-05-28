# BUU DESIGN INDEX

**Purpose:** Single entry point for active design work. Read this first.
**Last updated:** 2026-05-27 (v2.3.0 agenda locked after Void-debugging session; 2.x history captured).

---

## STANDING CONTEXT (always true — do not re-ask)

- **Matthew is the only user of BUU right now.** He is the sole operator. There is no other
  install in the field. This means: shipping a release does not risk breaking other people's
  work, and Claude should NOT keep proposing "hold the release / don't publish yet so others
  aren't affected" — there are no others. When Matthew says ship, ship the whole way (bump,
  commit, tag, push, AND publish the GitHub release). He tests on his own machine after the
  fact and is comfortable with auto-update offering him the new version.
- **Workflow:** Matthew works diff-by-diff with sign-off on non-trivial changes, tests after
  push rather than during the session, and prefers brutal honesty over softened status reports.
- This block is intentionally redundant across design docs so any fresh session sees it.

## CURRENT STATE (updated 2026-05-27) — READ THIS

**Two apps now, fully separate:** BUU Legacy (branch `v1.3.5-legacy`, `version.json` channel,
productName "Better Update Utility") and **BUU 2.0** (branch `v2.0.0-elastic`,
`version-buu2.json` channel, productName "BUU 2.0", appId `com.entomobands.buu-2`). Separate
userData folders (`%APPDATA%\buu-2` for 2.0, `%APPDATA%\better-update-utility` for Legacy).
Pushing one branch never affects the other; two separate version files so updaters never
cross-wire. Legacy flows are copied into 2.0 once on first launch (then independent).
**Active feature work is on BUU 2.0.** Legacy is in pure maintenance.

**SHIPPED on BUU 2.0** (current channel `version-buu2.json` → `v2.2.1`):
- **v2.0.0** — Initial 2.0 release. Elastic worker pool with pull-queue coordinator, batch-
  pulling workers, license-aware elastic scaling, zero-loss append-only resume journal,
  multi-flow job staging, merged pool log, file-upload step. Forked from BUU Legacy v1.3.5.
- **v2.0.1** — Auto worker-count accounts for hardware AND licenses; "Elastic" checkbox
  renamed, toolbar inputs labeled, license-buffer and recheck-interval moved into the right
  groups. See `BUU-v2.0.1-DESIGN.md`.
- **v2.0.2** — Stability + UX patches (post-launch).
- **v2.1.0** — Mid-2.x feature work.
- **v2.1.1** — Patches.
- **v2.1.2** — Bulletproof logout + PestPac login-overlay (MuiBackdrop) fix + per-worker stop
  + setup/teardown scope. Critical reliability release.
- **v2.2.0** — Read field step (scrape a value from the page into a column).
- **v2.2.1 (CURRENT SHIPPED)** — **Lossless reclaim on elastic scale-down** (the big one — a
  draining worker hands its unstarted batch tail back to the coordinator; no more silent row
  drops). License-leak fixes (Auto check and elastic recheck now log out their PestPac
  session). Free-license count scoped to `#div_PestPac` with exact label match (no more
  reading the wrong row). Sweeper + once-flow login selector fix. Read-field colName focus
  preserved on keystroke. Worker card border. Coordinator test suite at 49/49 (added TEST 9
  for reclaim). See `BUU-v2.2.1-DESIGN.md` if it exists; otherwise see the git tag and the
  v2.2.1 release notes.

**NEXT UP: v2.3.0** — full agenda in `BUU-v2.3.0-DESIGN.md`. Agenda locked 2026-05-27 in a
long live-debugging session against PestPac's Void Lead flow, then extended after a 9,854-row
big run revealed concurrency/burn-time issues. **25 items**, anchored on **runtime unification** (item 1, must be done first by itself before anything else lands on
top). Summary of buckets:
- **Foundation:** unify the three-runtime structure (single-runner / pool-worker / sweeper)
  into one step engine + one login + one logout + one dialog handler. The pay-for-itself item.
- **Dialog handling:** auto-accept / auto-decline checkboxes on every action step; remove the
  standalone Handle Dialog step type; dialog text always logged; skip↔error reclassification
  (PestPac-blocked saves are errors, not skips).
- **Diagnostic capture:** screenshot + DOM snapshot + URL + step trail + console buffer per
  failed row, opt-in toggle on the pool launch screen, per-error-bucket sampling cap so a 3k-
  skip run doesn't produce 900MB of artifacts. Plus log-retention policy.
- **Wait/state primitives:** URL-change wait, navigation-complete wait, state-aware selectors
  (`:enabled` / `:disabled` actually wait for state), generic Wait step type, per-step action
  timeout setting.
- **Flow ergonomics:** Run Pool is the only Run (kill single-runner), step move-up/down
  buttons, hot-reload flow edits between runs, pool preview / verification mode.
- **Reliability:** logout-attempt warnings surfaced, smarter logout retry strategy.
- **New capabilities:** spreadsheet-free flow type, sequential flow queueing, scheduled flow
  runs (one-shot / daily / weekly / monthly + cron for power users).
- **Concurrency control + burn-time caps (added after the 9,854-row big run + the 119-worker
  near-crash):** adaptive worker scaling that respects all three caps (license / PestPac
  response / local machine) and three signals (duration p75, wall-clock-vs-Playwright-time
  ratio, skip rate); ramped startup in waves to avoid cold-start storm and resource shock;
  Auto recalculated as a ceiling, not a launch target; hardware formula includes RAM.
  Per-row total-time timeout (abandon rows past N seconds without logging the worker out).
  Dup-row-counter fix + reclaim double-record investigation.
- **Verification (added 2026-05-28 after finding the journal under-reports successes):** a
  verify pass that fresh-navigates to a failed row and reads back the fields the flow's
  write steps intended to set, comparing actual-vs-intended; reclassifies false skips to ok
  and names the specific field that failed on real failures. Default verify-on-failure; opt-in
  verify-every-row mode. Evidence: a live check found 2,834 of 4,100 "skipped" rows were
  actually already voided — the runner's success/failure call is wrong on a consistent fraction
  of rows. Must be a fresh-navigate read (proves persistence), not a same-page inline read
  (only proves the field accepted input pre-Save).

**Deferred from v2.3:**
- **v2.4** — Field Catalog (persistent observation store of every PestPac field BUU has seen;
  the foundation for required-field auto-discovery without manual prep), parallel multi-flow
  runs.
- **v3.0 branch** — PestPac API integration / hybrid mode. The Void debugging session made
  the case; the right place is its own branch, not a v2.x sub-release.

**BUU Legacy (v1.x) — what shipped, frozen:**
- v1.3.0 through v1.3.5 all built and published. v1.3.5 is the last Legacy release.
- v1.3.0 = 11-item polish/bugfix release.
- v1.3.1-v1.3.3 = UI sizing experiments (CSS bump didn't take, native Chromium zoom did, then
  raised to 1.35 and window sized to 85% of screen work area).
- v1.3.4 (if shipped) = the backlog captured in `BUU-v1.3.4-DESIGN.md` (multi-condition match,
  paste-HTML id vs class, hidden-sheet workbook load, drag chip drop, validation message
  surfacing, pause-panel persistence, hardcoded-URL navigate, right-click in Paste HTML,
  Stop-clears-backend-map, drag-reorder auto-scroll, drag drop-line cleanup). Some items may
  have been carried into 2.x instead.
- v1.3.5 = final Legacy release. No further Legacy feature work planned.

**BUUA — superseded.** The original "BUUA fork" plan from 2026-05-04 was absorbed into BUU 2.0
itself (the elastic-pool architecture is what BUUA was meant to be). The remaining BUUA
concerns (multi-runner concurrency, license-aware scaling, headless operation) all shipped in
v2.0.0. The remaining piece (API integration) is now a v3.0 branch item, not BUUA.
`BUUA-DESIGN.md` is historical context; not active.

---

## SESSION PICKUP NOTE (2026-05-04, HISTORICAL — see CURRENT STATE above for live status)

> Kept for institutional memory. The BUUA fork was absorbed into BUU 2.0 (now shipped through
> v2.2.1) and the WorkWave API blocker is now a v3.0-branch concern, not an active blocker
> for BUU 2.0 feature work. Don't act on this section — read CURRENT STATE for what to do.

When you / a fresh Claude session resumes, here's where we left off:

**Decision made:** BUUA v2.0 = **Hybrid backend** (API + browser fallback). Locked. See `BUUA-DESIGN.md` Section 0.

**Currently blocked on:** WorkWave API support. We cannot acquire an OAuth access token. Four authentication attempts were tested, all 401'd with empty response bodies:
  1. Auth scheme `Basic`: ClientId = company key, ClientSecret = developer portal password
  2. Auth scheme `Basic`: ClientId = `pestpac-api` (bundle name), ClientSecret = password
  3. Auth scheme `Basic`: ClientId = company key, ClientSecret = API key (`fJsh...`)
  4. Auth scheme `Bearer` (per literal C# example in docs): ClientId = company key, ClientSecret = password

All four return 401 with empty response body, indicating the OAuth gateway rejects the ClientId/ClientSecret pair before checking username/password. Conclusion: a separate ClientId + ClientSecret pair was provisioned at signup but never delivered to Matthew. **Email sent to WorkWave support requesting the real values.**

**When the rep replies with the real ClientId/ClientSecret:**
1. Update `scripts/creds.ps1` with the new values
2. Run `scripts/_api-auth-test.ps1` to confirm both stages pass
3. Run `scripts/_api-probe-sweep.ps1` to execute the 8 mutation probes against a voided invoice
4. Send the resulting log file to whoever is helping with the design
5. Merge the probe results into `BUUA-DESIGN.md` (currently stale on multi-runner / flow-embedding sections — they need rework after probe data lands)

**Test scripts already written and ready:**
- `scripts/_api-auth-test.ps1` — read-only, two-stage auth check (token + headers)
- `scripts/_api-auth-combos.ps1` — takes -Theory 1 or 2 parameter (already used both)
- `scripts/_api-auth-theory3.ps1` — tests Bearer scheme literal-doc interpretation (already run, 401)
- `scripts/_api-probe-sweep.ps1` — the 8-probe mutation test on a voided invoice

All three live in `scripts/` (gitignored). They source `creds.ps1` (also gitignored, never to be committed).

**Things to NOT do unprompted while waiting:**
- Don't try more credential guesses (we exhausted defensible theories)
- Don't rewrite BUUA-DESIGN.md sections 2.1, 2.5, 2.9, 2.10 yet — they're flagged stale but rewriting them needs the probe results
- Don't push BUU repo with `API DOCUMENTATION/portal-prose/` un-gitignored (already added to .gitignore but verify before any commit)

---

## SKILLS — procedures to follow exactly

> **`docs/skills/SKILL-pestpac-reconciliation.md`** — MANDATORY before building any rerun /
> leftover / fix / cross-reference sheet, or answering "which leads still need X / why did
> these end up wrong". Derive from ROOT sources (intent list + live scrape), never from an
> intermediate output sheet; verify every sheet in memory and after read-back before handing
> it over. Created 2026-05-28 after the 336-lead CLEANUP/DUPLICATE mislabel.

## What's where

> **File locations (reorganized 2026-05-28):** design docs now live in `docs/design/`, release notes in `docs/release-notes/`. The table lists bare filenames as identifiers; prepend the folder to open them. Navigational docs (`DESIGN-INDEX.md`, `BUU-PROJECT-HANDOFF.md`, `README.md`, `GITHUB_GUIDE.md`, `POST-PUSH-NOTES.md`) stay in the repo root.

| Document | Status | Read this when |
|---|---|---|
| **BUU-v2.2.2-DESIGN.md** | Drafted 2026-05-28. **Active.** | Interim release pulled forward after the void-flow-reports-success-when-nothing-persisted finding. Scope: trustworthy reporting (diagnostic capture, verify-after-action, dialog text logging, skip↔error reclassification) + major cleanup (repo, scripts, log retention). Everything else stays in v2.3. |
| **BUU-v2.3.0-DESIGN.md** | Drafted 2026-05-27. Partially deferred. | The big refactor + 25-item agenda. Trustworthiness items pulled forward into v2.2.2; everything else stays here. Read after v2.2.2 ships. |
| **BUU-v2.0.1-DESIGN.md** | Shipped (v2.0.1 series) | Reference for early BUU 2.0 polish (Auto worker-count + license awareness, toolbar relabeling). |
| **BUU-v1.2.8-DESIGN.md** | Shipped 2026-05-11 (BUU Legacy) | Reference for setup-and-teardown flow composition / three-phase pipeline. Carried into BUU 2.0. |
| **RELEASE-NOTES-v1.2.7.md** | Shipped 2026-05-07 (BUU Legacy) | Reference for the dialog-handler crash fix |
| **RELEASE-NOTES-v1.2.6.md** | Shipped (BUU Legacy) | Reference for iframe-aware selectors |
| **BUU-v1.2.5-DESIGN.md** | Shipped (BUU Legacy) | Reference for the resilience pack (retries, breaker, re-auth, etc.) |
| **BUU-v1.2.4-DESIGN.md** | Shipped 2026-05-01 (BUU Legacy) | Reference for the unify-runner refactor |
| **BUU-v1.3.4-DESIGN.md** | Final Legacy backlog doc | Reference only — Legacy is frozen at v1.3.5. Some items may have been carried into BUU 2.0. |
| **BUUA-DESIGN.md** | Superseded by BUU 2.0 (2026-05-27). Historical context only. | Don't act on this. Architecture concerns (multi-runner, elastic scaling) shipped in BUU 2.0 v2.0.0. API hybrid is now v3.0-branch territory. |
| **BUU-PROJECT-HANDOFF.md** | Section 0 stale (last refresh 2026-05-07, pre-v2.x). Body still has older version-specific status mentions. Refresh pending. | Need PestPac selectors, runner template details, build commands, file paths, operating practices |
| **API DOCUMENTATION/** | PestPac API spec + SDKs + portal prose docs | Anything API-related. swagger.yaml has 347 endpoints. portal-prose contains a plaintext API key — gitignore before commit. v3.0 work depends on this. |

> **Strategic note (2026-05-27):** The earlier "BUUA fork takes over feature work" plan is
> fully resolved — BUU 2.0 *is* the BUUA architecture. BUU 2.0 has been the active branch
> through v2.2.1. v2.3.0 is the next release and continues active feature work on BUU 2.0.
> BUU Legacy (v1.x) is in pure maintenance; no further Legacy feature work planned.

---

## Project status snapshot (2026-05-07, HISTORICAL — BUU Legacy v1.x line)

> Frozen Legacy-era snapshot. For current state, see the **CURRENT STATE** section near the
> top of this doc. The v1.x line below is BUU Legacy, which is frozen at v1.3.5. Active feature
> work is on BUU 2.0 (v2.0.0-elastic branch), now at v2.2.1, with v2.3.0 in design.

- **v1.2.3 SHIPPED 2026-05-01** — Icon, run guards, heartbeat, live counters, resume-on-launch, log retries.
- **v1.2.4 SHIPPED 2026-05-01** — Unified runner with start-mode picker (step / step-row / run-all).
- **v1.2.5 SHIPPED** — Resilience pack: configurable retry, circuit breaker, network-aware retry, re-auth, retry-failed-rows, log enrichment, default `errHandle` flipped from `stop` to `retry`.
- **v1.2.6 SHIPPED** — Iframe-aware selectors. Click-step debug checkbox shipped as permanent feature.
- **v1.2.7 SHIPPED 2026-05-07** — Dialog handler crash fix. Single-issue hotfix; `page.once('dialog')` listener no longer leaks across rows when no dialog actually fires.
- **v1.2.8 SHIPPED 2026-05-11** — Setup-and-teardown flow composition. Three-phase pipeline (login → setup once → main per-row → teardown once → logout). New flow JSON v1.1 format (`runMode`, `setupFlowId`, `teardownFlowId`). Checkpoint v3 with phase progress. Resume modal handles 5 new phase-aware scenarios including "Run teardown only" recovery. New Phases sheet in Excel log. ~1057 lines added across `src/main.js`, `src/index.html`, `src/preload.js`. Phase 8 (build chargeback flows) is in flight by Matthew in the new UI.
- **v1.2.9 SHIPPED 2026-05-11** — Hotfix for the "every once-flow shows as buu-flow in the dropdown" bug introduced in v1.2.8. v1.2.8's saveFlow logic stamped the JSON's `name` field as the literal string `'buu-flow'` whenever both the in-memory `flowName` (no UI to set it) and the `flowNotes` field were empty — which was every time the user created a fresh flow. All three server-side lookup paths (`list-once-flows`, `resolveOnceFlowByName`, `validate-flow-references`) now key on the filename stem instead of `data.name`. Save handler also rewrites `data.name` to match the filename on write, so existing files self-heal next save.
- **v1.3.0 is the next BUU release.** Theme: polish, bug fixes, and a few candidate big features. Fourteen items in the backlog: (1) row-by-text selector mode, (2) text-selection inside step blocks, (3) can't run a second flow after stop without app restart, (3a) verification step window closes between steps instead of staying open, (4) move open-logs onto the Run button, (5) handle-dialog shouldn't require Next click in step-mode, (6) make UI slightly larger, (7) verify logs are written during step-mode (likely no-op), (8) validate `{{token}}` brace pairs at save time, (9) step-through-everything mode for setup/teardown debugging, (10) updates unpin BUU from Windows taskbar, (11) pause button does not pause, (12) per-step on-fail flows (8-12 hour v1.2.8-magnitude feature; strong rec to defer to v1.4.0), (13) file-upload step type (4-5 hours if files local, 20-30 if cloud; release uncommitted, depends on Matthew's emergent 20k-doc situation). Estimated 10-16 hours for items 1-11; full backlog scope depends on items 12 and 13 placement. Not yet designed; no doc started. Full detail in the v1.3.0 section below.
- **BUU is no longer feature-frozen post-v1.2.5.** That earlier plan is paused. BUUA work waits on WorkWave API access.

---

## v1.3.0 — the next thing to build

**Theme:** Small UX fixes + one selector improvement. All independent, mostly self-contained changes. Was originally numbered v1.2.9; pushed back when the name-collision hotfix took the v1.2.9 slot on 2026-05-11.

### Backlog items

**1. Row-by-text selector mode (the original v1.2.9 item).**

Today's paste-HTML auto-extractor works great when you grab an element that's unique on the page — a named input, a button with a stable id, a link with a `data-testid`. But it fails on "find the right row in a list" patterns. Common example: PestPac's batch list page has rows for batches owned by many users. Each row has `<span id="Edit">`, `<span id="Release">`, etc. — but those IDs are not unique across the page (every row has them). The auto-extractor picks `span#Edit` which matches the first row, not necessarily the BUU row.

The current workaround is to hand-write XPath like `xpath=//tr[td[normalize-space(text())='BUU']]//span[@id='Edit']` — robust but requires XPath knowledge.

Add a UI mode that asks for two fields:
- **Row-identifying text** (e.g. "BUU" — value in some cell that uniquely identifies the right row)
- **Action element** (paste the outerHTML of the action you want to click on that row)

BUU's extractor recognizes that the action lives in a row context, generates the XPath automatically, shows it for verification.

**2. Step blocks can't be highlighted for text selection.**

When Matthew tries to highlight text inside a step block (e.g. to copy a selector value), the step block itself gets picked up by the drag handler instead. The drag-to-reorder behavior is intercepting the mousedown before the text-selection gesture can start.

Fix: scope the drag handler to a dedicated grab handle (e.g. a `≡` icon at the left edge of each step block) rather than the entire block. Click-and-drag anywhere else in the block becomes plain text selection.

**3. Can't run a second flow after stopping the first — have to exit and reopen BUU.**

Some run state isn't being fully reset between runs. After clicking Stop, `isRunning` or one of its siblings stays true, blocking the next Run-button click. Could also be the runner process not being fully cleaned up, or the elapsed-ticker / heartbeat handlers not being torn down.

Reproduce: Run a flow → Stop it before completion → Try to Run again. Expected: clean start. Actual: blocked until app restart.

Also reproduced in v1.2.9: bug still present, was not addressed by the dropdown-name hotfix.

Look at `runStopped()`, `isRunning` flag, the `automationProcesses` Map cleanup in main.js, and any setInterval handles. Probably one of these isn't being cleared. The user has confirmed this is reproducible on v1.2.9 (2026-05-11).

**3a. Verification step window closes between steps. It should stay open.**

In step-mode verification, the pause panel that shows resolved selector + rendered value before an action fires is dismissing itself between steps instead of staying visible as the user advances through them. Expected: panel stays mounted, content updates per step, user clicks Next to advance. Actual: panel disappears between steps and presumably remounts (possibly with a flicker, possibly missing the data).

This is a renderer-side issue, almost certainly in `handleRunEvent`'s pause/step-event handlers. The pause overlay's show/hide cycling is probably keying off the wrong event (perhaps treating step-end as "close panel" instead of "wait for next step-start").

Reported on v1.2.9 (2026-05-11).


**4. Move open-logs button logic onto the Run automation button.**

Right now there's a separate "Open log file" button that appears after a run completes. The intended UX is that clicking the Run button itself should open the current/last log file when no run is in progress. Reduces UI surface area.

Concretely: when `isRunning === false` AND a `currentLogPath` exists, the Run button's click handler opens the log instead of starting a run. When no log exists yet, it starts a run as today. Label could swap to "Open last log" in the idle-with-log state.

**5. Handle-dialog step shouldn't require a Next click in step-mode verification.**

In step-by-step verification mode, every step pauses and requires the user to click Next to proceed. For most steps this is the whole point — you want to inspect the resolved selector and rendered value before the action fires. But handle-dialog is purely passive: it just installs a listener and waits for the next dialog event from the page. There's nothing to verify before it runs.

Fix: in step/step-row mode, runStep's case for `'dialog'` should skip the pause-and-wait-for-next pattern and just install the listener silently. The user advances when the NEXT step (the one that actually triggers the dialog) pauses.

**6. Make everything slightly larger.**

Some text in the UI is hard to read. Bump base font size and step block element sizes. Don't go big — slightly. Probably one or two CSS variable changes in the root `:root` block in index.html.

Worth checking on a high-DPI monitor too, since BUU may be rendering with a different effective zoom than expected.

**7. Verify logs and reports are written during step-by-step verification runs.**

Matthew thinks they SHOULD be — and design intent says they should — but he wants confirmation. The flush() function in main.js writes the Excel log after each row's processing. In step-by-step mode each row is still processed; it just pauses between actions. The log writes should fire normally.

To verify: run a flow in step-by-step mode, advance through one full row of a small spreadsheet, check `%APPDATA%\better-update-utility\logs\` for the BUU-log file. Confirm the row appears in the All-rows sheet. If yes, no code change needed — just close the loop. If no, the verification-pause is somehow short-circuiting the per-row flush.

**8. Validate `{{token}}` brace pairs at save time.**

Today's token resolver uses `/{{([^}]+)}}/g`. A typo like `{{Neg Subtotal}}}` (one extra close-brace) silently produces garbage at row 1 of a 500-row run: the regex consumes `{{Neg Subtotal}}` cleanly and leaves a stray `}` after the substituted value, so a row gets `-75}` written into the price field, PestPac can't parse it, focus stays where it shouldn't, and the next step types into the wrong field. Cascade failure from a single typo.

Add a save-time validator that scans every selector / value / URL field for malformed token patterns:
- Stray single `{` or `}` not part of a `{{...}}` pair
- Mismatched brace counts overall
- `{{...{...}}` (nested braces — almost certainly a typo)
- Empty `{{}}`

Surface them as warnings in the existing validation banner above Save. Don't block save outright — the user might intentionally use literal braces somewhere — but warn loudly enough that the typo gets caught before the run.

Optionally: also catch column references that don't match any spreadsheet column header. That's harder because it requires reading the active spreadsheet, but it's the bigger value-add — most token failures aren't malformed braces, they're typos in column names.

Reported on v1.2.9 (2026-05-11) after Matthew hit it with `{{Neg Subtotal}}}` (triple close-brace) in his chargeback flow.

**9. Step-through-everything mode for setup/teardown.**

Today's step-by-step pause behavior applies only to main per-row steps. Setup and teardown once-flows run straight through without pausing — so when Matthew is building or debugging a setup flow, he can't verify selectors the same way he does for main steps. The runner's `runOnceFlow` (added in v1.2.8 Phase 3) doesn't check `currentMode === 'step'` or `'step-row'`; it just iterates steps. Whereas main's `runStep` consults the mode and inserts a pause-and-wait-for-next between steps.

Add a new third start-mode: **Step through everything**. Behavior:
- **Run all** (existing) — no pausing anywhere
- **Step through each step** (existing) — main steps pause, setup/teardown run straight
- **Step through each row** (existing) — pause once per row, main only
- **Step through everything** (new) — pauses on every step in every phase (setup, main, teardown)

Use case: first few times you build or debug a setup/teardown attachment. After the pair is verified, drop back to "Step through each step" for normal main-flow verification.

Implementation: add a constant `STEP_THROUGH_PHASES` in the runner template baked from a new param. In `runOnceFlow`, check that constant alongside `currentMode` and insert the same pause/wait-for-next logic main uses today. UI gets a fourth radio in the start-mode picker.

Estimated 1 hour. Self-contained — no schema changes, no preload changes, just runner template + UI.

Reported on v1.2.9 (2026-05-11) during chargeback setup-flow build.

**10. Updates unpin BUU from the Windows taskbar/Start menu.**

Every time Matthew installs a new BUU version, the taskbar pin disappears and he has to re-pin from scratch. Windows tracks pins by the .exe's full path. NSIS installers (which electron-builder uses) place the .exe under a path that may change between versions or include a version-stamped folder — so the post-upgrade .exe is treated as a different app than the pre-upgrade one, and the existing pin becomes a dead link that Windows quietly drops.

Likely fixes (need testing, not all may be necessary):
- Set `"perMachine": true` in electron-builder's `nsis` config so the install path is stable across versions and not under a user-profile folder that includes version components
- Add an NSIS pre-install hook that captures pin state before uninstall, then restores it post-install (heavyweight)
- Use `"oneClick": false` with `"allowToChangeInstallationDirectory": false` and a fixed install directory like `Program Files\Better Update Utility\` (no version subfolder)

The cheap experiment first: set `perMachine: true` (or confirm it's already true) and verify the install path doesn't include a version component. If `dist\win-unpacked` lands at the same target dir every release, the pin should survive. If not, NSIS hooks are next.

Also worth checking: is there a `shortcutName` or `installerIcon` config that's drifting between versions? Anything that changes the Application User Model ID (AppUserModelID) Windows uses to identify the pinned app will invalidate the pin.

Reported on v1.2.9 (2026-05-11). Matthew has tolerated this through v1.2.3 through v1.2.9 — every install loses the pin. Worth fixing because the user feedback friction compounds (he's now installed ~10 versions in two weeks).

**11. Pause button does not pause.**

The Pause button in the run controls doesn't actually pause the runner. Clicking it either does nothing visible or doesn't halt the row-loop progression. Expected: clicking Pause stops the runner at the next safe boundary (between rows or between steps in step-mode) and shows a Resume button. Actual: row processing continues regardless.

This is renderer-to-runner signal plumbing. Check:
- `pauseBtn` click handler in index.html (does it actually call any API?)
- Is there a `run-control` IPC with `cmd: 'pause'`?
- If so, is the runner's stdin readline handler routing 'pause' to a `currentMode = 'paused'` branch the row loop respects?
- Or has the pause path never been fully wired (vestigial UI from an earlier design intent)?

Reported on v1.2.9 (2026-05-11) during chargeback flow build.

**12. Per-step on-fail flows. [SCOPE WARNING: full v1.2.8-size feature; consider splitting to v1.4.0]**

Each step in a per-row flow can optionally declare a once-flow to run if the step fails (after retry exhaustion). The on-fail flow runs the cleanup recipe, then row-level error handling continues normally. Motivating use case: chargeback flows that fail partway through service-order creation leave orphan service orders in PestPac. Per-step on-fail would delete the partial order before moving on.

**Why this is bigger than v1.2.8's setup/teardown:**

- Flow JSON schema: every step gets an optional `onFailFlowId` field
- Runner control flow: today the runner just logs errors and moves on (or stops). On-fail intercepts the failure path, runs the cleanup flow, then resumes normal error routing. Subtle interactions with the existing retry loop and circuit breaker
- Validation: on-fail must be once-flow, can't reference further composition (still one level deep)
- UI: every step block gets a new dropdown — not a single card at the top
- Phase indicator: no longer linear; needs "in recovery for row N" visualization
- Excel log: on-fail invocations need their own entries
- Idempotency: same problems as setup, magnified across many invocations
- Stop semantics: stop-during-on-fail is a new case
- Resume modal: "row 47 on-fail itself failed" is a new recovery scenario

Estimated 8-12 hours of focused work — same magnitude as v1.2.8's setup/teardown feature.

**Cheaper alternative considered and rejected by Matthew (2026-05-11):** Per-row on-fail flow (one flow-level attachment that fires when any row fails main steps). About half the complexity, covers chargebacks. Matthew explicitly requested per-step instead.

**Strategic note for next session:** If v1.3.0 starts to drag because of this item, consider splitting: ship items 1-11 as v1.3.0, defer item 12 to v1.4.0 with its own design doc. Don't let the big feature delay all the small wins.

**13. File-upload step type. [SCOPE: unknown, depends on file source]**

New step type that uploads a file from a path on disk via Playwright's `setInputFiles(selector, path)`. Path comes from a spreadsheet column (e.g. `DocPath`) or static value. Resolves run-context tokens. Failure handling: file-not-found at row start logs a clear error and skips the row, doesn't crash the run.

Implementation footprint if files are locally accessible:
- New step type entry in the step-type picker
- One new case in the runner's step dispatch (calls `setInputFiles`)
- Path-exists validation in the per-row preflight
- ~4-5 hours, isolated, low risk

Implementation footprint if files live in SharePoint/Drive/cloud:
- All of the above, plus
- Cloud SDK integration (Microsoft Graph for SharePoint, Google Drive API)
- Auth surface (OAuth flows, token storage, refresh)
- Per-file download-to-temp-folder before upload, cleanup after
- Probably 20-30 hours total, comparable to v1.2.8

**Origin:** Matthew has an emergent need to upload ~20,000 documents to PestPac. The documents currently live in some combination of his local computer, OneDrive, SharePoint, and possibly Google Drive — he's not sure yet because it's a fresh problem.

**Open questions to resolve before scoping:**
- Where do the 20k files actually live at run time? Local-accessible or cloud-only?
- Is there a clear PestPac upload flow Matthew has already validated manually? (Probably yes given he said "there is a clear step process to follow")
- Does the upload screen use a standard `<input type="file">` or some custom widget that `setInputFiles` won't handle?
- What spreadsheet shape — one row per file? Multiple files per customer row?
- How long is the wall-clock budget? 20k files at 10s each = 55 hours, multi-overnight; can the v1.2.5 resume infrastructure handle multi-day interrupted runs (it should; worth confirming on real data)

**Release timing:** Not committed. Three candidates discussed: bundle with v1.3.0 (+4-5 hours), standalone v1.3.1 (clean separation, ships when chargeback work is done), or v1.4.0 with per-step on-fail flows. Decision deferred until file-source question is answered.

---

### Scope estimate

Fourteen items in backlog; not all in v1.3.0. Items 1, 3, 3a, 5, 8, 9, 10, 11, 12, 13 are real fixes/features requiring code; 2, 4, 6 are UX changes; 7 may be no-op. Item 12 (per-step on-fail flows) is 8-12 hours, magnitude of v1.2.8. Item 13 (file-upload step) is 4-5 hours if files are local, 20-30 hours if cloud-source — uncommitted to a release until Matthew has more info on the document storage situation. Without items 12 and 13, the rest is 10-16 hours.

**Strong recommendation:** Split into focused releases:
- **v1.3.0** = items 1-11 (polish + bug fixes), 10-16 hours
- **v1.3.1** or v1.4.0 = item 13 (file-upload) once scope is known
- **v1.4.0** = item 12 (per-step on-fail flows), full design pass

User has not yet agreed to split; logged here for the next session to revisit.

**Not yet designed.** When picking this up, write a short `BUU-v1.3.0-DESIGN.md` first to lock the approach for each item before coding. Items 3, 3a, 7 may need investigation passes before they get a design.

---

## v1.2.8 — what shipped

**One-line summary:** Setup-and-teardown flow composition. Per-row flows can now attach a once-flow that runs before the row loop and another that runs after.

**Three-phase pipeline:** `login → setup once → main per-row → teardown once → logout`. All four phases share one logged-in browser session — setup and teardown don't pay an extra login cost.

**Flow JSON v1.1 format.** New fields: `name`, `runMode` (`per-row` | `once`), `setupFlowId`, `teardownFlowId`. v1.0 files load with defaults; auto-upgrade to v1.1 on first save. Only per-row flows can reference setup/teardown attachments. Only once-flows are valid as the targets of those references. Composition is one level deep — a once-flow attached as setup/teardown can't itself attach further setup/teardown.

**Run-context tokens for once-flows:** `{{TODAY}}`, `{{RUNID}}`, `{{PROFILE_USERNAME}}`. Per-row column tokens are blocked in once-flows (validation rejects them at save time).

**Checkpoint v3** with `flowMeta` (snapshot of runMode + setup/teardown refs) and `phaseProgress` (which phases completed). v2 checkpoints still loadable; defaults are synthesized.

**Resume modal** handles 5 new phase-aware scenarios: setup failed, setup stopped by user, teardown failed, teardown stopped by user, teardown pending (main completed but cleanup didn't run). Last three offer a "Run teardown only" recovery action that runs just the teardown phase, skipping setup and the row loop.

**Excel log** gets a new Phases sheet when phases actually ran. Summary's "Stopped reason" cell surfaces setup/teardown failures.

**UI:** new "Flow type" card on the Build Steps page with per-row/once radios and setup/teardown dropdowns. New phase-indicator pips (Setup → Main → Teardown) on the Run Progress panel, hidden when the flow has no composition.

**Phase 8 (build chargeback flows) is in flight by Matthew.** The setup once-flow creates a sacrificial service order, posts it (which opens the BUU batch), then unposts + deletes it — leaving an empty batch for main to post into. The teardown once-flow releases that batch. Selector pattern for finding the BUU row in PestPac's batch list: `xpath=//tr[td[normalize-space(text())='BUU']]//span[@id='Edit']` (substitute `Release` for the teardown). v1.2.9 will make this row-by-text selector pattern available without hand-writing XPath.

**Net diff:** ~1057 lines added across `src/main.js`, `src/index.html`, `src/preload.js`. Validated via `_validate-runner.js` across all 3 startModes and `_check-html-js.js` for the renderer. Released as v1.2.8 on GitHub 2026-05-11.

See `BUU-v1.2.8-DESIGN.md` for the full design rationale and `RELEASE-NOTES-v1.2.8.md` for the user-facing summary.

---

## v1.2.7 — what shipped

**One-line summary:** Single-issue dialog handler crash fix. The `dialog` step's `page.once('dialog')` listener leaked across rows when no dialog actually fired, causing a deferred crash on the next row that did fire one.

**Net diff:** ~30 lines changed in `src/main.js` (the `case 'dialog':` block in the runner template). Validated via `_validate-runner.js`. See `RELEASE-NOTES-v1.2.7.md`.

---

## v1.2.4 — what shipped

**One-line summary:** Unified runner with start-mode picker. Live Dry Run is gone, absorbed into the regular Run as a 'Start mode' option.

**Three modes:** Step through each step (default), Step through each row, Run all.

**Verification mode pause panel** shows resolved selector + rendered value before each action. User can switch to Run-all from any pause to release the brake. Stopping from a pause is graceful (current row abandoned, log flushed, checkpoint cleaned up).

**Removed:** `start-live-dryrun` IPC handler, `dryrun-event` channel, `buildDryRunner`, `panel-dryrun`, `nav-dryrun`, ~180 lines of dryrun renderer JS, 6 dryrun preload bridges. Build/Test selector probe was already client-side, no replacement needed.

**Net diff:** 279 insertions, 459 deletions (commit `a7cf1be`). Released as v1.2.4 on GitHub 2026-05-01. Source files: `src/main.js` 1073→980 lines, `src/index.html` 2089→1867 lines, `src/preload.js` 38→33 lines, plus `scripts/_validate-runner.js` (new, 113 lines, gitignored under `scripts/`).

See `BUU-v1.2.4-DESIGN.md` for the full design rationale.

---

## BUUA — parked

**Original framing:** A new product forked from BUU v1.2.5, focused on unattended automation at scale (multi-runner concurrency, folder-based job queue, headless, notification system).

**Current state (2026-05-07):** Parked. The strategic plan to fork BUU into a feature-frozen branch and have BUUA take over is paused — BUUA work resumes when WorkWave API access lands. BUU continues to grow features in the meantime (v1.2.8 is a feature release for setup/teardown). BUUA work is awaiting WorkWave API authentication unblock — see SESSION PICKUP NOTE above. When the API access lands, the BUUA-DESIGN.md sections flagged stale (2.1, 2.5, 2.9, 2.10) get rewritten with probe data.

**What stays accurate:** the parking lot of ideas, the architectural targets (multi-runner, job folder lifecycle, etc.), the rationale. What needs rework after probe data: anything specific about API mutation surfaces, hybrid fallback boundaries, and concrete endpoint contracts.

See `BUUA-DESIGN.md` for the full content; treat Section 0 as latest.

---

## What this index is NOT

- It's NOT a substitute for reading the actual design docs
- It's NOT a project roadmap or schedule
- It's NOT the architecture handoff (that's `BUU-PROJECT-HANDOFF.md`)

**For a new Claude session:**
1. Read this index first (you're here)
2. Read `BUU-v1.2.8-DESIGN.md` if working on v1.2.8 (setup/teardown flows)
3. Read the relevant `RELEASE-NOTES-v1.2.X.md` files if you need to know what each shipped version actually changed
4. Read `BUU-v1.2.5-DESIGN.md` and `BUU-v1.2.4-DESIGN.md` for design history of shipped features
5. Read `BUUA-DESIGN.md` if discussing or working on BUUA (parked but not abandoned)
6. Read `BUU-PROJECT-HANDOFF.md` (Section 0 first) for architecture, selectors, build commands, environment details, operating practices
7. Ask Matthew clarifying questions before assuming anything

---

## Maintenance

**This index needs updating when:**
- A new design doc is added → add a row to "What's where"
- A version ships → update status snapshot, add a "what shipped" section, move the "next thing to build" forward
- BUUA-DESIGN.md graduates from parking lot to design spec → update its row
- Strategic direction changes → update sections 2-4

**Last edited by:** Claude (work account), 2026-05-07 (post-v1.2.7-ship, v1.2.8 captured).
