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
**Phase 2 COMPLETE (refactor + teardown), commits f3cbe05..ce72031, all pushed, app
boots after every commit.** Teardown final tally: Run Log tab, unused step types,
verify-after-action, circuit breaker, batching→one-row (requeue kept as crash safety),
skip→ok|error, No-URL alert, single-runner remnants (checkpoint/orphan UI, v1.3.4
parallel-runner block, preload stubs). Deferred by design: If-click + Handle Dialog
(die with R2/R3), old logout dance (dies with Phase 3 logout), the v2.2.2 preload SHIM
+ automation-event dispatcher + updateRunStats (LIVE — the simple Start button routes
through them; they die in R11 when the renderer consumes pool events directly).
Worker cfg markers: 15. Validators mandatory; equivalence prover retired.
**GATE before Phase 3:** SKIPPED by Matthew's call (2026-07-13) — Phase 2 + Phase 3 ride
unverified until his thorough end test.
**PHASE 3 COMPLETE (commits 29bada7..f574e83, pushed, boots after every commit):**
new one-URL logout (5s budget, per-URL attempt log, amber/red card badges + leak summary);
reauth per spec (timer = logout-then-login refresh; failure recovery detects login screen
on row error, re-logins, retries once — the 3,557-row fail-through fix); Stop abandons
the row at the next step boundary + 10s fuse + prompt logout sweep; D1 before-quit worker
kill + second-instance update check; D3 status throttle 4/s; D4 elastic timer starts at
Release; crash safety (worker spill files on coordinator death, pidfile sweep + spill
merge at launch). PARKED: D5 needs Matthew's step-debugger pass over the add-note flow
to name the trigger step (R3 makes handling deliberate regardless); D6 rides R11.
**NEXT: PHASE 4 REBUILD** per the locked R-order. DONE: R1 journal rework (7efc1cc, offline
unit test scripts/_test-r1-journal.js), R2 unified Click (5db7343; legacy waitFor honored,
If-click migrated at load + engine alias backstop), R3 dialog checkboxes (068de03),
R4 adaptive scaling (bd52b4e; one eval timer composes license+pressure+manual;
sequential ramp; live sliders; NOTE: on pool-RESUME the eval timer only starts when
elastic was on — align to always-on at the R14 pool-settings pass), R5 step debugger
(bfa7b70 core + 9c04daf live-reload/Tier-1; cursor cmds redo/last/skip/restart, sticky
pane w/ elapsed ticker, flow-update at pauses, fresh disk read at launch; fixed R2's
loadFlow-scoped migrateLoadedSteps), R6 tokens (3601de4; TODAY live / RUNDATE frozen
at pool start, +/-N days, MM/DD/YYYY, system-wins + collision warning, green chips,
9-case offline check), R7 pressAfter (ff6e2c6), R8 C:\BUU install layout (7468ce7;
build verified, macros compiled; BEHAVIORAL upgrade-preserve test PENDING on the
laptop/VM - do NOT run the unreleased installer on CORP-5QD5QJ4, it would hijack the
live 2.2.9 install; test = install old build, add a flow, install new build, flow
survives), R9 flow folders (6a7d2ab; packaged-only migration after a dev boot briefly
sorted the live flat flows - restored, all 22 verified; dev reads keep flat fallbacks),
R10 flow-name UX (dirty tracking + Save/Don't Save/Cancel on switch and close),
R11 shim death + sidebar (602f234 + 493acc2; renderer consumes pool events directly,
[cont] R12 error strip (e3ed3c6), R13 reorder buttons + locked-neighbor guard (c198294),
R14 pool settings with flow + resume-timer alignment (af5202f), R15 spreadsheet-free
flows (8d1d4fc + 840c517; once-flows run directly, __none__ sentinel, column tokens
block launch), R16 scheduler (eb5a129; zone-computed fire times w/ 11/11 unit test,
reserved blocks + overlap refusal, missed-at-boot popup, schedules panel).

REBUILD COMPLETE: R1-R16 all landed. Rides unverified until Matthew's end test.
PENDING ON MATTHEW: (1) R8 upgrade-preserve install test on laptop/VM - NEVER on
CORP-5QD5QJ4; (2) full end test covering Phases 2-4 (golden gate was skipped by his
call); (3) D5 trigger-step hunt (add-note flow); (4) D6 Add-Profile-vs-overlay retest.
NO version bump / release yet - ship sequence runs when Matthew says, after tests.,
pool-row-error feed, one start/stop path, index -408 lines, preload -161; D6 z-ladder
documented but repro NOT confirmable in source - re-test Add Profile vs overlays in
the end pass).
**R3 SPEC DEVIATION, flagged:** plan said Handle Dialog folds into the PREVIOUS step, but
the step's real semantics arm the FUTURE dialog (dialog steps sit BEFORE their triggering
clicks — verified in the golden flow). Migration folds FORWARD into the next action step;
dialogMatch is dropped (per-step scoping replaces it). Engine keeps a legacy 'dialog'
backstop case. SHIPPED as v3.0.0 (28533c3, tag v3.0.0; 2.3.0 withdrawn pre-install,
release+tag deleted). version-buu2.json on main -> 3.0.0, BOM-free verified.

