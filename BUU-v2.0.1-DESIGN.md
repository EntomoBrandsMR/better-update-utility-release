# BUU v2.0.1 — Backlog & Design Notes

**Status:** Not started. Backlog captured 2026-05-21 during the BUU 2.0 release/test session.
**Predecessor:** v2.0.0 (elastic worker pool — pull-queue coordinator, batch-pulling workers,
license-aware elastic scaling, zero-loss append-only resume journal, multi-flow job staging,
merged pool log, file-upload step). Separate app from BUU Legacy 1.3.5.

---

## STANDING CONTEXT (always true — do not re-ask)

- **Matthew is the only user of BUU right now.** Sole operator, no other install in the field.
  When Matthew says ship, ship all the way (bump, commit, tag, push, AND publish the GitHub
  release). He tests on his own machine after the fact.
- **Two apps now, fully separate:** BUU Legacy (branch v1.3.5-legacy, version.json channel,
  productName "Better Update Utility") and BUU 2.0 (branch v2.0.0-elastic, version-buu2.json
  channel, productName "BUU 2.0", appId com.entomobands.buu-2). Separate userData folders.
  Pushing one branch never affects the other; two separate version files so updaters never
  cross-wire. Legacy flows are copied into 2.0 once on first launch (then independent).
- **Workflow:** diff-by-diff sign-off on non-trivial changes; tests after push, not during the
  session; prefers brutal honesty over softened status. Use desktop-commander edit_block (not
  Filesystem edit_file — EPERM rename locks). Validate: node scripts/_check-html-js.js,
  node --check src/main.js, node --check src/preload.js, node scripts/_validate-runner.js,
  node scripts/_validate-pool-worker.js, node scripts/_test-coordinator.js. PowerShell uses ; not &&.
- **Build:** npm run build on the target branch. Publish via gh release create + update the
  matching version file on main (no BOM — use [System.IO.File]::WriteAllText, NOT Set-Content -Encoding utf8).

---

## v2.0.1 ITEMS

### 1. "Auto" worker-count now accounts for hardware AND licenses  [CODE DONE, NEEDS REBUILD]
The Auto button used to suggest a hardware-only number (e.g. 36) that ignored open PestPac
licenses entirely — dangerous, since each worker consumes one license. Rewrote poolFillAuto()
in src/index.html so it takes the SMALLER of (hardware cap) and (free licenses minus buffer),
scraping the live license page via checkLicenseCap with the active profile. Shows both numbers
in the popup and which one won. Falls back to hardware cap (with a clear note) if no profile is
selected or the license read fails.
- **State:** committed on v2.0.0-elastic, but NOT yet in any built installer. The shipped
  BUU 2.0 Setup 2.0.0.exe still has the old hardware-only Auto. Needs a rebuild + republish to
  reach the installed app.

### 2. Rename the "Elastic" checkbox  [NOT STARTED]
"Elastic" is unclear. It toggles the ongoing license loop (coordLicenseScale): every N minutes
while running, re-scrape licenses and scale workers up/down to free-buffer. Candidate names:
"Auto-scale" (recommended), "Live scaling", "Auto-adjust". PICK ONE — Matthew had not chosen at
capture time. Element id is poolElastic in src/index.html (toolbar ~line 708-719).

### 3. Reorder + label the pool toolbar inputs  [NOT STARTED]
Current order: Workers | Batch | [x] Elastic | [10] | [5] | Auto | +Job | Run pool.
The [10] and [5] boxes are UNLABELED — they are poolLicBuffer (keep N licenses free) and
poolLicInterval (recheck every N minutes). They float AFTER Elastic with no label, looking like
orphan mystery boxes. Fix:
- Group buffer + interval visually WITH the thing that uses them.
- Label them ("Buffer", "Recheck (min)").
- Nuance: BUFFER is used by BOTH the new Auto (item 1) and Elastic, so it is not purely an
  Elastic setting — it means "licenses to always keep free." INTERVAL is Elastic-only.
  Cleanest grouping: buffer sits with Auto/license controls (always enabled); interval sits with
  Elastic and greys out when Elastic is off.

### 4. Grey out / disable Elastic-only inputs when Elastic is off  [NOT STARTED]
The interval (and arguably buffer) do nothing when Elastic is unchecked. Disable/grey them when
the checkbox is off so the UI reflects what is actually active.

---

## NOT IN SCOPE / STILL UNTESTED (carried from v2.0.0)
- **BUU 2.0 has not been proven against real PestPac.** All code parses + 29/29 coordinator
  logic tests pass, but concurrent same-credential login, live batch timing, and elastic scale
  events have never run live. First real test: 2 workers on a ~30-row sheet, then ramp.
  Worker logs: %APPDATA%\BUU 2.0\logs\buu2-worker-*.log.
- v1.3.4 backlog items A-K (multi-condition match, container paste-HTML extraction, visible-sheet
  load, drag-reorder, validation messages, pause-panel persistence, relax no-URL error, context
  menu audit) remain unaddressed — were deprioritized for the 2.0 concurrency work.