# BUU PROJECT HANDOFF
**For: New Claude account (Entomo Brands work account)**
**From: Outgoing Claude (personal account, last session 2026-04-30)**
**Read this entire document carefully before responding to Matthew. Then ask any clarifying questions.**

---

## 1. WHO YOU ARE TALKING TO

**Matthew** — Training and Implementation Manager at **Entomo Brands** (corporate office). He owns and is the primary operator of the Better Update Utility (BUU) — a desktop automation tool he commissioned to be built. He is technically literate enough to review code, run scripts, manage credentials, install builds, and validate edge cases. He prefers iterative collaborative work over one-shot deliveries.

**How he likes to work:**
- He pushes back when he disagrees. Push back too — don't just defer.
- He asks "could we do X" questions to test the design, not because he's locked in. Steelman his idea before disagreeing, then state your honest read.
- He makes design decisions progressively — don't try to nail everything down up front.
- He values seeing diffs before they're applied to his code (use `ask_user_input_v0` for sign-off).
- He values brutal honesty when something didn't work. Lying to him by softening "it's broken" into "it might need another look" damages trust faster than admitting failure.
- He uses casual phrasing — "i" instead of "I," typos common, fragments common. Don't correct or formalize his messages.
- He works in real time with you on real automation jobs. When he says "im working on getting togeather another round of updates," that's not BUU updates — that's data updates for a job he's working on.

**Your operating bias should be:**
- Read first, theorize never. If a diagnostic tool gives you ambiguous results, say so. Don't pattern-match.
- Diff-by-diff with sign-off, not 200-line drops.
- Validate runtime templates after editing (especially the Playwright runner template — see below).
- Multiple choice questions via `ask_user_input_v0` are MUCH easier for him on mobile than typing.

---

## 2. PROJECT OVERVIEW: WHAT BUU IS

**Better Update Utility (BUU)** — a Windows Electron desktop application that automates data entry into **PestPac**, the pest control CRM that Entomo Brands and their subsidiary brands use. It acts as a user (via Playwright/Puppeteer browser automation), reading rows from a spreadsheet and replaying actions on PestPac per row.

**Why it exists:** PestPac data entry is high-volume, repetitive, error-prone, and currently done by humans. BUU lets non-technical staff define a flow once visually, then run it across thousands of rows of data overnight.

**Project root:** `C:\Users\bigma\OneDrive\Desktop\Better Update Utility\`

**Key file structure:**
```
src/
  main.js            ← Electron main process, runner template, IPC handlers, build pipeline
  preload.js         ← Bridges window.api to ipcRenderer
  index.html         ← Renderer (UI) — all CSS/JS embedded here
assets/
  icon.ico           ← The official BUU icon (multi-size, validated working)
  icon-old.ico.bak   ← The previous broken icon, kept for forensics
build/
  installer.nsh      ← NSIS installer customization
flows/               ← User-built flow definitions (JSON)
chromium/            ← Bundled Playwright Chromium (3.7 MB chrome.exe)
dist/                ← Build output (not in git)
upcoming/            ← Matthew's working folder for in-flight automation jobs and reconciliation files
package.json         ← Build config, dependencies, electron-builder settings
version.json         ← Auto-update trigger file (read by app on launch)
README.md
GITHUB_GUIDE.md
```

**Stack:**
- Electron 28.3.3
- Playwright (browser automation)
- Puppeteer (alternative scripting)
- keytar (Windows Credential Manager for credentials)
- exceljs (large spreadsheet streaming reads/writes)
- xlsx aka SheetJS (smaller in-memory operations)
- electron-builder 24.13.3 (NSIS Windows installer)

**Currently shipped: v1.2.3** (built locally, smoke test pending — see Section 5)
**Distribution:** GitHub releases at `EntomoBrandsMR/better-update-utility-release` (private repo)
**Auto-update:** App reads `version.json` from `raw.githubusercontent.com/.../main/version.json` on launch; if the version is newer than installed, it offers to download the .exe from the release URL.

---

## 3. KEY ARCHITECTURE FACTS YOU NEED TO KNOW

### 3.1 The runner template pattern (CRITICAL)

`src/main.js` contains a function `buildRunner(...)` that returns a **template literal** of JavaScript code. This code is written to a temp file and executed as a separate Node process by `child_process.spawn(process.execPath, [runnerPath, ...], { env: { ELECTRON_RUN_AS_NODE: '1' } })`.

**Why this matters:**
- The runner template is Playwright code that drives Chromium. It's compiled at runtime.
- Anything you edit inside that template literal needs the JS to remain valid AFTER template substitution.
- Special characters need to be escaped at the right level (e.g., `\\'` in the template renders as `\'` in the runner).
- **You CANNOT just run `node --check src/main.js` to validate the runner code** — you have to render the template first.
- I previously wrote a validator script (`scripts/_validate-runner.js`) that does this rendering. **Use it after every runner-template edit.** The pattern: extract `buildRunner` source, eval it to get the function, call it with sample args, write the rendered output to a temp file, run `node --check` on the temp file. If you can't find that helper in the repo, ask Matthew or recreate it.

