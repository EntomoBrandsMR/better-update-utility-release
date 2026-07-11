# BUU TEARDOWN/REBUILD — build plan + pending pool

**Planned 2026-07-10 in a full planning session. This file is the single source of truth
for pending work.** Per-version design docs are retired; version numbers get decided at ship
time. Old docs in docs/design/ are historical reference only.

**Build order (locked): DIAGNOSE → REFACTOR → BUG FIX → REBUILD**
Validation gate between refactor and bug-fix: acceptance test = same real flow produces an
identical journal before/after refactor, plus full validator suite.

---

## PHASE 1 — DIAGNOSE (read-only, root causes written down, no fixes)

- **D1. Lingering BUU processes** (blocks update prompt + builds). Confirm orphan source:
  worker children not killed on quit vs main process not exiting. second-instance handler
  never re-checks updates — verify.
- **D2. Stop-hang: last worker hangs forever on stop, often re-logs-in** (burns license).
  Likely the old logout dance wedging — recheck against new logout design before deep dive.
- **D3. Typing lockup cluster** (user reports widespread: run-settings number inputs flaky,
  step-editor fields stop accepting input). Dig hard. Suspect focus-stealing render loop.
- **D4. Step-through mode spawns extra live workers / burns licenses.**
- **D5. Phantom "Do you want to delete this note?" confirm during add-note flows.**
- **D6. Overlay covers Add Profile modal** (overlays should default display:none).
- **D7. Reauth doesn't work on long runs** (3,557 rows failed through on session drop).
  Same session-state machine as D2.
- **D8. Verify current step-then-Release pool behavior** works as believed (one window,
  walk rows, Release starts full pool) — document exact logic so rebuild preserves it.
- Parked unless tripped over: Frankware license/reauth machinery (KB2).

## PHASE 2 — REFACTOR (runtime unification + teardown)

**New file structure (OOP-style, many small modules, thin main):**
```
src/
  main.js          Electron boot, window, IPC wiring only
  engine/steps.js  unified step handlers (one copy, all hosts)
  engine/login.js  loginToPestPac / logout (new one-URL logout)
  engine/popups.js browser-dialog + HTML-modal handling
  engine/locate.js findLocator / resolveStepLocator
  pool/coordinator.js  queue, journal writer, scaling
  pool/worker.js   thin worker shell (bundled into child template at spawn)
  flows.js         flow load/save/folders/migration
  journal.js       the one journal writer + reader precedence rules
  index.html       renderer (own cleanup pass)
```
Engine files bundle into the worker child-process script at spawn (template approach
survives underneath, authored as real files).

**TEARDOWN LIST (delete entirely):**
- Single-runner remnants (Run Pool is the only run path)
- Circuit breaker + all breaker/dump logic
- "No URL" prompt + its check logic (only that)
- Batching: batch-pull, batch-size UI, reclaim/hand-back, batch-tail tracking,
  dup-row counters — whole family. Workers pull ONE row.
- Handle Dialog step type (auto-migrate: previous step gets autoAcceptDialog=true)
- Run Log tab (never worked; replaced by error strip in rebuild)
- verifyAfterAction — fully gutted (code, UI toggle, journal fields)
- If-click step type (absorbed into unified Click; auto-migrate existing)
- Skip status + all skip logic/counters/UI (statuses become ok|error only)
- Old 4-step logout dance + 150s polling budget (replaced, see Phase 3/rebuild)
- Unused step types — pending flow audit (grep saved flows for types never used)

**KEEPERS (survive teardown, migrate into engine):**
- Diagnostic capture (shipped v2.2.3 — the failures/ toggle w/ per-bucket cap 10)
- Logout sweeper (permanent failsafe; exact-"BUU"-user match rule preserved)
- Step-then-Release pool preview behavior (acceptance check D8)
- findByText mode in resolveStepLocator (audit during refactor, feeds future
  row-by-text Paste HTML feature)

## PHASE 3 — BUG FIX (diagnosed bugs fixed in the new structure, written once)

- **NEW LOGOUT (designed + URL proven live 2026-07-10):**
  1. goto https://app.pestpac.com/default.asp?Mode=Logout
  2. page loads → login page (login.pestpac.com or uid field)? done.
     not login page → goto logout URL again
  3. not verified after 5s total → step 4
  4. flag worker "possible license leak" (red), exit. Sweeper = failsafe.
  Force-kill fuse ~10s (was 180s). Worker logs every URL touched during logout.
  Drain = finish current row (batch=1) then logout — logout-on-drain is an
  acceptance-test item (regressed before: 28-stuck-sessions bug).
