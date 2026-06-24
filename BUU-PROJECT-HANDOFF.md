# BUU PROJECT HANDOFF

**For:** Future Claude session (this account or a fresh one)
**Last full rewrite:** 2026-05-04 (after BUU v1.2.5 design walkthrough)
**Section 0 last updated:** 2026-05-28 (post v2.2.3 ship — Tier 3 trustworthy reporting + cleanup complete)
**Read this entire document carefully before responding to Matthew. Then ask any clarifying questions.**

> **Heads up before you start:** Section 0 below is the freshest summary. Sections 1+ describe BUU's architecture and operating practices and are mostly still accurate, but version-specific status mentions throughout the body (e.g., "currently shipped: v1.2.5", "v1.2.4 backlog", etc.) are heavily out of date — BUU has since branched into BUU Legacy (frozen at v1.3.5) and **BUU 2.0** (active, currently shipped v2.2.3, v2.4.0 in design). When the body and Section 0 disagree, **Section 0 wins**. The DESIGN-INDEX.md CURRENT STATE block is also more current than this doc's body for active work.

---

## 0. WHERE WE ARE RIGHT NOW (FAST PICKUP)

If you read nothing else in this doc, read this section.

### 0.1 Two apps now — BUU Legacy is frozen, BUU 2.0 is active

The project split into two separate apps in May 2026:

- **BUU Legacy** — branch `v1.3.5-legacy`, `version.json` channel, productName "Better Update Utility", userData `%APPDATA%\better-update-utility`. **Frozen at v1.3.5.** Last Legacy release. No further feature work. Maintenance only.
- **BUU 2.0** — branch `v2.0.0-elastic`, `version-buu2.json` channel, productName "BUU 2.0", appId `com.entomobands.buu-2`, userData `%APPDATA%\buu-2`. **Active branch. All current feature work targets this.** Currently shipped: **v2.2.3**. Next release in design: **v2.4.0**.

Pushing one branch never affects the other; two separate version files so updaters never cross-wire. Legacy flows are copied into 2.0 once on first launch (then independent). When you read about "BUU" in the body of this doc (sections 1+), assume Legacy unless the context is clearly post-fork; the architecture-and-operating-practices content still mostly applies to 2.0 but with the elastic-pool overlay on top.

### 0.2 BUU 2.0 — what's shipped (v2.0.0 → v2.2.3)