### 3.2 Confirmed PestPac selectors (DO NOT GUESS)

These are stable selectors confirmed by hand-testing PestPac's actual DOM:

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

In the BUU Build page, every "selector" field has a paste-HTML mode. Users copy raw outerHTML from Chrome DevTools → paste into the field → BUU auto-extracts the best stable selector via priority: `data-testid` → `name` → non-dynamic `id` → `placeholder` → other data attributes. This dramatically reduces friction for non-technical users. Don't break this when refactoring selector logic.

### 3.4 Concurrency model (v1.2.3)

`src/main.js` line ~14 has:
```js
const MAX_CONCURRENT_RUNS = 1;
const automationProcesses = new Map();
```

The Map is keyed by `runId`. `MAX_CONCURRENT_RUNS = 1` enforces single-runner today, but the structure is multi-runner-ready. **v1.3.0 will set this to 3 and add per-profile queueing.**

### 3.5 The expanded checkpoint format (v1.2.3)

Checkpoint files at `%APPDATA%\better-update-utility\checkpoint-<runId>.json` now carry full context:
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

The runner's `saveChk(row)` reads existing checkpoint, mutates only `rowIndex` and `ts`, writes back. This preserves the full context. On launch, BUU scans for v2 checkpoints and shows a Resume modal. **v1 checkpoints (legacy `{rowIndex,ts}` only) are filtered out — they predate this feature.**

### 3.6 Profile credential storage

10 profile slots, credentials stored in Windows Credential Manager via keytar. Service name: `BetterUpdateUtility`. Keys stored: `<profileId>:companyKey`, `<profileId>:username`, `<profileId>:password`. AES-256 fallback if keytar fails to load.

### 3.7 PestPac concurrent session model (LEARNED)

PestPac allows multiple concurrent sessions per username — verified by Matthew. This makes v1.3.0 multi-runner safer than typical CRMs (no session-cookie collision). Matthew plans 3 dedicated PestPac users for queue isolation, NOT for session-conflict avoidance.

---

## 4. WHAT v1.2.3 ACTUALLY CONTAINS (LATEST VERSION)

This was a 7-diff session. All applied. Smoke test pending.

| # | Diff | What it does | Where it lives |
|---|------|--------------|----------------|
| 1 | Icon fix | Regenerated `assets/icon.ico` from a clean PNG via sharp + png-to-ico (the old icon was malformed and unreadable by .NET Icon class). electron-builder now embeds it natively. | `assets/icon.ico` (372 KB, 7 sizes) |
| 2 | Backend run guard | `start-automation` rejects if cap hit; `automationProcesses` Map keyed by runId; `stop-automation` accepts optional `{runId}` to kill specific run | `src/main.js` |
| 3 | UI run guard | `startRun()` early-exits if `isRunning`; `refreshRunBtn()` after `isRunning=true`; `runStopped()` calls `refreshRunBtn()` | `src/index.html` |
| 4 | Heartbeat + phases | Runner emits `{type:'heartbeat',phase,rowIndex,...}` every 5 seconds. UI handler updates status during slow phases (logging-in, cleanup) but stays out of the way during active rows | both |
| 5 | Live elapsed counter | New `rs-elapsed` stat box; `startElapsedTicker`/`stopElapsedTicker` updates every 1 second; defensive `runStartTime > 0` guard | `src/index.html` |
| 6 | Resume-on-launch | Expanded checkpoint format (v2); `find-orphan-checkpoints` IPC; `load-checkpoint` IPC; `discard-checkpoint` IPC; resume modal in HTML; `showResumePrompt`, `resumeChoice`, `executeResume` functions; init scans for orphans on launch | both + `preload.js` |
| 7 | Loud failure + log retries | `startRun` alerts loudly if `API.startAutomation` is undefined; runner log file created BEFORE chromium check (always have a paper trail); `flush()` rewritten with retry-on-EBUSY (3 retries × 800ms) and always-write-Summary even with 0 rows; `log-error` and `log-saved` events with UI handlers | both |