SHIPPED v3.0.1 (2cd7283, tag v3.0.1): four field bugs - lost REAUTH_INTERVAL_MS const
(pool 100% dead, endless login loop), forceClosing + FLOW_SUBS else-block scope leaks
(close crash + Save flow inert), Click after-default. Validator now enforces CFG marker
contiguity. Header cluster deleted for real (c8efe5e).

PLANNED 3.0.2 - ONE-TIME CLEANUP (temporary code, REMOVED in 3.0.3):
On packaged launch at C:\BUU, offer (prompt, never silent) two deletions:
(a) the orphaned old install dir - the updater runs the old uninstaller pointed at
C:\BUU because preInit overwrote InstallLocation before uninstallOldVersion reads it
(verified in eb template installUtil.nsh), so the old folder survives. Detect: scan
%LOCALAPPDATA%\Programs for a dir containing 'BUU 2.0.exe' that is NOT
dirname(execPath); require exe-name match before any delete (never a bare
registry-path RMDir).
(b) the duplicated %APPDATA%\buu-2\flows + logs - only offer when the C:\BUU copies
exist and are non-empty; NEVER touch journals/spills/creds/config in userData.
3.0.3 = delete the cleanup code again. Both app-side, both prompted - orphaned files
are the safe failure mode, a misfired delete is the catastrophic one.
Also: 2026-07-10 incident —
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

=============================================================================
3.0.3 — WORKER POOL REBUILD (agreed with Matthew 2026-07-15, data-backed)
=============================================================================
Supersedes R4. The R4 spec line "Manual IS the default (manual wins over auto)"
was MY sentence, not Matthew's, and it was wrong: it made auto incapable of ever
adding a worker, so every line of scaling code could only ever subtract from a
number the user already set. That is why auto "never worked" — it structurally
could not.

WHAT MATTHEW ASKED FOR (verbatim intent):
 - a box to set MAXIMUM  -> hard ceiling, nothing exceeds it, LIVE (lower it below
   the current live count mid-run and workers drain down to it, same as sliders)
 - a box to set STARTING number (new; he notes he had not asked before)
 - TWO sliders with heuristics: one PestPac, one hardware. Range 1-5.
   4 = regular use = 100%. 5 = slight overdrive. DEFAULT 4.
 - Buffer box, Auto-scale checkbox, and everything south of it in the worker pool
   area: KEEP AS IS.
 - Eval every (min): change BACK to a box (it is a slider now).
 - Hardware slider stays even though this machine is not hw-bound: other machines
   (VMs) will be.

THE MODEL — heuristics DECIDE, Max CLAMPS:
   effective target = min( Max,
                           licenseCap,
                           hwCap      * (hwSlider/4),
                           W_optimal  * (ppSlider/4) )
 Max is an override/lid, NOT the target. Do not collapse this back into
 "manual wins" — that is the exact mistake being fixed.

THE METRIC — OVERALL ROWS/MIN, never per-row latency:
 Matthew: "focus on the overall". Throughput T = live workers / median row
 duration. Per-row latency is actively misleading, PROVEN on his 2026-07-15 run:
 4->13 workers took row time 3.4s -> 7.5s (MORE than doubled) while throughput
 went 1.15 -> 1.55 rows/sec (35% BETTER). A "time doubled = bad" rule backs off
 at 13, which was a good place to be.
 Rule that captures both his cases in one formula: doubling row time only pays if
 you MORE than double workers.
   - his 4->7 @2x time: 34 -> 30 rows/min = WORSE (he was right)
   - real 4->13 @2.2x time: better