- **v2.0.0** — Initial 2.0 release. Elastic worker pool with pull-queue coordinator (the `COORD` object in `src/main.js`), batch-pulling worker processes that pull batches over stdin until drained, license-aware elastic scaling, zero-loss append-only resume journal (`pool-journal-*.jsonl`), multi-flow job staging, merged pool log, file-upload step. Forked from BUU Legacy v1.3.5.
- **v2.0.1** — Auto worker-count accounts for hardware AND licenses; toolbar relabeling; license-buffer and recheck-interval grouped sensibly.
- **v2.0.2** — Stability + UX patches.
- **v2.1.0–v2.1.1** — Mid-2.x feature work and patches.
- **v2.1.2** — Bulletproof logout + PestPac login-overlay (`.MuiBackdrop-root`) fix + per-worker stop + setup/teardown scope. Critical reliability release.
- **v2.2.0** — Read field step (scrape a value from the page into a column).
- **v2.2.1** — **Lossless reclaim on elastic scale-down.** When a worker drains mid-batch (which happens constantly during elastic scale-down with ~19 free licenses), it now hands its unstarted batch tail back to the coordinator via a `reclaim` message *and* there's a catch-all `proc.on('close')` reclaim that backstops crashes/force-kills. `coordPickJobForWorker` and `coordScaleTo`'s `totalRemaining` are now requeue-aware; a zero-worker stall-guard respawn ensures the pool can never hang with requeued rows outstanding. Plus license-leak fixes (`licenseReaderLogout` before `browser.close()` in `check-license-cap` and `coordLicenseScale`), free-license count scoped to `#div_PestPac` with exact label match, sweeper + once-flow login selector fix (`data-testid="loginBtn"` not `LoginForm-loginBtn`), Read-field colName focus preserved on keystroke, worker card border. Coordinator test suite extended to **49/49** (TEST 9 added for reclaim).
- **v2.2.2** — **Tier 2 runtime unification: single-runner killed, pool worker is the sole runtime.** Tier 1: `loginToPestPac` deduplicated from 5 inline copies to a canonical SRC constant + regular function (also fixed login fallback). Sessions 2A-2H: helper dedup (selector helpers via shared SRC constants), step-type parity (textedit + readfield in both engines, with a regex sub-mode bug fix), pool worker gains step-by-step (mode/next-step/next-row/run-all/stop demux over stdin, pause-step + pause-row events, resolvePreview), network-aware retry + error classification ported, retry config port (retryCount/breakerThreshold/retryRowIndexes/reauthIntervalMin per-job), resume audit (journal meta now persists setupScope/startMode/retry knobs/phaseProgress), single-runner deleted (~1755 lines removed from main.js — buildRunner template + all single-runner IPC handlers + checkpoint v3 handlers + automationProcesses Map). preload.js gained a shim layer so the existing renderer keeps working (startAutomation → poolSubmitJob+poolStart, runControl → poolRunControl, checkpoint v3 → no-ops). **Renderer NOT rewritten this session — deferred to v2.4.0**, since the shim covers the call surface and pool events are bridged back to the old automation-event shape. **NOT validated end-to-end against PestPac live yet** — that's Matthew's next step before pushing to release.
- **v2.2.3 (CURRENT SHIPPED)** — **Tier 3 trustworthy reporting + cleanup.** The release that addresses the 2026-05-28 void-flow false-ok crisis (336 leads reported ok, zero actually persisted). Seven sessions: 3A — dialog text always logged (blanket page.on('dialog') in pool worker; per-row __dialogs[] array + dialog event journaled by coordinator as discriminated `{t:'dlg',...}` records) plus skip/error reclassification (retry-exhaustion and errHandle='skip' now return status='error'; 'skip' reserved for user-chosen filtering only). 3B — counter display refinement (reclaims tagged with reason at requeue time: drain/user-stop/breaker/crash; distinctDone headline counter from completedRows.size; "+N re-processed (X scale-down, Y user-stop, Z breaker, W crash)" breakdown line on the pool status panel; reclaimsByReason + reclaimsTotal exposed in pool-status). 3C — diagnostic capture on every row (screenshot.png + dom.html.gz + url.txt + steps.json + console.log + responses.log + dialogs.json written to <logsDir>/failures-<poolId>/row-<N>-<status>-<errorCategory>/, per-(status,errorCategory) bucket cap default 10, opt-in toggle in pool-launch UI default ON, persisted in journal meta for resume, best-effort all-try/catch). 3D — verify-after-action pass (THE feature: after every row, re-navigate to the row's primary URL and read back type/select/checkbox writes via auto-derived expected map; mismatches reclassify to status='error' with errorCategory='verify-mismatch' and the offending field names; verifyOk:true flag for false-fail cases; toggle in pool-launch UI default ON; ~5-15s cost per row). 3E — log retention (startup auto-delete of buu2-worker-*.log, BUU2-log-*.xlsx, and failures-pool*/ dirs older than logRetentionDays config days, default 30, 0 disables; runs asynchronously via setImmediate so it never blocks window paint; journals and read-field results preserved). 3F — working-data convention enforcement (one-click Archive button in staged-jobs list when a job has finished and pool is idle; moves source spreadsheet from <parent>/ to <parent>/Finished/ via new archive-spreadsheet IPC; suffixes with ISO timestamp if destination exists; no silent overwrites). Plus carried bug fixes: pool-start resets reclaim tally on fresh runs; circuit-breaker counts errors not skips; preload shim defaults diagnostic capture + verify ON for legacy startAutomation path. main.js grew from 2982 lines (v2.2.2) to ~3500 lines net. NOT validated end-to-end against PestPac live yet — first real run will confirm verify's comparison normalization (trim+lowercase) handles all PestPac field types and the bucket cap of 10 is the right default.

### 0.3 BUU 2.0 — what's in flight

- **v2.4.0** — full agenda in `BUU-v2.4.0-DESIGN.md`. Locked 2026-05-27 in a long live-debugging session against PestPac's Void Lead flow, then extended after a 9,854-row big run revealed concurrency/burn-time issues, then again after finding the journal under-reports successes. **25 items.** Runtime unification (originally item 1 of v2.4) was carved out into **v2.2.2** and shipped 2026-05-28 — see entry above. v2.4.0 picks up at the dialog/diagnostic/wait/flow/concurrency items below.
  - ~~Foundation: unify the three-runtime structure (single-runner / pool-worker template / sweeper template) into one step engine.~~ **DONE in v2.2.2.**
  - Dialog handling: auto-accept/decline checkboxes on every action step; remove the standalone Handle Dialog step type; dialog text always logged; skip↔error reclassification.
  - Diagnostic capture: screenshot + DOM + URL + step trail + console buffer per failed row, opt-in toggle, per-error-bucket sampling cap. Plus log retention.
  - Wait/state primitives: URL-change wait, navigation-complete wait, state-aware selectors (`:enabled`/`:disabled` actually wait for state), generic Wait step, per-step action timeout.
  - Flow ergonomics: Run Pool is the only Run, step move-up/down buttons, hot-reload flow edits between runs, pool preview/verification mode.
  - Reliability: logout-attempt warnings, smarter logout retry.
  - New capabilities: spreadsheet-free flow type, sequential flow queueing, scheduled flow runs (one-shot / daily / weekly / monthly + cron).
  - Concurrency control + burn-time caps (added after the 9,854-row big run + the 119-worker near-crash): adaptive worker scaling respecting all three caps (license / PestPac response / local machine) with three signals (duration p75, wall-clock-vs-Playwright-time ratio, skip rate); ramped startup in waves to avoid cold-start storm and resource shock; Auto becomes a ceiling not a launch target; hardware formula includes RAM. Per-row total-time timeout. Dup-row-counter fix + reclaim double-record investigation.
  - Verification (item 25, added 2026-05-28): a verify pass that fresh-navigates to a failed row and reads back the fields the flow's write steps intended to set, comparing actual-vs-intended; reclassifies false skips to ok, names the failing field on real failures. Default verify-on-failure; opt-in verify-every-row mode. **Evidence it's needed:** a live Read-Lead-Status check found 2,834 of 4,100 "skipped" rows were actually already voided — the runner's success/failure determination is wrong on a consistent fraction of rows. The read MUST be a fresh-navigate read (proves PestPac persistence), not a same-page inline read (only proves the field accepted input before Save).
- **Deferred to v2.5** — Field Catalog (persistent observation store of every PestPac field BUU has seen), parallel multi-flow runs.
- **Deferred to v3.0 branch** — PestPac API integration / hybrid mode.

### 0.4 BUU Legacy (v1.x) — final state

- v1.3.5 is the last Legacy release. Frozen. No further feature work.
- v1.3.0-v1.3.5 covered polish, bugfixes, UI sizing fixes, and the items captured in `BUU-v1.3.4-DESIGN.md`. Some 1.3.4 backlog items may have been carried into BUU 2.0 instead — check before assuming any v1.x item is unshipped.

### 0.5 What to do tonight if you're starting fresh and Matthew is asleep

**Do not implement v2.4.0 unattended. Do not ship to GitHub unattended.** Same rule as always — wait for Matthew. If you have writing/design work that's clearly low-stakes (refining the v2.4 design doc, expanding open-question lists, updating this handoff, refining DESIGN-INDEX.md), you can do that. If a critical bug surfaces and Matthew is unreachable, diagnose and write up the fix as a proposal — don't apply it.

### 0.6 Solo-user mode — git/release caution is calibrated wrong by default

**Matthew is currently the only user of BUU 2.0** (and the only user of Legacy v1.3.5). No one else has either installed. When Matthew says ship, ship all the way (bump version in BOTH `src/main.js` `CURRENT_VERSION` AND `package.json`, commit, tag, push branch + tag, build, `gh release create`, update `version-buu2.json` on `main` BOM-free). He tests on his own machine after.

### 0.7 The 2026-05-27 Void debugging session — institutional context for v2.4 design choices

The v2.4 agenda was shaped by a long live-debugging session of a Void Lead flow that struggled across multiple runs. The key insights — preserved here so a fresh Claude session understands *why* certain items are in v2.4:

- The flow's Handle Dialog step *appeared* to handle confirms but actually allowed Playwright's default-dismiss behavior to click Cancel. Reopen clicks "succeeded" with no error, but Cancel was clicked on the confirm dialog, so the gated action (`reOpenLead()`) never submitted. WonStatus stayed disabled. This drove item 2-3 (auto-accept/decline checkboxes replace the Handle Dialog step entirely).
- Multiple rounds were lost diagnosing because we couldn't *see* what the page looked like at failure — only a one-line error. This drove item 6 (diagnostic capture on failure, screenshot + DOM + console).
- A wait-for-element timeout raise from 30s → 300s had no effect, because the failing timer was Playwright's `selectOption` action timeout (the 30s default for "found but not enabled"), which isn't user-configurable from the BUU step UI today. This drove item 12 (per-step action timeout).
- The `waitFor` field on Click steps accepts selectors but doesn't reliably honor state pseudo-classes (`:enabled`, `:disabled`) — it waits for the element to *exist*, which is useless when the element exists in both states and only its `disabled` attribute changes. This drove item 10 (state-aware selectors).
- Flow edits saved during a run silently no-op until the app is restarted (hot-reload bug). This cost ~2 rounds of "I added the fix, it didn't work" when in reality the fix never ran. Item 15.

### 0.8a SKILLS — read before doing data / reconciliation work

**`docs/skills/SKILL-pestpac-reconciliation.md`** is the MANDATORY procedure for any task shaped like "which leads still need X", "why did these end up wrong", "cross-reference these", or "build me a rerun / leftover / fix sheet". Created 2026-05-28 after a 336-lead mislabel (CLEANUP vs DUPLICATE) caused by building a sheet off an intermediate file and reporting counts from memory. The skill enforces: derive from ROOT sources (intent list + live scrape), never from intermediate output sheets; set per-row targets from intent, never a blanket value; and VERIFY every sheet (in memory AND after reading it back from disk) before handing it over. Before building any such sheet, open that skill and follow it exactly.

### 0.8 BUUA — fully resolved

The original "BUUA v2.0 hybrid backend" plan from 2026-05-04 was absorbed into BUU 2.0 itself. The architecture concerns (multi-runner concurrency, license-aware scaling, headless operation) all shipped in BUU 2.0 v2.0.0. The remaining piece (API integration) is now a v3.0-branch item, not BUUA. **The WorkWave API auth block from May 2026 is still open in principle** but no longer urgent — v2.4 work targets the browser-automation side, and v3.0 will revisit API access. `BUUA-DESIGN.md` is historical context only.

Past handoffs (and the outgoing-Claude voice in Sections 1–13 below) used the rhetorical posture of a careful release engineer shipping to a userbase: smoke test before release, smoke test before push, version.json must be last, etc. **That posture is wrong for current conditions.** Don't drag your feet on:

- Committing working changes to git
- Tagging
- Pushing to GitHub
- Publishing releases
- Pushing `version.json`

If a build is broken, the worst case is Matthew himself sees a 404 or auto-updates into a regression — he tells you, you fix it, you ship again. Iteration is cheap. **Reluctance to update git is now the bigger cost.**

Things that still need care, even solo:
- Don't commit secrets (`API DOCUMENTATION/portal-prose/` has plaintext API keys; the `.gitignore` excludes it)
- Don't commit unrelated work under a misleading commit message — separate concerns get separate commits
- Don't blow away tags or rewrite published history
- Pay attention to `git status` before committing so you don't accidentally include something stale

When more people start using BUU, Matthew will tell you and the rhetoric in Sections 1–13 becomes correct again. Until then, ship.

---

## 1. WHO YOU ARE TALKING TO

**Matthew** — Training and Implementation Manager at **Entomo Brands** (corporate office). He owns and is the primary operator of the Better Update Utility (BUU) — a desktop automation tool he commissioned to be built. He is technically literate enough to review code, run scripts, manage credentials, install builds, and validate edge cases. He prefers iterative collaborative work over one-shot deliveries.

### 1.1 How he likes to work

- He pushes back when he disagrees. Push back too — don't just defer.
- He asks "could we do X" questions to test the design, not because he's locked in. Steelman his idea before disagreeing, then state your honest read.
- He makes design decisions progressively — don't try to nail everything down up front.
- He values seeing diffs before they're applied to his code (use `ask_user_input_v0` for sign-off on anything non-trivial).
- He values brutal honesty when something didn't work. Lying to him by softening "it's broken" into "it might need another look" damages trust faster than admitting failure.
- He uses casual phrasing — "i" instead of "I," typos common, fragments common. Don't correct or formalize his messages.
- He works in real time on real automation jobs. When he says "im working on getting togeather another round of updates," that's data updates for a job he's running, not BUU updates.
- **He sometimes says "ship it, I trust you" when he's tired.** This is not blanket authorization for unbounded unattended work. The 2026-05-04 session ended with exactly this exchange and the right answer was *no*. See Section 11.5.

### 1.2 Your operating bias

- Read first, theorize never. If a diagnostic tool gives you ambiguous results, say so. Don't pattern-match.
- Diff-by-diff with sign-off, not 200-line drops.
- Validate runtime templates after editing (especially the Playwright runner template — see Section 3.1).
- Multiple choice questions via `ask_user_input_v0` are MUCH easier for him on mobile than typing.
- Push back when shipping pressure conflicts with shipping-while-correct. Saying "no, let's wait until you're awake" is a valid answer even when he says ship.

---

## 2. PROJECT OVERVIEW: WHAT BUU IS

**Better Update Utility (BUU)** — a Windows Electron desktop application that automates data entry into **PestPac**, the pest control CRM that Entomo Brands and their subsidiary brands use. It acts as a user (via Playwright/Puppeteer browser automation), reading rows from a spreadsheet and replaying actions on PestPac per row.

**Why it exists:** PestPac data entry is high-volume, repetitive, error-prone, and currently done by humans. BUU lets non-technical staff define a flow once visually, then run it across thousands of rows of data overnight.

**Project root:** `C:\Users\bigma\OneDrive\Desktop\Better Update Utility\`

**Key file structure:**
```
src/
  main.js                      ← Electron main process, runner template, IPC handlers
  preload.js                   ← Bridges window.api to ipcRenderer
  index.html                   ← Renderer (UI) — all CSS/JS embedded here
assets/
  icon.ico                     ← The official BUU icon (multi-size, validated working)
  icon-old.ico.bak             ← The previous broken icon, kept for forensics
build/
  installer.nsh                ← NSIS installer customization
flows/                         ← User-built flow definitions (JSON)
chromium/                      ← Bundled Playwright Chromium (3.7 MB chrome.exe)
dist/                          ← Build output (not in git)
upcoming/                      ← Matthew's working folder for in-flight automation jobs
scripts/                       ← One-off helpers, ALL prefixed with _ to keep out of build
  _validate-runner.js          ← Runner-template validator (use after every runner edit)
  _api-auth-test.ps1           ← BUUA WorkWave API auth probe
  _api-probe-sweep.ps1         ← BUUA WorkWave API mutation probe sweep
  creds.ps1                    ← API creds (gitignored, never commit)
  ...
API DOCUMENTATION/             ← BUUA reference (gitignored — contains plaintext API key)
BUU-PROJECT-HANDOFF.md         ← THIS FILE
BUU-PROJECT-HANDOFF.md.bak     ← Previous version, kept for reference
DESIGN-INDEX.md                ← Single entry point for active design work
BUU-v1.2.4-DESIGN.md           ← Shipped 2026-05-01; reference
BUU-v1.2.5-DESIGN.md           ← Locked 2026-05-04; not yet implemented
BUU-v1.2.5-DESIGN.md.bak       ← Pre-walkthrough version
BUUA-DESIGN.md                 ← v2.0 fork; partially stale, awaiting probe data
README.md
GITHUB_GUIDE.md
package.json                   ← Build config, version "1.2.4"
version.json                   ← Auto-update trigger, 1.2.4
```

**Stack:**
- Electron 28.3.3
- Playwright (browser automation)
- Puppeteer (alternative scripting)
- keytar (Windows Credential Manager for credentials)
- exceljs (large spreadsheet streaming reads/writes)
- xlsx aka SheetJS (smaller in-memory operations)
- electron-builder 24.13.3 (NSIS Windows installer)

**Currently shipped to fleet:** v1.2.4
**Distribution:** GitHub releases at `EntomoBrandsMR/better-update-utility-release` (private repo)
**Auto-update:** App reads `version.json` from `raw.githubusercontent.com/.../main/version.json` on launch; if newer, offers to download the .exe from the release URL. **Note:** `raw.githubusercontent.com` has a 5-minute Fastly cache. This is a known footgun for tight ship-then-test cycles. Probably moves to a non-cached endpoint in BUUA.

---

## 3. KEY ARCHITECTURE FACTS

### 3.1 The runner template pattern (CRITICAL)

`src/main.js` contains a function `buildRunner(...)` that returns a **template literal** of JavaScript code. This code is written to a temp file and executed as a separate Node process by `child_process.spawn(process.execPath, [runnerPath, ...], { env: { ELECTRON_RUN_AS_NODE: '1' } })`.

**Why this matters:**
- The runner template is Playwright code that drives Chromium. It's compiled at runtime.
- Anything you edit inside that template literal needs the JS to remain valid AFTER template substitution.
- Special characters need to be escaped at the right level (e.g., `\\'` in the template renders as `\'` in the runner).
- **You CANNOT just run `node --check src/main.js` to validate the runner code** — you have to render the template first.
- Use `scripts/_validate-runner.js` after EVERY runner-template edit. The pattern: extract `buildRunner` source, eval it to get the function, call it with sample args, write the rendered output to a temp file, run `node --check` on the temp file. If you can't find that helper in the repo, ask Matthew or recreate it (it was last seen at 4285 bytes, dated 5/1).

### 3.2 Confirmed PestPac selectors (DO NOT GUESS)

Stable selectors confirmed by hand-testing PestPac's actual DOM:

```
Login URL:           https://login.pestpac.com/
Company key field:   input[name="uid"]
Continue button:     button[data-testid="CompanyKeyForm-loginBtn"]
Username field:      input[name="username"]
Password field:      input[name="password"]
Login button:        button[data-testid="loginBtn"]
Post-login verify:   a[href*="AutoLogin"]
```

PestPac is React-based. **Avoid IDs like `:r0:`, `:r3:`** — they regenerate on each page load. Always prefer `data-testid`, `name`, or stable CSS class names.

### 3.3 The paste-HTML auto-selector workflow

In the BUU Build page, every "selector" field has a paste-HTML mode. Users copy raw outerHTML from Chrome DevTools → paste into the field → BUU auto-extracts the best stable selector via priority: `data-testid` → `name` → non-dynamic `id` → `placeholder` → other data attributes. Don't break this when refactoring selector logic.

### 3.4 Concurrency model (current)

`src/main.js` line ~14:
```js
const MAX_CONCURRENT_RUNS = 1;
const automationProcesses = new Map();
```

The Map is keyed by `runId`. `MAX_CONCURRENT_RUNS = 1` enforces single-runner. The structure is multi-runner-ready, but **multi-runner moved to BUUA, NOT v1.2.5.** This boundary is deliberate.

### 3.5 The expanded checkpoint format (v1.2.3+)

Checkpoint files at `%APPDATA%\better-update-utility\checkpoint-<runId>.json` carry full context:
```json
{
  "schemaVersion": 2,
  "runId": "...",
  "profileId": "...",
  "spreadsheetPath": "...",
  "spreadsheetName": "...",
  "flowSnapshot": [...],     // entire flow at run start, immutable
  "headless": false,
  "errHandle": "stop",
  "rowDelayMin": 1,
  "rowDelayMax": 3,
  "totalRows": 8500,
  "startedAt": "ISO",
  "rowIndex": 4213,           // updated per row by saveChk()
  "ts": "ISO",
  "logPath": "..."
}
```

The runner's `saveChk(row)` reads existing checkpoint, mutates only `rowIndex` and `ts`, writes back. Preserves full context. On launch, BUU scans for v2 checkpoints and shows a Resume modal. **v1 checkpoints are filtered out.**

**v1.2.5 expands this** with optional `lastError` and `lastStop` fields — see `BUU-v1.2.5-DESIGN.md` Section 2.7.

### 3.6 Profile credential storage

10 profile slots, credentials stored in Windows Credential Manager via keytar. Service name: `BetterUpdateUtility`. Keys stored: `<profileId>:companyKey`, `<profileId>:username`, `<profileId>:password`. AES-256 fallback if keytar fails to load.

### 3.7 PestPac concurrent session model (LEARNED)

PestPac allows multiple concurrent sessions per username — verified by Matthew. This makes BUUA's multi-runner safer than typical CRMs (no session-cookie collision). Matthew plans 3 dedicated PestPac users for queue isolation in BUUA, not for session-conflict avoidance.

### 3.8 PestPac session lifetime (LEARNED 2026-05-01)

**PestPac enforces an absolute session lifetime around 6 hours**, regardless of activity. Discovered when the 5/1 6,278-row run timed out at the 6-hour mark and the next 18 hours of run-attempts all landed on the login page (no `UserDef1` field detected → every row failed). v1.2.5 item 2.11 introduces re-auth (timer + connectivity-wait + detection-based) to handle this.

### 3.9 Verification mode + start-mode picker (v1.2.4)

v1.2.4 unified "Live Dry Run" and "Run" into a single runner with a start-mode picker:
- **Step through each step** (default — pause before every action)
- **Step through each row** (pause after each completed row)
- **Run all** (no pauses, identical to v1.2.3 Run behavior)

Verification modes show a pause panel with resolved selector + rendered value before each action. Switch to Run-all from any pause to release the brake. Stopping from a pause is graceful (current row abandoned, log flushed, checkpoint cleaned up).

**Removed in v1.2.4:** `start-live-dryrun` IPC, `dryrun-event` channel, `buildDryRunner`, `panel-dryrun`, `nav-dryrun`, ~180 lines of dryrun renderer JS, 6 dryrun preload bridges. Don't try to re-add these.

---

## 4. SHIPPED VERSION HISTORY

| Version | Shipped | Highlights |
|---|---|---|
| v1.1.9 | earlier | ELECTRON_RUN_AS_NODE fix, baked Chromium path |
| v1.2.0 | 4/26/2026 | Live dry run, dialog handler, remember last login |
| v1.2.1 | 4/28/2026 | Login bug fix in live runner; logout once at end |
| v1.2.2 | 4/28/2026 | Auto-updater follows GitHub CDN redirects |
| v1.2.3 | 5/1/2026 (early) | Icon fix, run guards, heartbeat, live counters, resume-on-launch, log retries |
| **v1.2.4** | **5/1/2026 (evening)** | **Unified runner with start-mode picker (step / step-row / run-all). Live Dry Run absorbed.** |

### 4.1 What v1.2.4 actually contains

Net diff from v1.2.3: **279 insertions, 459 deletions** (commit `a7cf1be`). Sources shrunk: `src/main.js` 1073→980 lines, `src/index.html` 2089→1867 lines, `src/preload.js` 38→33 lines.

New helper: `scripts/_validate-runner.js` (113 lines, gitignored). Use after every runner-template edit.

See `BUU-v1.2.4-DESIGN.md` for the full design rationale.

### 4.2 Known deferred bugs from v1.2.4 era (still unfixed in v1.2.4)

- **Run log table doesn't show historical Excel logs.** "Run log" tab reads from in-memory `logEntries` only, which resets each launch. Fix: scan logs folder on launch, populate "historical runs" view. Not in v1.2.5 scope.
- **Default `errHandle: stop` is wrong for production.** Already addressed by v1.2.5 item 2.3 (default → retry, `stop` removed entirely).

---

## 5. THE 5/1 CATASTROPHIC RUN (CONTEXT FOR v1.2.5)

**What happened:** Matthew ran a 6,278-row Duncan account-number-update job overnight on 5/1. The first ~4,300 rows ran cleanly. At the ~6-hour mark, PestPac's session timed out. For the remaining ~1,978 rows, every navigation landed on the login page; every row failed silently (status `error`); the run continued through the night burning rows.

**Result:**
- 4,287 rows processed successfully
- 1,991 rows logged as error after the session timeout
- Checkpoint never resumed automatically (runner exited with `finally`-deletes-checkpoint per old behavior)
- Matthew had to manually pull failed rows out of the log and build `Duncan Old Acct# Update - Remaing.xlsx` to re-run them

**v1.2.5 items directly motivated by this:**
- **2.3** — `errHandle: stop` removed; production runs should never stop on first error.
- **2.3b** — Consecutive-error circuit breaker. Default 20. Would have stopped the 5/1 run after row 4,307 instead of letting it burn 1,991 rows.
- **2.7** — Resume preserves checkpoint on any non-clean exit (including breaker trips); failed-row list recovered from log file at resume-time.
- **2.8 network-aware** — Wait-and-ping loop on confirmed PestPac/internet outages. Ten-minute wait triggers re-auth.
- **2.10** — Error log enrichment so post-run forensics actually tells you *what step / what selector / what value* failed.
- **2.11** — Re-auth (timer + connectivity-wait + detection-based). The detection-based trigger would have caught the 6-hour session expiration on the very next navigation.
- **2.12** — Retry failed rows. Eliminates the manual "pull failed rows out, build new spreadsheet" loop.

---

## 6. WHAT v1.2.5 LOOKS LIKE (SUMMARY — full design at `BUU-v1.2.5-DESIGN.md`)

**Status:** Design fully locked 2026-05-04 after a multi-hour walkthrough. **Implementation has NOT started.**

**Estimated work:** 15-20 hours, structured into 9 phases (see design doc Section 4).

### 6.1 The 10 locked items

| Item | Summary |
|---|---|
| 2.1 | Remember last spreadsheet upload directory in `buu-config.json` |
| 2.2 | Default row delays = 0–0 seconds |
| 2.3 | `errHandle` dropdown reduced to two options: Retry (default) and Skip. `stop` removed. |
| **2.3b** | Consecutive-error circuit breaker (default 20, configurable, 0=disabled) |
| 2.4 | Single stop path for both Stop buttons. Disable Run button on Stop click. |
| 2.5 | Token chips: drag-only on Build page (higher contrast); reference-only on Import page |
| 2.6 | Validation revamp: non-blocking pre-run prompt, navigate-to-fix, all-at-once highlighting, **delete Validate page** |
| 2.7 | Resume from any non-clean exit. Checkpoint preserved on breaker/crash/user-keep. Failed-row list from log. |
| 2.8 | Selector timeout / page load mode / retry count settings + network-aware retry (ping Google + PestPac, wait-and-ping loop on outage) |
| 2.10 | Error log enrichment: errorCategory taxonomy, Phase / Step #/ Step type / Step label / Field / Attempted value columns |
| 2.11 | Re-auth: timer + connectivity-wait + detection-based (post-navigation login-page check) |
| **2.12** | Retry failed rows post-completion. Runner-mode (`retryRowIndexes`), no temp spreadsheet, separate log file, flow-divergence prompt. |

### 6.2 Items NOT in v1.2.5

- Multi-runner / queues / unattended operation → **BUUA**
- API integration → **BUUA** (blocked on WorkWave support)
- GitHub raw cache fix → **BUUA** (uses non-cached endpoint)
- Historical run-log scanning in Run Log tab → separate small fix, not v1.2.5
- Pause-on-disconnect (full pause/resume state) → **BUUA** (v1.2.5 uses wait-and-ping which is the simpler substitute)

### 6.3 Cross-item interactions (don't break these silently)

- 2.3 + 2.8: "Retry" mode uses 2.8's retry count.
- 2.3b + 2.7: Breaker trip preserves checkpoint with `lastError: { phase: 'circuit-breaker' }`.
- 2.3b + 2.8: Connectivity-class errors do NOT count toward breaker.
- 2.4 + 2.7: Both Stop buttons share clean-shutdown + "Keep checkpoint?" prompt.
- 2.7 + 2.12: Share `extractFailedRowsFromLog(logPath)` helper. Share `retryRowIndexes` parameter shape.
- 2.8 + 2.11: Connectivity-wait > 10 min triggers re-auth before retry. Re-auth resets the 2-hour timer.
- 2.10 + 2.8: errorCategory column reflects post-ping classification.
- 2.10 + 2.3b: Breaker trip = synthetic All-rows entry + "Stopped reason" Summary cell.
- 2.11 + 2.7: Re-auth failure = fatal exit = checkpoint preserved.

### 6.4 Items needing post-ship validation (cannot test pre-ship)

These need a live PestPac session and/or real network conditions. They're done in the first real run after v1.2.5 ships — they're NOT release blockers.

- 2.4 stop-from-pause regression
- 2.11 timer-based re-auth (set short interval, observe firing)
- 2.11 detection-based re-auth (clear cookies via devtools mid-run)
- 2.8 network-aware retry (disconnect WiFi during run)
- 2.10 error categorization (induce known errors, verify categories)
- 2.12 retry-failed (complete a run with failures, click Retry)

Items that pass mid-build validation via `_validate-runner.js` + manual click-through are NOT in this list — they ship with confidence.

---

## 7. BUUA (v2.0): WHAT'S NEXT AFTER v1.2.5

**Status:** Hybrid backend architecture LOCKED 2026-05-04. Rest of the design doc is partially stale, awaiting probe data.

**Blocked on:** WorkWave API support reply.

**Test scripts in place:** `_api-auth-test.ps1`, `_api-auth-combos.ps1`, `_api-auth-theory3.ps1`, `_api-probe-sweep.ps1`, all in `scripts/` (gitignored).

### 7.1 Headline differences from BUU

- Multi-runner concurrency (single process, many runners — built in from day one)
- Job queue with folder-based lifecycle (jobs/unstarted, queued, running, done, failed)
- Headless-by-default, designed to run off-site (separate machine / VM / cloud)
- Notification system for unattended operation (email first, push next, mobile companion eventually)
- No verification UI, no Live Dry Run, no Build/Test page — flows imported from BUU
- Hybrid backend: PestPac API where available (lots faster, more reliable), browser automation where API doesn't cover the action
- Probably non-cached version-feed endpoint (the GitHub raw 5-min Fastly cache is bad fit for unattended-fleet update channel)

### 7.2 What stays the same

Flow JSON format, profile credential storage pattern (keytar + AES fallback), checkpoint v2 format, Excel log format, runner template approach, PestPac selectors, exceljs streaming.

### 7.3 What to NOT do unprompted

- Don't try more credential guesses for WorkWave API (we exhausted defensible theories — 4 attempts, all 401)
- Don't rewrite stale BUUA-DESIGN.md sections (2.1, 2.5, 2.9, 2.10) yet — they need probe results
- Don't push BUU repo with `API DOCUMENTATION/portal-prose/` un-gitignored (already gitignored, but verify)
- Don't add multi-runner to BUU. It's a BUUA boundary.

See `DESIGN-INDEX.md` for the latest BUUA pickup state.

---

## 8. TOOL ENVIRONMENT

### 8.1 Filesystem access

- Read/write access to Matthew's machine via Filesystem and desktop-commander MCP servers.
- `desktop-commander:read_file` chokes on Excel files >10 MB — for large xlsx, use Node + exceljs.
- For BUU source edits, prefer `desktop-commander:edit_block` with surrounding context for uniqueness.
- After every `edit_block`, `view` the file again before further edits — your context is stale otherwise.

### 8.2 OneDrive lock issue (DISCOVERED 2026-05-04)

**Atomic-rename writes to existing files in the project folder fail with EPERM** because OneDrive holds the existing file during sync. Both `Filesystem:write_file` and `filesystem:write_file` use atomic-rename and will hit this on overwrites. New files write fine; overwrites fail.

**Workaround:**
1. Make a backup: `Copy-Item original.md original.md.bak -Force`
2. Delete original: `Remove-Item original.md -Force`
3. Write new content (now creates a new file, not an overwrite): `Filesystem:write_file ...`

This affects every src file edit, every package.json bump, every version.json update during implementation. Either work around per-file, or have Matthew pause OneDrive sync before implementation phase.

`desktop-commander:edit_block` and `desktop-commander:write_file` may behave differently — they don't use the same atomic-rename pattern. Test before relying on them. The 2026-05-04 session only confirmed the issue with the Filesystem tools.

### 8.3 Build environment

- Node 24.15.0
- electron-builder 24.13.3 (cache at `%LOCALAPPDATA%\electron-builder\Cache\`)
- npm scripts: `npm run build` (runs electron-builder), `npm start` (electron .)
- Build cache and project folder are in Defender exclusion list (added during v1.2.3 to fix Smart App Control blocks).
- `cmd.exe /c` wrapper required for npm commands in PowerShell because of execution policy restrictions.

### 8.4 GitHub setup

- **Repo:** `EntomoBrandsMR/better-update-utility-release` (private)
- **gh CLI authenticated as:** `EntomoBrandsMR` (`gho_*` token in Windows credential keyring)
- Path: `C:\Program Files\GitHub CLI\gh.exe`
- **Verified working** through v1.2.4 ship (5/1/2026)

### 8.5 Useful commands

```powershell
# Verify gh auth
& "C:\Program Files\GitHub CLI\gh.exe" auth status

# Check installed BUU version
$exe = "C:\Users\bigma\AppData\Local\Programs\Better Update Utility\Better Update Utility.exe"
(Get-Item $exe).VersionInfo | Select-Object ProductVersion, FileVersion

# Find recent runner logs
Get-ChildItem "$env:APPDATA\better-update-utility\logs\" | Sort LastWriteTime -Descending | Select -First 5

# Check checkpoint orphans
Get-ChildItem "$env:APPDATA\better-update-utility\checkpoint-*.json"

# Validate runner template after edit
node scripts\_validate-runner.js
```

### 8.6 Memory tool

The conversation may use a memory system. **The 2026-05-04 session did NOT preserve recent notes there** — the context window was compacted, with full transcript stored at `/mnt/transcripts/`. If you suspect prior context exists, check the transcript first.

This document + `DESIGN-INDEX.md` + `BUU-v1.2.5-DESIGN.md` + `BUUA-DESIGN.md` are the source-of-truth artifacts.

---

## 9. SHIP COMMAND REFERENCE

When v1.2.5 (or any version) is ready to ship, the sequence is:

```powershell
cd "C:\Users\bigma\OneDrive\Desktop\Better Update Utility"

# 1. Bump package.json version
# 2. Update version.json with new download URL
# 3. Build
cmd /c "npm run build"

# 4. Smoke test the .exe locally — install it, launch, verify it starts cleanly,
#    verify new UI elements present, verify auto-update detection logic doesn't break

# 5. Commit + tag + push
git add .
git commit -m "v1.2.5 - <one-line summary>"
git tag v1.2.5
git push origin main --tags

# 6. Publish release
& "C:\Program Files\GitHub CLI\gh.exe" release create v1.2.5 `
  "dist\Better Update Utility Setup 1.2.5.exe" `
  --repo EntomoBrandsMR/better-update-utility-release `
  --title "v1.2.5" `
  --notes "<release notes>"
```

**Auto-update gotcha:** `raw.githubusercontent.com` has a 5-minute Fastly cache on `version.json`. Don't conclude auto-update is broken if the test machine doesn't see the new version immediately — wait 5 minutes and re-check.

---

## 10. FILES TO VERIFY EXIST

```
C:\Users\bigma\OneDrive\Desktop\Better Update Utility\
├── BUU-PROJECT-HANDOFF.md            ← THIS FILE
├── BUU-PROJECT-HANDOFF.md.bak        ← Previous version
├── DESIGN-INDEX.md                   ← Single entry point
├── BUU-v1.2.4-DESIGN.md              ← Shipped reference
├── BUU-v1.2.5-DESIGN.md              ← Locked, not implemented
├── BUU-v1.2.5-DESIGN.md.bak          ← Pre-walkthrough version
├── BUUA-DESIGN.md                    ← v2.0 fork
├── package.json                      ← version "1.2.4"
├── version.json                      ← references 1.2.4
├── src\main.js                       ← contains 'CURRENT_VERSION = '1.2.4'' on line ~10
├── src\preload.js                    ← exposes findOrphanCheckpoints, loadCheckpoint, discardCheckpoint
├── src\index.html                    ← Build / Import / Run / Run Log pages, no Validate page yet (deleted in v1.2.5)
├── assets\icon.ico                   ← 372 KB, multi-size
├── assets\icon-old.ico.bak           ← 361 KB, broken original (forensic)
├── scripts\_validate-runner.js       ← runner-template validator (4285 bytes)
├── scripts\_reconcile-invoices.js    ← Duncan reconciliation, completed
├── scripts\_verify-date-flip.js      ← Duncan reconciliation diagnostic
├── scripts\_api-auth-test.ps1        ← BUUA WorkWave API auth probe
├── scripts\_api-probe-sweep.ps1      ← BUUA mutation probe sweep
├── scripts\creds.ps1                 ← API creds (gitignored)
├── upcoming\                         ← Active job folder (Duncan jobs in flight)
├── API DOCUMENTATION\                ← BUUA reference (gitignored)
└── dist\Better Update Utility Setup 1.2.4.exe   ← 207 MB

Should NOT exist:
├── scripts\force-icon.js             ← deleted, do not re-add
├── scripts\regenerate-icon.js        ← deleted (one-shot)

Defender exclusions (must be in place):
├── C:\Users\bigma\OneDrive\Desktop\Better Update Utility (project folder)
└── C:\Users\bigma\AppData\Local\electron-builder (build cache)
```

---

## 11. MISTAKES MADE IN PRIOR SESSIONS (LEARN FROM THESE)

### 11.1 The icon rabbit hole (v1.2.3 session)

Spent ~2 hours trying to fix the icon by post-processing the .exe with rcedit. **The actual problem was the source `.ico` file was malformed** — every tool that looked at it produced different results. Should have visually inspected the source icon FIRST. Once it was regenerated from scratch using sharp + png-to-ico, the problem evaporated.

**Lesson:** when diagnostic tools disagree about a file, the file is the problem, not the tools.

### 11.2 Lost track of the bug list (v1.2.3 session)

User listed THREE bugs at the start of a session. Addressed #1 and #3 but lost track of #2 (the most important) for several turns. Pattern-matched a different fix to the wrong bug.

**Lesson:** when a user lists bugs, write them down explicitly and check each one off. Don't pattern-match.

### 11.3 Almost shipped force-icon.js without testing (v1.2.3 session)

Wrote a build-pipeline tool, ran it on both the unpacked .exe AND the NSIS installer .exe. **NSIS installers have a different binary structure that the tool corrupted.** First build produced a 0.39 MB Setup.exe (corrupted from 229 MB). Caught it before shipping but barely.

**Lesson:** if a tool was designed for one kind of binary, don't assume it works on another. Test on each target separately.

### 11.4 Theorized when should have measured (v1.2.3 session)

After the icon "succeeded" by flawed diagnostic tools, claimed "icon is now real artwork" with confidence based on byte-size heuristics that were lying. The right answer was **install it and look** — which Matthew suggested first.

**Lesson:** when downstream verification is cheap (just install and look), do that BEFORE trusting upstream diagnostics.

### 11.5 Theorized about the 5/1 6,278-row run instead of measuring (multiple sessions)

Floated theories about what went wrong without sufficient log evidence. Some were wrong and led Matthew to question his own work.

**Lesson:** when symptoms don't fully add up, say "I don't know" instead of constructing a hypothesis. False explanations are worse than no explanation.

### 11.6 Force-icon.js conflicted with Smart App Control (v1.2.3 session)

By modifying the .exe AFTER electron-builder had set integrity hashes, created a hash mismatch that triggered Smart App Control to refuse install. Cost: another full rebuild after Matthew added a Defender exclusion.

**Lesson:** post-build modification of signed binaries is a red flag. Either fix it in the source pipeline or accept the fix you're about to make is fragile.

### 11.7 Almost shipped v1.2.5 unattended despite good reasons not to (2026-05-04 session)

Matthew said three times during the late-night session "ship it, I trust you" — including in response to direct pushback. Resisted twice, then almost slid into doing it on the third request. Pulled back to "design doc only" after considering: (a) 15-20 hours of complex implementation across deeply interconnected files, (b) post-ship validation needs a live PestPac session that's days away, (c) GitHub release auto-installs to fleet within 5 minutes, (d) OneDrive lock issue would have caused unpredictable failures during edits, (e) precedent of v1.2.3's force-icon.js disaster which was *exactly* a confident "I'll handle it" decision on more-complex-than-expected work.

**Lesson:** "the user said yes" is not blanket authorization. The right response to "ship it, I trust you" on something risky and unbounded is "I hear you, and I'm still saying no — here's why." Trust is for things you've validated; absent validation, push back.

**Lesson 2:** When the next failure mode (OneDrive lock) shows up during the very first attempted action, that's a signal to stop, not to power through. The signal was correct; the design doc rewrite still succeeded via workaround, but extrapolating that workaround across 15-20 hours of unattended work was the wrong move.

### 11.8 Reconciliation script OOM'd silently (Duncan job, multiple sessions)

First version used the synchronous `xlsx` library and ran for 27 minutes before failing on a 480k-row file. Should have known from file sizes that streaming was required from the start.

**Lesson:** always add progress output to long-running scripts upfront. Know your library's memory model before deploying it on large data.

---

## 12. SUGGESTED FIRST MESSAGE (FRESH CLAUDE SESSION)

When you start fresh, this is the opening to use:

> Hey Matthew — I have your handoff and design docs loaded. Where we are:
>
> - **v1.2.4 shipped 5/1**, currently installed on your machine
> - **v1.2.5 design is locked** (10+ items, ~15-20 hours of implementation, see `BUU-v1.2.5-DESIGN.md`) — implementation has NOT started
> - **BUUA is blocked** on WorkWave API support reply
> - **No active reconciliation jobs** — Duncan job wrapped up, you've moved on to follow-up update jobs
>
> Where do you want to start? Options I see:
>
> 1. **Begin v1.2.5 implementation** — Phase 1 (trivial UI items 2.2 + 2.6 button rename, ~30 min) is a good warmup
> 2. **Review the v1.2.5 design** before starting — anything you want to revisit?
> 3. **Check WorkWave** — has the rep replied? (If yes, run `_api-auth-test.ps1` with the new creds)
> 4. **Something else** — what's on your mind?

---

## 13. PRINCIPLES TO HOLD ONTO

The most important things you can do as a fresh Claude on this project are:

- **Earn trust quickly by reading carefully before acting.** This document, then `DESIGN-INDEX.md`, then the relevant design doc.
- **Use `ask_user_input_v0` for sign-off on anything non-trivial.** Easier for Matthew on mobile than typing.
- **Push back when you disagree.** He expects this, and "ship it" doesn't override correctness concerns.
- **Be honest when you don't know.** Speculation is worse than an honest "I don't know — let me check."
- **Diff-by-diff with sign-off.** Not 200-line drops. Especially for runner-template edits.
- **Validate runner template via `_validate-runner.js` after every edit.** No exceptions.
- **Stop and verify when an unexpected failure mode shows up.** Don't power through it; the failure is information.

If something comes up that's not covered here, ask Matthew directly — he is patient with clarification questions and prefers them to wrong assumptions.

---

## 14. END OF HANDOFF

**Last full rewrite:** 2026-05-04 (post-v1.2.5-design-lock).
**Previous version:** `BUU-PROJECT-HANDOFF.md.bak` (4/30 era, pre-v1.2.4-ship).

— Outgoing Claude (work account)