### 4.1 Critical bug we fixed in this session that you should know about

**The "phantom run" bug:** In v1.2.0 and v1.2.2, if `getBundledChromiumPath()` returned null OR if `start-automation` failed before reaching the spawn, the runner log file was never created and the user saw "Starting…" forever in the UI with no error. Matthew's 8,500-row run on 4/28 sat in this state for 7 hours. **Fixed in v1.2.3 Diff 7** by creating the runner log immediately on entry to `start-automation`, and adding a loud-fail UI alert when `API.startAutomation` is missing.

### 4.2 The `force-icon.js` saga (DO NOT REVISIT — already solved)

I spent an embarrassing amount of effort trying to use rcedit to post-process the .exe and force the icon embed. **It was the wrong fight.** The actual problem was that `assets/icon.ico` itself was malformed. Once I regenerated it cleanly using sharp + png-to-ico, electron-builder embedded it natively without any post-processing. There's no `scripts/force-icon.js` in the repo anymore — and there shouldn't be. Don't re-add it.

Side effect of using rcedit: it modifies the .exe AFTER electron-builder writes integrity hashes, causing **Smart App Control to block installation**. Matthew added a Defender exclusion for the project folder to work around this. With `force-icon.js` gone, Smart App Control no longer triggers — but the exclusion is still in place.

---

## 5. CURRENT v1.2.3 STATE: NOT YET SHIPPED

**Status as of session end (2026-04-30 ~10:30 AM):**
- ✅ All 7 diffs applied and validated
- ✅ Build succeeded: `dist\Better Update Utility Setup 1.2.3.exe` (207.3 MB)
- ✅ Installed locally
- ✅ Icon visually confirmed working (BUU logo on title bar, taskbar, Start menu, desktop shortcut, Setup.exe in File Explorer — Matthew confirmed all 5 spots)
- ❌ Smoke test NOT run (Matthew was getting test data ready)
- ❌ Not committed to git
- ❌ Not tagged
- ❌ Not pushed to GitHub
- ❌ Not published as a release

**The 5-step smoke test plan you should walk Matthew through when ready:**

1. **Run guard test:** Click Run, confirm dialog. While dialog is open, click Run again. Expected: friendly "An automation is already running" alert, no second dialog.
2. **Heartbeat test:** Click Run → confirm. Status under "Run progress" should change to "Logging in…" within 5 seconds (proves heartbeat events flow through).
3. **Live counters test:** Once rows process, watch all 8 stat boxes (Done, Success, Errors, Skipped, Rows/Min, Est. Left, Complete %, Elapsed). Elapsed should tick every second. Done/Success update per row.
4. **Excel log test:** Once the run finishes (or after Stop), check `%APPDATA%\better-update-utility\logs\` for `BUU-log-2026-MM-DD-*.xlsx`. Summary sheet should exist even if 0 rows processed.
5. **Resume test:** Mid-run, click Stop. Fully quit BUU. Relaunch. Expected: Resume modal appears. Click Resume — picks up from checkpoint.

**The "loud-fail" check you should also confirm:** When Matthew clicks Run for the first time after launch, if any preload bridging is broken, an alert pops up. If that alert fires, STOP the smoke test and diagnose — that's a deeper bug than the 5 steps test for.

**After smoke passes:**
```powershell
cd "C:\Users\bigma\OneDrive\Desktop\Better Update Utility"
git add .
git commit -m "v1.2.3 - Icon, run guards, heartbeat, live counters, resume-on-launch, log retries"
git tag v1.2.3
git push origin main --tags
& "C:\Program Files\GitHub CLI\gh.exe" release create v1.2.3 `
  "dist\Better Update Utility Setup 1.2.3.exe" `
  --repo EntomoBrandsMR/better-update-utility-release `
  --title "v1.2.3" `
  --notes "<paste from below>"