MEASURED ON THE REAL RUN (pool1784152504826, 4027 OK rows) — throughput by live
worker count. THIS IS THE EVIDENCE, not opinion:
   live   med row   rows/sec   per-worker
      1     7.1s      0.19       0.194
      4     3.4s      1.15       0.288   <- best efficiency per worker
      9     5.3s      1.61       0.179   <- PEAK OVERALL THROUGHPUT
     13     7.5s      1.55       0.119
     23     9.7s      1.12       0.049
     27     9.3s      1.35       0.050   <- WORSE than 9, at 3x the licenses
 => W_optimal was ~9. 27 workers did LESS work than 9 while burning 3x licenses
    and 3x logins. Matthew predicted exactly this.

WHY IT COLLAPSED TO 1 (three compounding faults, all mine):
 1. THRESHOLD INSIDE THE NOISE. Consecutive 30-row medians naturally swing:
    p50 1.01, p90 1.11, p95 1.15, MAX 1.46. The code drops at 1.4 — BELOW the
    observed noise maximum. It fires on nothing.
 2. DROP COMPOUNDS WITH NO FLOOR. floor(workers*0.8) repeatedly:
    13->10->8->6->4->3->2->1. Recovery is +1 per eval (2 min) => 1->13 takes 24
    MINUTES. One false positive costs half an hour.
 3. BASELINE IS MEANINGLESS. baseline = median of first 50 OK rows, captured at
    1 WORKER on whatever accounts happened to be first. Evidence: 1 worker at
    5:55 = 7.1s/row; 1 worker at 6:10 = 3.1s/row. Same worker count, 2.3x apart —
    pure account variance. The ratio measured row complexity, not load.
 FIXES: rolling re-based baseline (never frozen at first-50, never captured at a
 different worker count); step DOWN to last-known-good W, never blind 20%
 compounding; sample = 50 rows or 60s whichever is larger (30 rows at 13 workers
 is only 19s — too twitchy).

CONTAINMENT BUG (this is how 4 became 29 — Matthew watched it, I twice said it
was impossible, he was right both times):
 coordEvalScale/coordScaleTo are ASYNC and RE-ENTRANT with NO GUARD anywhere.
 coordScaleTo reads `const live = COORD.workers.size` ONCE at entry, then sits in
 an await loop up to 90s PER WORKER (sequential ramp). Meanwhile FIVE callers can
 re-enter it: the eval timer (main.js 728/804/842/974) and EVERY slider move
 (main.js 844, via pool-set-scaling). Each concurrent call computes canSpawn from
 an already-stale `live` and spawns independently. They compound. Ceiling is 150,
 so nothing stops 29.
 FIX: a single in-flight mutex on the eval/scale path; re-read live count after
 every await; re-assert the clamp before every spawn.

LICENSE — NON-NEGOTIABLE, ALWAYS ON:
 Today: `licenseProfileId: elastic ? activeProfileId : null`. Untick Auto-scale
 and licenseProfileId is null -> elasticParams null -> COORD.licenseCap = Infinity
 -> NO license counting and the buffer is IGNORED ENTIRELY. Matthew has been clear
 since the beginning that knowing seats in use and respecting the buffer is a hard
 requirement. It is a SAFETY CONSTRAINT, not a feature of a checkbox.
 FIX: license cap runs unconditionally, with its own profile picker. Never gated.

CHURN — DO NOT "FIX" IT (I proposed holding workers logged-in-but-idle; Matthew
 stopped me and he was right): idle workers still HOLD PESTPAC LICENSES while
 doing nothing, which directly violates the buffer rule. Killing on scale-down is
 CORRECT — exiting frees the seat. The login cost is the right price. This idea is
 dead, not deferred.

ALSO IN 3.0.3:
 - JOURNAL NEEDS A WORKER ID. Schema is {j,r,s,ms,ts} — no worker field, so the
   journal cannot answer "which worker did this row". R1 made the journal more
   reliable and LESS informative. Add `w`.
 - Worker grid: live workers only.
 - _hwCapCache only refreshes when a slider moves, never during a run => stale =>
   amber lies (slider 4 showed amber while the real cap was 21).
 - Reset Defaults button (in the R4 doc, never built — no excuse).
 - Buffer as a slider (R4 doc said ALL settings are sliders, never built).
 - Selector timeout is NOT a usable row ceiling: it is PER-SELECTOR, not per-row.
   p99 row = 18s, max = 621s (10.4 min) because a row with 10 steps can spend 30s
   on each. "% of the available 30s" has no fixed denominator.