- **Coordinator-crash safety:** workers detect IPC disconnect → finish current row →
  append result to own spill file (journal-spill-w<N>.jsonl) → log out → exit.
  Launch recovery merges spill files before offering Resume. Pidfile sweep on launch
  kills any survivors from a dead run (also chips at D1).
- Fixes for D1-D7 as diagnosed, implemented in new modules.
- **Reauth (Matthew's spec, 2026-07-10):** two separate mechanisms —
  (a) TIMER REFRESH: reauth = full logout THEN login at a row boundary, purpose is
      beating PestPac's inactivity auto-logout. Not a check, a refresh.
  (b) FAILURE RECOVERY: on ANY row error, worker checks for the login screen
      (login.pestpac.com URL or uid field); if logged out → re-login → retry the
      row once. This is the fix for the 3,557-row fail-through.
- **Elastic timer gated on step mode:** does not start until Release (D4 fix,
  confirmed by Matthew).
- Logout-attempt surfacing: >2 attempts = amber on worker card; exit without verified
  logout = red "possible license leak" on card + end-of-run summary.

## PHASE 4 — REBUILD (locked features, in rough build order)

**R1. Journal rework.** Coordinator is the ONLY journal writer; workers emit results over
IPC. Append+flush per row (journal always complete to last row; no finalize step).
Every row guaranteed a terminal state (worker death → coordinator writes requeued/abandoned;
silence impossible). Statuses: ok | error only, with rich reason field (timeout,
dialog-blocked, session-dropped, manual, ...). Duplicate rule: append-only, ok-wins,
later lines marked superseded. Column-token matching: trim + case-insensitive.
Popup/dialog encounters logged per row. Spill-file merge on recovery (Phase 3).
Resume prompt names rows that were in-flight at crash (possible double-action; eyes decide).

**R2. Unified Click step.** Absorbs If-click + wait items. Three sections, all defaulted
to current behavior:
- When to act: wait for element appears (default) | wait until enabled;
  per-step wait timeout (kills hardcoded 30s pool wait)
- If not found: error (default) | skip and continue (presence window, default 1s)
- After click: nothing (default) | wait for element | wait for URL change |
  wait for next page load
Migration: existing Click = all defaults; If-click steps auto-migrate; If-click removed.

**R3. Popup/dialog handling on action steps** (Click, Select, Type, Checkbox, Navigate):
- ☐ Auto-accept browser dialog / ☐ Auto-decline (mutually exclusive; listener armed
  before action, handles chained dialogs, harmless on zero dialogs, never blocks)
- ☐ Dismiss alert popup if present (PestPac HTML modals, e.g. Alert note on location
  pages): post-action poll, default 1s (editable), default selector button.modal-alert
  (editable), click if present, never blocks. Encounter logged per row, no text capture.
Handle Dialog step removed w/ auto-migration.

**R4. Adaptive worker scaling.**
- Hardware (comfortable): min(cores × 3, floor(freeRAM_GB × 0.5 / 0.35)); tunable
  multiplier; slider can exceed cap deliberately (amber past cap)
- PestPac pressure: baseline = median row duration of first ~50 OK rows; rolling =
  median last 30; pressure = rolling/baseline. >1.4 sustained 2 checks → drop ~20%;
  <1.15 → slow creep back. Drop fast, recover slow.
- License cap: existing logic unchanged
- One evaluation timer (piggyback license-check interval); changes apply at row end
- Scale-up strictly sequential: one worker spawns → logs in → pulls first row →
  next spawns. Realistic counts 5-15, so no ramp-time concern.
- ALL settings are SLIDERS, live during run, saved with flow (= new defaults);
  Reset Defaults button. Manual IS the default (manual wins over auto).
- Display: effective count + reason, e.g. "12 workers (cap: hardware) · pressure 1.1"

**R5. Step debugger (step mode).** Buttons: Next step · Redo step · Last step (cursor
only, no undo) · Skip step · Restart row · Skip row (row logged error, reason=manual).
PANE IS PERSISTENT (observed on 2.2.9: pane disappears while a step executes and only
reappears when ready for the next click — a stall is invisible): pane stays visible
from step-mode launch until Stop or Release; buttons disable while a step executes;
live status line shows the currently-executing step (n · type · selector) so stalls
are identifiable at a glance.
Live flow reload at every pause boundary (edits apply from cursor forward; flow-shape-
changed-above-cursor warns, pick "continue from step N"). Constraint (KB4): step mode
never scales, never spawns extra logins — one worker, one license until Release.
Tier 1 ships regardless: pool reads saved flow fresh at every launch + "flow last
saved" timestamp on launch screen. NO live reload during full-speed runs.

**R6. Tokens.** {{TODAY}} (live per row, crosses midnight) + {{RUNDATE}} (frozen at run
start). Both accept ±N days: {{TODAY-1}}, {{RUNDATE+30}}. MM/DD/YYYY zero-padded.
Straight day arithmetic. System tokens win over same-named columns; save-time warning
on collision. Distinct chip color. Work everywhere incl. spreadsheet-free flows.

**R7. pressAfter on type steps.** ☐ Press key after typing → dropdown: Tab, Enter,
Escape, ArrowDown, ArrowUp, Space.

**R8. Install + file layout.** Installer default: C:\BUU\ (fixed path; also the
taskbar-pin fix candidate). Desktop shortcut created. Everything BUU lives there:
app, flows\, logs\, failures\. installer.nsh preserves flows\/logs\/failures\ on
upgrade — MUST be built+tested before first update lands on real flows.
Migration on first launch: copy %APPDATA%\buu-2 flows/logs → C:\BUU\.

**R9. Flow folders.** flows\automation\ (☐ Automation flow checkbox on Flow Type card),
flows\once\ (setup+teardown), flows\general\ (default). Pickers filter by folder
(setup/teardown ← once; run picker ← automation+general). Migration sorts existing
flat flows by runMode; nothing auto-flags automation.

**R10. Flow-name UX.** Build page shows active flow name; unsaved/new = "Building".
Unsaved-changes prompt (Save / Don't Save / Cancel) on app close AND flow-switch.

**R11. Sidebar consolidation.** Flow-building + run-launch controls to left sidebar:
flow name, Save Flow, single Run button, pool settings sliders. Worker cards and run
status DO NOT MOVE. Rides on refactor; dead UI deleted in same pass.

**R12. Error strip on run screen.** Last N errors: row · step · one-line reason;
click for detail. Lives near worker cards. (Replaces deleted Run Log tab.)

**R13. Step reorder.** ▲/▼ buttons per step (disabled at ends, same mutation path as
drag). Drag auto-scroll when dragging near list edges.

**R14. Pool settings save with flow** (defaults on pick; launch-screen override per
run without re-saving). Pool defaults: workers 1, auto-scale on, every(min) 2,
diagnostic off. (Batch setting gone; verify setting gone.)

**R15. Spreadsheet-free flows.** New flow mode: no sheet, no row loop, steps run once,
one summary log. TODAY/RUNDATE tokens work; column tokens invalid. THE POINT OF THE
RELEASE together with R16: "run this flow at this time."

**R16. Scheduled runs.** Spreadsheet-free flows ONLY (regular flows not schedulable —
complexity deleted). UI pickers, no cron: once at date+time / daily / weekly (day
checkboxes) / monthly (day N). Each schedule: explicit timezone (default
America/New_York; fire-times computed from that zone regardless of VM clock; dropdown
in editor). Reserved time block per schedule, default 15 min, editable per schedule;
editor refuses overlapping blocks. Persist C:\BUU\schedules\; load on start.
Schedules panel: flow, next fire, last result, enable/disable. Missed while BUU
closed → popup on launch per flow: "Run now / Schedule for later [date+time] /
Dismiss". BUU expected always-open on the VM; no Task Scheduler integration now
(design leaves the door open). No license guard (off-peak by convention).

**R17. Right-click paste everywhere** (Electron context menu).

**R18. Restart** = clean stop (drain) + start (reads saved flow + saved settings).
Absorbed into run lifecycle; no special machinery. Window-per-worker bug dies in
refactor.

**Also folded into engine work:** smarter logout retry + logout-attempt surfacing
(Phase 3); D8 step-then-Release preserved; navigation-interrupted goto-race
(31% of big-run skips) should die with unified retry policy — verify during refactor.

---

## PENDING POOL (later releases, roughly by heat)

- **Verify pass + diagnostic-capture expansion** — joint future design session.
  Verify derives checks from the flow's own write steps (selector+intended value),
  FRESH-NAVIGATE readback only (same-page reads lie), reclassify false errors,
  name the failing field. Hard 20%: PestPac reformats values on save (dates/money).
  Build AFTER this release reduces the false-error population.
- **Row-by-text in Paste HTML** — pasted element in a row context → ask "row text?"
  → generate XPath. Audit existing findByText first (refactor does this free).
  AND/OR/NOT compound text conditions.
- **Per-dialog/popup routing rules** — "if dialog text matches X → accept, else
  decline". UI grows from checkboxes to rules list; schema already compatible.
- **Sequential flow queueing (37)** — "run B after A"; mostly covered by adjacent
  schedule blocks, revisit if a real chain need appears.
- **Per-row total-time timeout (35)** — revisit if post-rebuild runs still show
  100s+ burn rows.
- **Phone notification app** — BUU pushes to a simple mobile app (X failures in a
  row, run complete); respond from phone. Own project.
- **Spreadsheet-upload-with-flow pairing** — upload sheet + flow together; the
  automation/ folder is the contract for this.
- **Windows Task Scheduler wake for schedules** — only if always-open VM stops
  being acceptable.
- **Regular-flow scheduling** — needs heavy discussion; manual for now.
- **Field Catalog** — persistent store of every PestPac field BUU has seen.
- **Parallel multi-flow runs.**
- **PestPac API / hybrid branch** — still blocked on WorkWave OAuth credentials.

## DELETED (decided 2026-07-10, re-add only on new evidence)
- Circuit breaker (replaced by nothing; future = phone notify)
- Batching + reclaim (batch=1 forever)
- Skip status (error + reason field covers it)
- verifyAfterAction (future verify pass replaces the intent)
- If-click "wait until gone" (43)
- Run Log tab; Handle Dialog step; single-runner; "no URL" prompt
- License guard on schedules; run-progress-by-step (already shipped v2.1.0)

---

## HANDOFF — for the next session (written 2026-07-10, end of planning + Phase 1)

**MACHINES (check DC hostname via get_config FIRST THING every session):**
- `CORP-5QD5QJ4` = **MAIN RIG** (Windows user "Matt Ruckman", RAM-upgraded, BUU 2.2.9
  installed, real flows at %APPDATA%\buu-2\flows, repo at
  C:\Users\Matt Ruckman\projects\Better Update Utility). This is where dev + runs happen.
- bigma box (hostname unknown — record when next seen) = older machine, repo at
  C:\Users\bigma\OneDrive\Desktop\Better Update Utility. Status/role: confirm with Matthew.

**NOTIFY MATTHEW'S PHONE on EVERY stop — needing input, blocked, batch done, OR pausing
because the working turn ran long / hit limits (he may be away; the ping is what tells
him to come nudge the session):** POST to ntfy —
`Invoke-RestMethod -Method Post -Uri ("https://ntfy.sh/" + (Get-Content .ntfy-topic)) -Body "<short generic message>" -Headers @{Title="BUU"; Priority="high"}`
(topic in .ntfy-topic at repo root, gitignored; keep message content generic — topic is public-guessable). Fire it as the LAST action of a working turn.

**Who/where:** Matthew, sole dev + user. Machine: main rig CORP-5QD5QJ4 (see table). Repo:
C:\Users\Matt Ruckman\projects\Better Update Utility, branch v2.0.0-elastic, remote
EntomoBrandsMR/better-update-utility-release. Toolchain installed this week: git,
node 24, npm 11, gh (authed). NODE_ENV=production is set machine-wide — ALWAYS
$env:NODE_ENV="" and npm --include=dev. Chromium for extraResources lives at
.\chromium (copied from the installed app). Current shipped: 2.2.9.

**State:** Planning COMPLETE (this file is the locked plan — do not re-litigate decided
items). Phase 1 diagnosis COMPLETE — read docs/DIAGNOSIS-2026-07.md.
**Phase 2 module extraction COMPLETE (2026-07-10, commits f3cbe05..46116f2, pushed):**
engine/login.js, engine/locate.js, engine/steps.js, pool/worker.js (real file + marker
assembly in buildPoolWorker), pool/coordinator.js (wireCoordinator(ctx) at main.js EOF;
mainWindow/keytar read live via ctx getters), journal.js (initJournal({COORD})).
Every extraction: validators green + scripts/_emit-worker-diff.js proves the assembled
worker EQUIVALENT to v2.2.9's emitted template (comments/blanks/export-guards ignored).
Dev boot smoke-tested (electron . loads, window up, no stderr). Golden baseline frozen
in docs/golden/ (READ ITS README — Test.xlsx is DO-NOT-RERUN as-is).
**Phase 2 remaining:** (1) teardown pass — DONE so far (commits fce6b42, d50adf5): Run Log
tab, unused step types (clear/assert/textedit; fw-scrape-orders KEPT, Frankware parked
not dead), verify-after-action fully gutted (cfg markers now 18, renumbered). REMAINING
teardown, do as ONE coordinated batch (they share the worker main loop + coordinator
queue protocol): circuit breaker, batching family (workers pull ONE row), skip status
(ok|error only), "No URL" check (find it first — obvious greps came up empty; likely
lives in the worker row loop or loadRowsForJob), single-runner remnant sweep.
If-click + Handle Dialog ride R2/R3; old logout dance dies with Phase 3's new logout.
NOTE: _emit-worker-diff.js proves equivalence vs v2.2.9 — INTENTIONALLY diverged once
teardown began; don't run it as a gate anymore. Validators remain mandatory.
(2) MATTHEW-RUN checkpoint golden run — never self-run live (see working-style). Test
Flow matchText already flipped BILLING→BALFWD; Matthew fixed Test.xlsx himself.
(3) flow audit DONE (scripts/_audit-step-types.js). Also: 2026-07-10 incident —
drag-fill incremented LocationIDs, golden run deleted real setups at 1263957-66;
Matthew recovering by hand; rows 2/5/10 had renewal + open-order damage.

**Next up: PHASE 2 — the refactor.** First moves, in order:
1. ACCEPTANCE BASELINE before touching anything: run a small real flow on current
   code (Matthew provides flow + sheet; step-then-Release works on this VM once BUU
   is installed or `npm start` from repo), save its pool journal as the golden file.
2. Extract modules per the Phase 2 structure in this file. Suggested extraction
   order (lowest risk first): engine/login.js (login was already dedup'd to
   LOGIN_TO_PESTPAC_SRC — one string constant to move) → engine/locate.js
   (FIND_LOCATOR_FN_SRC + RESOLVE_STEP_LOCATOR_FN_SRC, ~line 1158/1257) →
   engine/steps.js (runStep switch, ~line 2190-2380 inside buildPoolWorker
   template) → pool/worker.js (the template shell) → pool/coordinator.js
   (COORD object + handlers, ~line 60-800 + 1400-1700) → journal.js.
   Mechanism: modules are real .js files; a small bundler step (readFileSync +
   concatenation, same as today's ${FN_SRC} interpolation) builds the worker
   child script. Keep validators green after EVERY extraction:
   node --check src/main.js · node scripts/_check-html-js.js ·
   node scripts/_validate-pool-worker.js (these two were recreated 2026-07-04 and
   are now tracked in git; the validate-pool-worker script extracts the template
   and syntax-checks it — it will need updating when the template becomes
   file-concatenation, keep it working).
3. Teardown items (list above) come out DURING extraction — don't port dead code.
4. Re-run the golden flow; journal must match baseline (minus removed skip/batch
   fields — document any expected diffs before running).
5. Commit per extraction, terse messages. Matthew signs off diff-by-diff on
   anything non-mechanical.

**Then Phase 3 (bug fixes in new structure) and Phase 4 (R1-R18) per this file.**

**Matthew's working style (do not violate):** NEVER self-run anything against live
PestPac — no test runs, no logins, no "quick verification" sessions; Matthew runs all
live tests himself. Validators/provers/static checks only when working alone. Also:
terse; brutal honesty; flag real risks
ONCE then move on; never re-ask decided things; no unattended scope creep; validate
before every ship; commit -F file for messages; write scripts to disk, never inline
node -e / python -c; ship = bump both versions → validators → commit → tag → push →
build → gh release (dash-separated exe name) → version-buu2.json on main BOM-free.

**Open items needing Matthew during Phase 2:** golden-flow choice; flow audit for
unused step types (grep his real flows dir on the MAIN rig — %APPDATA%\buu-2\flows —
this VM has none); D5 trigger step (one step-debugger pass over the add-note flow
once the debugger exists, or on current build).