```

**Suggested release notes for v1.2.3:**
```
Bug fixes and reliability improvements:
- Fixed icon: BUU logo now displays correctly on title bar, taskbar, Start menu, desktop shortcut, and Setup installer
- Fixed phantom run bug: runner log is now created before any pre-spawn operation, so failed starts always leave a paper trail
- Loud failure on missing API: if the automation backend isn't reachable, the UI now alerts immediately instead of sitting at "Starting..."
- Excel run log now always writes a Summary sheet, even on 0-row runs
- Excel log save now retries on EBUSY (handles OneDrive sync locks)
- Run guard: prevents double-clicking Run from spawning duplicate runners
- Heartbeat: status updates every 5 seconds during slow phases (login, cleanup)
- Elapsed time counter ticks every second during runs
- Resume-on-launch: if BUU crashes mid-run, on next launch you'll be prompted to resume from the last completed row
```

---

## 6. v1.2.4 BACKLOG (KNOWN BUGS NOT YET FIXED)

These were discovered during the v1.2.3 session but deferred:

### 6.1 Run log table doesn't show historical Excel logs
**Symptom:** "Run log" tab in BUU sidebar shows "No log entries yet. Run the automation to populate this log." even though the logs folder has many historical Excel files.
**Cause:** The run-log table view reads from in-memory `logEntries` only, which resets each launch. It doesn't scan/load historical files.
**Fix:** On launch, scan `%APPDATA%\better-update-utility\logs\` for recent BUU-log Excel files and populate a "historical runs" view.

### 6.2 Default error handling probably wrong for production
**Symptom:** Default `errHandle` is `'stop'`. One row error kills the entire run.
**Reasoning:** For a 8,500-row run that runs overnight, "stop on first error" means a transient error at row 47 wastes the whole night.
**Fix:** Default to `'skip'` (continue on error, log to Errors sheet) for production runs, or change UX to make this choice more visible at run-start.

### 6.3 v1.3.0 design doc not yet written
See Section 7. Matthew committed to "ship 1.2.3 first, then write handoff" — handoff is THIS DOCUMENT. v1.3.0 design is still to be drafted.

---

## 7. v1.3.0 DESIGN: LOCKED DECISIONS (FROM SESSION)

Matthew and I went deep on this. **All these decisions are locked.** Don't relitigate them with him unless he opens the door.

### 7.1 The big picture
v1.3.0 transforms BUU from "single-runner manual operation" to "automated multi-queue job system with email pickup eventually." The design is the **foundation for fully unattended automation** — Matthew's stated goal is "no manual piece other than verification."

### 7.2 Concurrency
- **Hard cap: 3 concurrent runners total** (configurable). Not 3 per queue — 3 total.
- Slot 3 is **always reserved for manual runs**. Queues never use slot 3.
- Within slots 1-2, queue priority logic determines who runs.
- 3 dedicated PestPac users planned (for queue isolation, not session-conflict — PestPac allows concurrent sessions per user).

### 7.3 Two queues + manual queue
- **Priority queue** + **Non-priority queue** + **Manual** (3-queue logical model, currently 2 active).
- Within each queue: priority sort (urgent → high → medium → low → unmarked), then size-asc within tier (smaller jobs jump ahead of larger same-priority jobs).
- "Size" = `rows × steps = actions`.

### 7.4 Line-jumping vs. preemption
- **Default: line-jump.** A high-priority job starts the moment a slot opens. Already-running jobs don't get interrupted.
- **Urgent tag overrides:** if a job has `urgent: true` AND no slot is available, the lowest-priority running job is **preempted** — its current row finishes safely, checkpoint saves, browser closes, slot frees, urgent runs, paused job resumes from checkpoint.
- Preemption cost is real (~30-60 sec overhead per preemption). Use sparingly.

### 7.5 Job submission: hybrid flow embedding
- **Files arrive in `jobs/unstarted/<date>_<flow>_<file>/`** as job folders, not loose files.
- **Each job folder has** `workbook.xlsx` + `job.json` + `flow.json` (snapshot of flow at submission time).
- **Metadata in spreadsheet header rows (vertical A:B layout):**
  ```
  A1: priority    B1: high
  A2: flow        B2: invoiceDivision
  A3: profile     B3: overflow
  A4: urgent      B4: no
  A5: flow_def    B5: { full flow JSON if needed }     ← OPTIONAL
  A6: (blank — separator)
  A7: <data column headers>
  ```
- **Hybrid:** if `flow_def` (B5) is present, use it. Otherwise look up `flow` (B2) in BUU's local flow library. PestPac reports just put `flow:invoiceDivision` and BUU resolves; portable archived files include `flow_def` for self-contained replay.
- **Pre-flight validation:** all metadata required fields validated at submission, NOT at runtime. Jobs that fail validation move to `jobs/failed/needs-review/<reason>/` with a `failure.json`.

### 7.6 Folder lifecycle (jobs ARE the persistence)
```
jobs/unstarted/   ← dropped here by user / email pickup / web form
jobs/queued/      ← BUU saw it, validated, queued
jobs/running/     ← runner is processing (checkpoint.json appears here)
jobs/done/        ← completed (log.xlsx appears here)
jobs/failed/      ← errored beyond retry
  ├ missing-flow/
  ├ missing-priority/
  ├ flow-not-found/
  ├ bad-format/
  └ runtime-error/