-----------------------------------------------------------------------------
3.0.3 WORKER POOL — refinements (Matthew, same session)
-----------------------------------------------------------------------------
1. CLIMB CADENCE = THE EXISTING EVAL INTERVAL. No second timer. Whatever the
   "Eval every (min)" box says IS the recalculation cadence — set it to 2 and the
   throughput climb re-evaluates every 2 min. (Matthew: "i would set the time to
   whatever the auto time check is first of so if its at 2 then it recalculates
   at 2".) This also self-documents: one visible number controls how twitchy the
   whole system is.

2. START BOX = 9 BY DEFAULT, AND IT IS **NOT A FLOOR**. It sets the INITIAL worker
   count only. The heuristics may take the pool BELOW it — explicitly allowed.
   (Matthew: "do not have it be a clam so the run can go under that".)
   So Start is a seed, Max is a lid, heuristics own everything in between:
       initial W  = Start
       ongoing W  = min( Max, licenseCap, hwCap*(hw/4), W_optimal*(pp/4) )
                    ... and this may be < Start. That is correct, not a bug.

3. LAST-GOOD W AUTO-SAVES TO THE FLOW — AND NOTHING ELSE RIDES ALONG.
   (Matthew: "i think the last good should jus save by default to the flow, not
   saving anything else in the porcess just taht number".)
   Implementation constraints, because this writes to disk with no user action:
     - Write ONLY the lastGoodWorkers field. Read the flow JSON from disk, set the
       one key, write back. NEVER rewrite the whole poolSettings block — that would
       silently capture whatever the sliders happen to be at right now.
     - MUST NOT mark the flow dirty (that is what fires the unsaved-changes prompt,
       and a background write must never make the user think they have edits).
     - MUST NOT touch renderer in-memory flow state (no clobbering live edits).
     - Flow not saved to disk yet => skip silently, no error.
   WHERE IT LIVES: inside the flow's OWN .json, as one extra top-level key
   ("lastGoodWorkers": 6). NOT a master file, NOT one global value. Each flow carries
   its own number because each flow does different work - one may settle at 6 while a
   heavier flow settles at 3; a single shared value would be wrong for both.
   OWNERSHIP RULE (Matthew, decided): lastGoodWorkers is the ONLY field that uses the
   special background write, and it saves NO OTHER WAY. Everything else saves ONLY via
   the normal user-driven Save flow, and never in the background.
   THE TRAP THIS CREATES: saveFlow() rebuilds the entire JSON from renderer memory. Run
   a flow (pool writes lastGoodWorkers:6) -> edit a step -> Save flow -> the rebuilt
   file has no lastGoodWorkers and the number is SILENTLY DELETED.
   THEREFORE: the renderer NEVER carries lastGoodWorkers in its flow object (it cannot
   clobber what it never holds), and main's save-flow handler PRESERVES the existing
   value when rewriting - read the file being overwritten, carry the key across. Same
   handler already rewrites 
ame from the chosen filename, so there is precedent for
   surgical fixups there. Save-As to a NEW filename finds no existing file and
   correctly starts with no history.
   ON FLOW LOAD (Matthew, decided): lastGoodWorkers REPLACES the 9 in the Start box.
   9 is only the default for a brand-new flow with no history. "that flow knows whats
   best for it".
   RATIONALE (measured): throughput at a fixed 13 workers naturally wobbles
   1.32-1.63 rows/sec (+/-10%), so a single 60s sample cannot tell "8 beats 9" from
   luck. Honest climb rate is ~1 step per eval tick => 1->9 would waste ~20 minutes
   of every run. Seeding from last-good removes that cost entirely.


=============================================================================
NEXT SESSION — START HERE (handoff, 2026-07-16, post-3.0.3 SHIP)
=============================================================================
BRANCH: v3.0.2 (branch AND tag share the name — ALWAYS push with the explicit
ref: `git push origin refs/heads/v3.0.2`). Tree clean, everything pushed.
SHIPPED: 3.0.0, 3.0.1, 3.0.2, 3.0.3 (2026-07-16). Update channel VERIFIED:
version-buu2.json on main serves 3.0.3, first byte 123 (BOM-free), release
asset BUU-2.0-Setup-3.0.3.exe. Matthew has NOT yet updated his installed app.

WHAT WENT INTO 3.0.3 BEYOND THE 07-15 LIST (all Matthew-approved 07-16):
 - lastGoodWorkers: BUILT AND SHIPPED (was "not built"). One-key background
   read-modify-write at run end (coordSaveLastGoodW, fires from coordCheckComplete
   for natural completion AND stop); save-flow handler preserves the key on a
   normal Save; load seeds the Start box. Skips: no measurement / unsaved flow /
   multi-flow pool (blended optimum) / unchanged value. Tests:
   scripts/_test-lastgood.js (7 offline) + driven END-TO-END in the booted app.
 - Scheduler license fix: scheduled runs passed licenseProfileId:null and skipped
   seat counting entirely. Now they count against their own s.profileId, buffer 10.
   Test: scripts/_test-scheduler-license.js (drives the real fire()).
 - License profile picker: DROPPED by Matthew — workers log in as the active
   profile and the cap counts that same profile, so a picker adds nothing.
 - Worker grid live-only: DEAD, was a misconception holdout — the grid renders
   the emit verbatim and main deletes workers from COORD.workers on process close,
   so it is live-only by construction (verified renderer-side by execution).
 - Offline license test: replaced by Matthew-approved ONLINE test,
   scripts/_303-license-online.js — runs the real check-license-cap (login ->
   scrape -> VERIFIED logout) via dev CDP. NEVER while a pool is running (it
   consumes a seat). 07-16 run: ok, 16 free seats, suggested 6.
 - Hygiene: 4 bare CRs (CR without LF) removed from src — they made git treat
   files as BINARY (i/-text), which is why main.js diffs showed 1,900 lines for
   any edit. main.js index blob renormalised (EOL-only commit, like 33a49dd did
   for coordinator.js). Gate: scripts/_303-bare-cr-scan.js must say CLEAN.

VERIFIED BY EXECUTION BEFORE SHIP (not by reading):
 - Sidebar end-to-end over CDP (scripts/_303-sidebar-drive.js + _303-live-verify2.js):
   all six controls render; pool-set-scaling round-trip proven by hwEffective echo;
   loadFlow/saveFlow driven through the REAL main handlers with Electron dialog
   stubs injected via --inspect=9230 (window.API is FROZEN — contextBridge — so
   renderer-side API stubbing is a silent no-op; stub dialogs in MAIN instead).
 - Close test x2: $proc.CloseMainWindow() -> clean exit <15s, no dialog, 0 procs.
 - Full suite: containment 7/7, mutation DETECTS, header-ws 13/13, r16-scheduler
   11/11, lastgood 7/7, scheduler-license 6/6, div balance 0, pool worker 16 markers.

OPEN / NOT DONE:
 - Matthew updates his installed app to 3.0.3 and runs a real pool — first real
   validation of the climb + lastGoodWorkers on live data. Watch: does the Start
   box seed from the flow, does the climb settle near 9 on his usual flow, does
   lastGoodWorkers appear in the flow .json after the run.
 - Phase 2 items needing Matthew: golden-flow choice; flow audit for unused step
   types (%APPDATA%\\buu-2\\flows on the MAIN rig); D5 trigger step debugger pass.
 - Buffer-as-slider idea is DEAD (Matthew keeps the box). Churn "fix" is DEAD.

HARD-WON LESSONS (07-16 additions — keep the 07-15 list in git history):
 - window.API is frozen; a renderer-side stub of it fails SILENTLY and your test
   quietly tests nothing (and may pop real native dialogs). Stub in MAIN via
   --inspect + includeCommandLineAPI (gives `require`). process.mainModule is gone.
 - A bare \r is a line terminator to V8 but ONE LINE to every \r?\n tool and
   BINARY to git. Line-joined-looking code may actually run. MEASURE bytes before
   declaring code dead or alive; _303-eol-diag.js / _303-bare-cr-scan.js do this.
 - Inline node -e through PowerShell failed AGAIN this session (quoting). The rule
   stands: write scripts to scripts/, no exceptions, it is always faster.
 - Desktop Commander edit_block can rewrite whole-file EOL as a side effect;
   check git diff --numstat right after editing — a 1,900-line diff for a 3-line
   edit means EOL churn, fix it BEFORE committing.

