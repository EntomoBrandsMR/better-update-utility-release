# BUU DESIGN INDEX

**Purpose:** Single entry point for active design work. Read this first.
**Last updated:** 2026-05-11 (post v1.2.8 ship; v1.2.9 backlog added).

---

## SESSION PICKUP NOTE (2026-05-04)

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

## What's where

| Document | Status | Read this when |
|---|---|---|
| **BUU-v1.2.8-DESIGN.md** | Drafting (renumbered from v1.2.7 on 2026-05-07) | Working on setup-and-teardown flows / three-phase pipeline |
| **RELEASE-NOTES-v1.2.7.md** | Shipped 2026-05-07 | Reference for the dialog-handler crash fix |
| **RELEASE-NOTES-v1.2.6.md** | Shipped | Reference for iframe-aware selectors |
| **BUU-v1.2.5-DESIGN.md** | Shipped | Reference for the resilience pack (retries, breaker, re-auth, etc.) |
| **BUU-v1.2.4-DESIGN.md** | Shipped 2026-05-01 | Reference for the unify-runner refactor |
| **BUUA-DESIGN.md** | Hybrid architecture LOCKED 2026-05-04; rest partially stale, awaiting API probe results. Strategic role superseded — see note below. | Discussing the v2.0 fork or anything automation-related. Section 0 is the latest. |
| **BUU-PROJECT-HANDOFF.md** | Section 0 refreshed 2026-05-07 with current ship status; body still has older version-specific status mentions | Need PestPac selectors, runner template details, build commands, file paths, operating practices |
| **API DOCUMENTATION/** | PestPac API spec + SDKs + portal prose docs | Anything API-related. swagger.yaml has 347 endpoints. portal-prose contains a plaintext API key — gitignore before commit. |

> **Strategic note (2026-05-07):** The "BUU enters bug-fix mode after v1.2.5; BUUA takes over feature work" plan from earlier is paused, not cancelled. BUU continues to grow features (v1.2.8 is a feature release) while BUUA work waits on WorkWave API authentication. When the API access lands, BUUA work resumes; flow composition built in v1.2.8 will be the natural foundation for BUUA's per-job flow specification. See `BUU-v1.2.8-DESIGN.md` Section 1 strategic note.

---

## Project status snapshot (2026-05-07, post-v1.2.7-ship)

- **v1.2.3 SHIPPED 2026-05-01** — Icon, run guards, heartbeat, live counters, resume-on-launch, log retries.
- **v1.2.4 SHIPPED 2026-05-01** — Unified runner with start-mode picker (step / step-row / run-all).
- **v1.2.5 SHIPPED** — Resilience pack: configurable retry, circuit breaker, network-aware retry, re-auth, retry-failed-rows, log enrichment, default `errHandle` flipped from `stop` to `retry`.
- **v1.2.6 SHIPPED** — Iframe-aware selectors. Click-step debug checkbox shipped as permanent feature.
- **v1.2.7 SHIPPED 2026-05-07** — Dialog handler crash fix. Single-issue hotfix; `page.once('dialog')` listener no longer leaks across rows when no dialog actually fires.
- **v1.2.8 SHIPPED 2026-05-11** — Setup-and-teardown flow composition. Three-phase pipeline (login → setup once → main per-row → teardown once → logout). New flow JSON v1.1 format (`runMode`, `setupFlowId`, `teardownFlowId`). Checkpoint v3 with phase progress. Resume modal handles 5 new phase-aware scenarios including "Run teardown only" recovery. New Phases sheet in Excel log. ~1057 lines added across `src/main.js`, `src/index.html`, `src/preload.js`. Phase 8 (build chargeback flows) is in flight by Matthew in the new UI.
- **v1.2.9 SHIPPED 2026-05-11** — Hotfix for the "every once-flow shows as buu-flow in the dropdown" bug introduced in v1.2.8. v1.2.8's saveFlow logic stamped the JSON's `name` field as the literal string `'buu-flow'` whenever both the in-memory `flowName` (no UI to set it) and the `flowNotes` field were empty — which was every time the user created a fresh flow. All three server-side lookup paths (`list-once-flows`, `resolveOnceFlowByName`, `validate-flow-references`) now key on the filename stem instead of `data.name`. Save handler also rewrites `data.name` to match the filename on write, so existing files self-heal next save.
- **v1.3.0 is the next BUU release.** Theme: small UX fixes + one selector improvement. Seven items in the backlog (the original v1.2.9 plan, pushed back one number when the name-collision hotfix took the v1.2.9 slot): (1) row-by-text selector mode, (2) text-selection inside step blocks, (3) can't run a second flow after stop without app restart, (4) move open-logs onto the Run button, (5) handle-dialog shouldn't require Next click in step-mode, (6) make UI slightly larger, (7) verify logs are written during step-mode (likely no-op). Estimated 6-10 hours total. Not yet designed; no doc started. Full detail in the v1.3.0 section below.
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

Look at `runStopped()`, `isRunning` flag, the `automationProcesses` Map cleanup in main.js, and any setInterval handles. Probably one of these isn't being cleared.

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

### Scope estimate

Items 1, 3, 5 are real fixes requiring code. Items 2, 4, 6 are UX changes. Item 7 may be no-op. Total estimated effort: 6-10 hours depending on what item 3 actually turns out to be (run-state cleanup bugs can hide).

**Not yet designed.** When picking this up, write a short `BUU-v1.2.9-DESIGN.md` first to lock the approach for each item before coding. Items 3 and 7 may need investigation passes before they get a design.

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