```

No separate `queues.json` — the folders themselves persist queue state across restarts. Crash recovery: any folder in `running/` without an active runner = orphan, prompt to resume.

### 7.7 Resume capability
- Already shipped in v1.2.3 for single runs.
- v1.3.0 extends to multi-runner: scan all checkpoint files on launch, prompt for each.
- Resume from row `checkpoint.rowIndex` with `resumeFromRow: rowIndex` in the spawn args.

### 7.8 Email pickup (deferred to v1.4.0)
- BUU watches an inbox.
- Email subject carries metadata: `[BUU] flow=invoiceDivision priority=high urgent=yes`.
- Attachment is the spreadsheet, downloaded into `jobs/unstarted/`.
- **NOT implemented in v1.3.0.** Folder watcher in v1.3.0 just watches `unstarted/` — manual drop or any other mechanism that drops files there will work.
- Transport (IMAP / Outlook rule / Power Automate) — TBD by Matthew.

### 7.9 Failure handling
- Pre-flight validation rejects malformed jobs to `failed/<reason>/`.
- Runtime errors send the job to `failed/runtime-error/` after retry exhaustion.
- Auto-rejection emails sent to **a single 'BUU admin' address** (Matthew or his designate), regardless of original sender.
- Email content is mechanical: file name, reason, missing fields, "fix and resubmit."

### 7.10 What I would NOT do unprompted in v1.3.0
- Don't add new submission methods (web form, etc.) — Matthew specifically wants folder-based first, then email later.
- Don't widen the metadata format. Vertical A:B is locked.
- Don't change concurrency cap from 3.
- Don't auto-resolve missing profile on resume — show a profile picker dropdown (already done in v1.2.3).
- Don't try to embed flow definitions automatically. The hybrid model is correct as-is.

---

## 8. AN ACTIVE DATA-RECONCILIATION JOB IN FLIGHT

This is **NOT BUU work** — it's a separate data analysis job Matthew is doing for his actual day job (cleaning up an upload mess in PestPac for the Duncan division).

### 8.1 Context
Duncan division had ~480k invoices uploaded to PestPac in late 2025 / early 2026. Some unknown subset of those imports got their dates **transposed** (MM/DD swapped to DD/MM). Matthew needs to find which ones to fix.

### 8.2 Files (in `upcoming/`)
- `Duncan Template_Service_History2025.xlsx` — the upload-source file (~480k rows, **dates are correct**, 32 columns including `PestPacLocationCode`, `PestPacBilltoCode`, `Invoice_ServiceCode`, `InvoiceLineItem_UnitPrice`, `Invoice_Tech1Username`, `Invoice_InvoiceDate`, `Invoice_WorkDate`, etc.)
- `Duncan Invoice Date Reversal .xlsx` — PestPac export of invoices uploaded on 12/31/25 (~477k rows, **dates may be wrong**, 11 columns including URL with embedded `InvoiceID`, `Location Code`, `Bill-to Code`, `Service Code`, `Invoice Date`, `Work Date`, `Duration`, `Tech`, `Unit Price`)
- `Duncan Invoice Date Reversal 2.xlsx` — PestPac export of invoices uploaded BEFORE 2/2/26 EXCLUDING 12/31/25 (~2,875 rows, same 11 cols, **dates may also be wrong**)

### 8.3 Reconciliation script (NOT a BUU file)
Located at `scripts/_reconcile-invoices.js`. **This is a one-off helper, prefix `_` indicates it's not part of the build.** It's been iterated through several versions in this session.

**Current algorithm:**
1. Load upload file (streaming via exceljs) → build map keyed by `Loc|BillTo|Service|UnitPrice|Tech` (broad key)
2. Load both PestPac files (treat as one merged dataset) → build map by same broad key
3. **Resolve pass:** for each broad-key group with both upload and PP entries, bucket by Invoice Date. Same-date buckets pair up and silently disappear (these are "matched, no problem"). Unpaired remainders get flip-paired (MM↔DD swap of date), then closest-date paired. Confirmed pairs go into `Date Mismatches` sheet with method=flip or method=closest. Anything still unpaired goes to `Ambiguous`.
4. **Loose-match pass:** after resolve, scan remaining `Missing in PestPac` + `Missing in Upload` + `Ambiguous` rows. Group by **just** `Loc|BillTo|Service` (no price/tech/date). Within each loose-key group, score upload×PP candidate pairs by how many of (Price, Tech, InvoiceDate, WorkDate, Duration) match exactly. Greedy pick highest-score pair, repeat. Output paired rows to `Loose Matches - Date Anomaly` sheet, side-by-side, sorted by score desc.
5. Write multi-sheet output workbook to `upcoming/RECONCILIATION_RESULTS.xlsx`.

**Last run results (v3 with loose-pass):**
- Date Mismatches: 232,032 (paired confirmed)
- Missing in PestPac: 4,021
- Missing in Upload: 2,985
- Ambiguous: 1,348
- Loose Matches: **0** ← suspicious; may be correct (disjoint pools) or may be a bug
- Total run time: ~35 seconds for resolution + write fail (file was open in Excel, EBUSY)

**Where we paused:**
- Output write failed with EBUSY because Matthew had the previous results file open in Excel
- Loose Matches = 0 needs verification: is it that the residual UPLOAD pool and PP pool truly have disjoint `Loc|BillTo|Service` combinations (which would mean no rescue is possible — supports Matthew's hypothesis "we shouldn't have anything missing from PestPac")? Or is there a bug in the ambiguous-row reconstruction that's preventing matching?
- Diagnostic re-run was queued but Matthew paused to do this handoff first.

**Next steps for the new Claude on this job:**
1. Have Matthew close `RECONCILIATION_RESULTS.xlsx` if it's still open in Excel
2. Re-run the script as-is to see if the loose-match 0 result reproduces
3. If 0 reproduces, add a one-time diagnostic that prints: count of loose-key groups with both-sides entries, sample 10 such groups with their contents — then decide if the result is real or buggy
4. If diagnostic shows the result IS real, add a "Diagnostics" sheet to the output with distribution of Missing-in-PestPac by date/service/location, distribution of Missing-in-Upload by source file, etc. (Matthew specifically asked for correlation analysis)

### 8.4 Important context about Matthew's reconciliation hypothesis
He said: *"i know for a fact anything in the pestpac report file with the date of 5/1/26 should actualy be 1/5/26."*

That's MM/DD → DD/MM swap. The script's `flipDate` function handles this. But Matthew said *"obviously confirm that"* — meaning he's not 100% sure the swap pattern is universal. **DO NOT report flip-paired counts as authoritative without sampling some and confirming the pattern visually with him.**

---

## 9. TOOL ENVIRONMENT YOU NEED TO KNOW

### 9.1 Filesystem access
- You have read/write access to Matthew's machine via filesystem tools (Filesystem and desktop-commander MCP servers)
- `desktop-commander:read_file` chokes on Excel files >10 MB — for large xlsx, use Node + exceljs
- For BUU source edits, use `desktop-commander:edit_block` with surrounding context for uniqueness
- After every `edit_block`, `view` the file again before further edits — your context is stale otherwise

### 9.2 Build environment
- Node 24.15.0
- electron-builder 24.13.3 (cache at `%LOCALAPPDATA%\electron-builder\Cache\`)
- npm scripts: `npm run build` (runs electron-builder), `npm start` (electron .)
- Build cache and project folder are in Defender exclusion list (added during v1.2.3 session to fix Smart App Control blocks)
- `cmd.exe /c` wrapper required for npm commands in PowerShell because of execution policy restrictions

### 9.3 GitHub setup
- **Repo:** `EntomoBrandsMR/better-update-utility-release` (private)
- **gh CLI authenticated as:** `EntomoBrandsMR` (`gho_*` token in Windows credential keyring)
- Path: `C:\Program Files\GitHub CLI\gh.exe`
- **Verified working** — last release published was v1.2.2 on 2026-04-28

### 9.4 Useful commands
```powershell
# Verify gh auth
& "C:\Program Files\GitHub CLI\gh.exe" auth status

# Check installed BUU version
$exe = "C:\Users\bigma\AppData\Local\Programs\Better Update Utility\Better Update Utility.exe"
(Get-Item $exe).VersionInfo | Select-Object ProductVersion, FileVersion

# Find runner logs
Get-ChildItem "$env:APPDATA\better-update-utility\logs\" | Sort LastWriteTime -Descending | Select -First 5

# Check checkpoint orphans
Get-ChildItem "$env:APPDATA\better-update-utility\checkpoint-*.json"
```

### 9.5 Memory tool
This conversation is using a memory system. I have NOT preserved this session's most recent notes there — Matthew explicitly said the transfer is happening to a work account, so trying to chain memory across accounts is pointless. **The new Claude should treat its memory as empty for this project until told otherwise.** This document is the source of truth.

---

## 10. MISTAKES I MADE IN THIS SESSION (READ THIS, LEARN FROM IT)

I'm including this in full because Matthew specifically asked for candor. The new Claude should not repeat these:

### 10.1 The icon rabbit hole
I spent ~2 hours trying to fix the icon by post-processing the .exe with rcedit. **The actual problem was the source `.ico` file was malformed** — every tool that looked at it produced different results. I should have visually inspected the source icon FIRST. Once I regenerated it from scratch using sharp + png-to-ico, the problem evaporated. Lesson: **when diagnostic tools disagree about a file, the file is the problem, not the tools.**

### 10.2 I lost track of Matthew's bug list
Matthew's first message in the live debugging part of the session listed THREE bugs: icon, run log/progress not updating, and stop button. I addressed #1 and #3 in the first round but lost track of "log/run progress doesn't work" — the most important of the three — for several turns. I treated it as something Diff 5 (live counters) would fix, but the real bug was deeper: the runner wasn't even completing successfully because of the broken downloader. Lesson: **when a user lists bugs, write them down explicitly and check each one off. Don't pattern-match a fix to the wrong bug.**

### 10.3 I almost shipped force-icon.js without testing it
When I wrote `scripts/force-icon.js`, I ran it on both the unpacked .exe AND the NSIS installer .exe. **NSIS installers have a different binary structure that rcedit corrupts.** The first build I tested produced a 0.39 MB Setup.exe (corrupted from 229 MB). Caught it before shipping but barely. Lesson: **if a tool was designed for one kind of binary, don't assume it works on another. Test on each target separately.**

### 10.4 I theorized when I should have measured
After the icon "succeeded" by my flawed diagnostic tools, I said "icon is now real artwork" with confidence based on byte-size heuristics that were lying to me. The right answer was **install it and look** — which Matthew suggested AND I should have proposed earlier. Lesson: **when downstream verification is cheap (just install and look), do that BEFORE trusting upstream diagnostics.**

### 10.5 I theorized about the 8,500-row run mystery
I floated a theory that `API.startAutomation` was undefined at runtime, based on incomplete data. Matthew later told me the run had actually completed correctly — there was no missed data. **My theory was wrong and I led him to question his own work.** Lesson: **when symptoms don't fully add up, say "I don't know" instead of constructing a hypothesis. False explanations are worse than no explanation.**

### 10.6 The reconciliation script's first version OOM'd silently
First version used the synchronous `xlsx` library and ran for 27 minutes before failing. I should have known from the file sizes (18 MB compressed each, expanding to ~2 GB in memory) that streaming was required from the start. I added progress output only on the second iteration. Lesson: **always add progress output to long-running scripts upfront. And know your library's memory model before deploying it on a 480k-row file.**

### 10.7 I once added a tool to the build pipeline that conflicted with Smart App Control
Same `force-icon.js`. By modifying the .exe AFTER electron-builder had set integrity hashes, I created a hash mismatch that triggered Smart App Control to refuse install. Cost: another full rebuild after Matthew added a Defender exclusion. Lesson: **post-build modification of signed binaries is a red flag. Either fix it in the source pipeline or accept the fix you're about to make is fragile.**

---

## 11. SUGGESTED FIRST MESSAGE TO MATTHEW

When the new Claude account starts, this is what I'd suggest as the opening:

> Hey Matthew — I have your handoff document loaded. I see we're at this point:
>
> - **v1.2.3 is built and installed locally** but smoke test wasn't run yet, so it hasn't shipped to GitHub
> - **An invoice reconciliation job is in flight** — last run produced 232,032 date mismatches with 0 loose matches, write failed because the results file was open in Excel
> - **v1.3.0 design is locked** — queues, file lifecycle, hybrid flow embedding, etc. — but no code written yet
>
> Where do you want to start? Options I see:
>
> 1. **Re-run the reconciliation** (close the open Excel file first, see if 0 loose matches reproduces or if a bug shows up)
> 2. **Run the v1.2.3 smoke test** and ship it to GitHub
> 3. **Start writing v1.3.0** code
> 4. **Something else** — what's on your mind?

---

## 12. FILES TO VERIFY EXIST AFTER HANDOFF

Once the new Claude account starts, please confirm these files exist on Matthew's machine. If any are missing, ask Matthew immediately — they may have been lost or moved during the transfer.

```
C:\Users\bigma\OneDrive\Desktop\Better Update Utility\
├── BUU-PROJECT-HANDOFF.md            ← THIS FILE
├── package.json                       ← version should read "1.2.3"
├── version.json                       ← should reference 1.2.3 with v1.2.3 download URL
├── src\main.js                        ← should contain 'CURRENT_VERSION = '1.2.3'' on line ~10
├── src\preload.js                     ← should expose findOrphanCheckpoints, loadCheckpoint, discardCheckpoint
├── src\index.html                     ← should contain 'resumeOverlay' div, 'showResumePrompt' function, 'rs-elapsed' element
├── assets\icon.ico                    ← 372 KB, multi-size, the regenerated one
├── assets\icon-old.ico.bak            ← 361 KB, the broken original (kept for reference)
├── scripts\_reconcile-invoices.js     ← in-flight reconciliation tool (remove or rename when no longer needed)
├── upcoming\Duncan Invoice Date Reversal .xlsx
├── upcoming\Duncan Invoice Date Reversal 2.xlsx
├── upcoming\Duncan Template_Service_History2025.xlsx
└── dist\Better Update Utility Setup 1.2.3.exe   ← 207 MB

Should NOT exist:
├── scripts\force-icon.js              ← deleted, do not re-add
├── scripts\regenerate-icon.js         ← deleted (one-shot, no longer needed)

Defender exclusions (must be in place):
├── C:\Users\bigma\OneDrive\Desktop\Better Update Utility (project folder)
└── C:\Users\bigma\AppData\Local\electron-builder (build cache)
```

---

## 13. END OF HANDOFF

This document is meant to be comprehensive but not exhaustive. If something comes up that's not covered here, ask Matthew directly — he is patient with clarification questions and prefers them to wrong assumptions.

The most important thing you can do as the new Claude is **earn his trust quickly** by:
- Reading this document carefully before acting
- Using `ask_user_input_v0` for sign-off on anything non-trivial
- Pushing back when you disagree (he expects this)
- Being honest when you don't know something

Good luck.

— Outgoing Claude (2026-04-30)
