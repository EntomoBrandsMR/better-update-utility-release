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


=============================================================================
3.0.4 BACKLOG (logged 2026-07-16, from Matthew, right after updating to 3.0.3)
=============================================================================
STANDING NOTE (not a bug — Matthew asked to be corrected on this): the install
  root C:\BUU is DECIDED, R8 behavior (build/installer.nsh: fixed root so
  taskbar pins survive updates; app + flows\ + logs\ + failures\ in one place).
  Matthew reported it as a bug on 2026-07-16, then confirmed: "i forgot we made
  that decision and it is exactly where it should be... correct me if i bring
  this up again because chances are i will." => If he asks where BUU installed
  or why it is not on the Desktop: answer C:\BUU, cite R8, do not log a bug.
  (Do NOT move install to Desktop regardless — his Desktop is OneDrive-synced.)
  Still open from that investigation: stale orphaned 2.2.9 install at
  %LOCALAPPDATA%\Programs\BUU 2.0 (7/4, pre-R8 era) should be cleaned up; and
  the 3.0.3 in-app update was the FIRST that ever worked (forceClosing fix
  proven in production, 10:01 AM).

BUG — schedules flow picker allows ONCE flows; must only allow AUTOMATION flows.
  (Matthew, verbatim: "schedules flow is allowing once flows and should only
  allow flows marked for automation".)
  CODE FACTS: index.html schRefreshOptions() fills #schFlow from
  API.listOnceFlows() — every once-flow — matching the ORIGINAL R16 design
  ("scheduled runs for spreadsheet-free (once) flows ONLY", scheduler.js header
  + the picker label/hint say the same). This is a REQUIREMENT CHANGE, not a
  regression: picker (and the R16 design notes + label text) must switch to
  flows with the automation flag (R9: flowAutomation / automation subfolder).
  RESOLVE WITH MATTHEW BEFORE BUILDING: saveFlow makes once and automation
  MUTUALLY EXCLUSIVE subfolders (sub = runMode==='once' ? 'once' :
  (flowAutomation ? 'automation' : 'general')), and the scheduler fires jobs
  with spreadsheetPath:null (built for spreadsheet-free flows). If automation
  flows can be per-row/sheet-driven, scheduling them needs a sheet source —
  bigger than a picker filter. If schedulable flows should be BOTH once-style
  AND automation-marked, the save-time either/or has to change too.
ITEM 2 — Max workers DEFAULT changes 150 -> 20 (Matthew, verbatim: "max
  workers default to 20"). The 150 HARD ceiling (MAX_WORKERS_HARD_CEILING)
  stays — only the UI default changes. Sites that all say 150 today:
  index.html Max box value attr, poolResetDefaults(), every _pv('poolMaxWorkers',150)
  fallback, saveFlow poolSettings default, loadFlow default. Change them together
  or a Reset/load will silently reintroduce 150.
BUG — worker fatal => infinite respawn cycle, no error surfaced (2026-07-16,
  Matthew hit it live on 3.0.3, 10:45 AM). His report: started a new run without
  closing BUU after the previous run finished; "launched a worker and never
  logged in, it then cycled workers for a while before i stopped it".
  DIAGNOSED FROM THE LOGS (pool1784213142057) — it is NOT a login bug:
   1. Run 1 (pool1784211316101, 10:15) finished; the sheet "Renewal Upload to
      CTP for BUU 7.15.26_RERUN.xlsx" was then ARCHIVED to upcoming\Finished\
      (Finished mtime 10:44:46).
   2. The finished JOB STAYED STAGED (same jobId job1784211314869-448 in both
      pool metas) with the OLD spreadsheetPath. Re-launch at 10:45:42 did not
      re-validate the file.
   3. Every worker died in <1s BEFORE login: {"type":"fatal","error":"ENOENT
      ...upcoming\Renewal Upload...xlsx"} exit code 1 (buu2-worker-*.log, 255
      bytes each, one per second, 7+ in a row).
   4. ROOT CAUSE OF THE CYCLING: the coordinator has NO case for the worker's
      "fatal" message — it is silently ignored. Worker exits, the stall-guard
      (coordinator.js ~362: active && !stopping && workers.size===0 &&
      coordPickJobForWorker() => respawn) sees work remaining and spawns the
      next one. Crash-loop until the user stops the pool. Journal has ZERO rows
      (.jsonl never created). No error ever reaches the UI.
  FIX SHAPE (3.0.4):
   a. Handle "fatal" in coordHandleWorkerMessage: surface the error to the run
      log/error strip, and mark the worker "died-fatal".
   b. Crash-loop breaker: N instant fatal exits (same job, no rows completed)
      => stop the pool with the fatal error shown, do not respawn.
   c. Staleness guard at launch: pool-start re-validates every staged job's
      spreadsheetPath exists (fail the launch with a clear message naming the
      file), since Archive can move it between runs. Consider auto-unstaging or
      re-pathing archived sheets.
  NOTE: run 1 completing + sweep + everything else worked; the logout sweep for
  the bug run also ran clean (sweep1784213182251: 1 session logged out).
BUG (D3 CONFIRMED STILL PRESENT ON 3.0.3) — typing lockup. Matthew, 2026-07-16:
  "the i cant type error is still present". This is Phase-1 D3 (typing lockup
  cluster: run-settings number inputs flaky, step-editor fields stop accepting
  input; suspected focus-stealing render loop). Diagnosed-only, never fixed —
  now confirmed surviving into 3.0.3. PROMOTE from diagnose-list to 3.0.4 work.
  LEAD SUSPECT to check first: renderCoordStatus fires on every pool-status
  (throttled 250ms in coordEmitStatus) and several renderers rebuild via
  innerHTML — an innerHTML rebuild of a container that holds the focused input
  destroys the focused element mid-keystroke. Audit which containers rebuild on
  a timer while an input inside them can hold focus (staged-jobs list, worker
  grid aggregate strip, step editor during status updates).
  REPRO NOTES (fill in with Matthew): which fields, when (during a run? after a
  run finishes? always?), and whether clicking elsewhere then back restores it.
BUG EXTENSION (2026-07-16 2:40 PM, live on 3.0.3) — the stale-staged-job defect
  also hits SCHEDULED fires. pool1784227218226 ran TWO jobs: the freshly-fired
  Schedule Test job AND the finished job from the previous 2:27 PM fire
  (job1784226438089-380), still staged. Each scheduled fire stages a new job
  without clearing completed ones, so every fire re-runs every prior copy —
  N fires => N accumulated jobs, N-1 of them stale (and after an archive/move,
  stale sheet paths feed the fatal crash-loop bug above). FIX with the same
  3.0.4 work: completed jobs must not survive into the next launch (auto-unstage
  on completion, or clear-completed at pool-start/schedule-fire).
  (The flow error itself both times was user-flow step order: type into
  textarea[name=Note] BEFORE the butAdd click that reveals it - not a BUU bug.)
BUG (2026-07-16, Matthew, still present on 3.0.3) — scrolling while moving/
  dragging steps does not work: the step list does not auto-scroll when you
  drag a step toward the top/bottom edge, so long flows cannot be reordered by
  drag beyond the visible screen. Verbatim: "scrolling while moveing steps
  still does not work". Logged as reported - no investigation done yet.
FINDINGS — scheduled-run test #3 (2026-07-17 8:11 AM, pool1784290282524).
  Flow order is FIXED now (nav -> butAdd[after:element textarea] -> type Note ->
  type NoteCode -> butSaveNote). What went wrong, from the worker log:
  1. BUG (BUU) — FIRST NAV AFTER WORKER LOGIN LANDS ON THE LOGIN SCREEN.
     Every scheduled run (4 pools, 07-16 + 07-17) shows the same trace: steps
     1-2 fail 3x (~90s burned), THEN "dead session (login screen detected).
     Re-logging in" — after which everything works. The worker login is not
     sticking for the first direct app.pestpac.com navigation on scheduled/
     once flows. This is Matthew's "stuck on step 2 forever". IMPROVEMENTS:
     (a) find why the first session dies (login flow vs direct-URL nav timing);
     (b) check for the login screen on the FIRST step failure, not after all
     row retries are exhausted.
  2. DUPLICATE NOTES = NON-IDEMPOTENT RETRY ON A FALSE-NEGATIVE CHECK ("stuck
     on step 5" + "3 notes per try"). Step 5 clicks butSaveNote with
     after:"url" (wait for URL change until load). The save WORKS server-side
     but the notes page does not navigate, so waitForURL times out, the row is
     marked failed, and each retry saves ANOTHER note: 3 attempts = 3 notes per
     run (3 on 07-16 4:36 PM + 3 on 07-17 = his 6). FLOW-SIDE FIX: after should
     be element (e.g. butAdd visible again), not url. BUU-SIDE ITEM: a last-
     step whose ACTION succeeded but whose after-check timed out gets the whole
     row re-run — for write-actions this multiplies side effects. Consider
     classifying after-check timeouts as validation (no blind row retry), or a
     per-step "do not retry row on after-check failure" flag.
  3. NOT BUGS: "5/5 steps but there are 7" — correct; locked login/logout are
     lifecycle, only data steps count. "flow has skip saved instead of retry" —
     scheduled fires HARDCODE errHandle:retry (scheduler.js fire()), so the
     flow's saved skip is ignored on schedule; behavior was retry. DESIGN
     QUESTION for Matthew: should scheduled runs honor the flow's errHandle
     instead of hardcoding retry? (Given item 2, retry-on-error for write-flows
     is exactly what multiplied the notes.)
CONFIRMED (2026-07-17) — Matthew was right: SCHEDULED JOBS NEVER LOG IN.
  worker.js:57: LOGIN_STEPS = FLOW_STEPS.filter(s => s.locked && ...). The
  locked pestpac-login/logout steps are added at RUNTIME by the renderer
  (allSteps() = LOGIN_STEPS + steps + LOGOUT_STEPS) and are NEVER SAVED in the
  flow JSON. scheduler.js fire() sends flow.steps raw => no locked steps =>
  worker emits "logging-in" but runs ZERO login steps => first nav lands on the
  login screen => ~90s of failed retries until dead-session recovery re-logs-in
  directly. Worker LOGOUT is runtime-level (not step-driven), which is why it
  always verified clean and masked the asymmetry.
  FIX: fire() must wrap flow.steps with the same locked login/logout scaffold
  the renderer uses ({id pp1, type pestpac-login, locked:true} front, {id pp99,
  type pestpac-logout, locked:true} back). Keep the fast-fail improvement too:
  check for the login screen on FIRST step failure, not after retries exhaust.

DECIDED (Matthew, verbatim: "yes i want it to respect everything!!") —
  scheduled runs must honor the flow's SAVED config exactly like manual runs:
  errHandle (today hardcoded retry), retryCount (hardcoded 2), reauthInterval
  (hardcoded 0), and anything else pool-submit-job accepts that the flow
  carries. fire() reads flow.config and passes it through.
REDESIGN DECIDED (Matthew, 2026-07-17, verbatim: "there should be no diffrence
  between a scheduled run and a regular run, it should use all of the same
  code... the only diffrence is that there should be code to load the flow and
  hit run at a certain time"). SUPERSEDES the earlier fix shape of patching
  fire()'s payload (wrap locked steps + pass config) — do NOT build that;
  it would keep the parallel path alive.
  CONFIRMED ARCHITECTURE PROBLEM: scheduler.js fire() hand-builds its own
  job+start payload (that is where EVERY scheduled-run bug came from: empty
  LOGIN_STEPS, hardcoded errHandle/retryCount/reauth, no flow config), and the
  renderer schedule-fire handler pipes that payload into pool IPC directly
  instead of driving the same functions the Run button drives.
  TARGET SHAPE: at fire time the renderer (1) loads the flow by name through
  the SAME load path a human uses (flow steps + poolSettings + config all
  applied), (2) stages via the same staging code (which adds allSteps() locked
  login/logout — fixes the never-logs-in bug BY CONSTRUCTION), (3) hits the
  same Run entry point. fire() shrinks to "which flow, fire now" + the
  completion watch. Every future Run-path fix then covers schedules for free.
  PLUS RESTART-AT-END (Matthew: "because we STILL have to close the BUU
  inbetween every run it needs to probably close and reopen the program at the
  end of the run"): after a SCHEDULED run completes, BUU should close and
  relaunch itself (app.relaunch() + exit after the sweep finishes) so every
  scheduled run starts from a fresh process — automates the close-between-runs
  hygiene he currently does by hand and kills stale-staged-job accumulation.
  GUARDS: only relaunch after a scheduler-initiated run; only after clean
  completion + logout sweep; never mid-manual-work (unsaved-changes gate
  applies); make sure the missed-schedule popup on boot does not re-fire the
  run that just completed (lastFiredAt already advances first — verify).
  NOTE the underlying disease is stale in-process state between runs; the
  restart is honest mitigation, and the fatal-loop/stale-job 3.0.4 fixes
  attack the same disease from the other side.
CORRECTION (Matthew, 2026-07-17): the scheduler being a separate code path is a
  REGRESSION against the Phase 2 rebuild ("we just went through a rebuild to
  remove all of the seperate code paths"). It does not have to literally drive
  the human UI — but there must be ONE staging+launch path and the scheduler
  must call it. RESTART-AT-END IS HELD (not built in 3.0.4): the state fixes
  below get a two-runs-one-process gate test instead; if that gate is green and
  stale-state still bites live, restart-at-end returns in 3.0.5.

=============================================================================
3.0.4 SCOPE (agreed 2026-07-17)
=============================================================================
1. SCHEDULER = SAME CODE PATH (the headline). Strip fire()'s hand-built
   job/start payload and the renderer schedule-fire pipe. One shared staging+
   launch routine used by BOTH the Run button and the scheduler: flow steps
   wrapped with locked login/logout, flow's saved poolSettings + config
   (errHandle, retryCount, reauth, selectorTimeout...) applied — no hardcodes.
   ACCEPTANCE: a scheduled pool meta is shape-identical to a manual run meta
   (locked steps present, flow config honored); offline test asserts it.
2. BACK-TO-BACK-RUN STATE INTEGRITY (replaces restart-at-end):
   a. Completed jobs cannot survive into the next launch (auto-unstage on
      completion; pool-start refuses/clears finished leftovers).
   b. Worker "fatal" handler + crash-loop breaker: N instant fatals with zero
      rows => stop pool, surface the error. No more silent respawn-forever.
   c. pool-start re-validates every staged spreadsheetPath exists (archive
      moves it between runs) — fail loud with the filename.
   d. GATE: _test-back-to-back.js — TWO full runs through ONE coordinator
      instance (complete -> restage -> run), asserting no state bleed. THIS is
      the evidence the close-between-runs rule can finally die.
3. LOGIN-SCREEN FAST-FAIL: on the FIRST step failure, check for the login
   screen (not after all retries exhaust). Saves ~90s per dead session.
4. WRITE-RETRY HAZARD: a final write step whose action succeeded but whose
   after-check timed out re-runs the whole row and multiplies side effects
   (the 3-notes-per-try). Classify after-check timeout as validation (no blind
   row retry) — design detail settled at build time.
5. MAX WORKERS DEFAULT 150 -> 20 (hard ceiling stays 150). All 5 sites at once:
   Max box value attr, poolResetDefaults, _pv fallbacks, saveFlow default,
   loadFlow default.
6. SCHEDULES PICKER: automation-marked flows only (NEEDS MATTHEW: once and
   automation are mutually exclusive at save time and the scheduler is
   spreadsheet-free — see the design question logged 07-16).
7. STALE 2.2.9 ORPHAN INSTALL at %LOCALAPPDATA%\Programs\BUU 2.0: remove
   (installer sweep or one-time cleanup).
8. D3 TYPING LOCKUP (promoted; NEEDS MATTHEW's repro answers: when does it
   hit + does refocus fix it). innerHTML-rebuild-under-focus is lead suspect.
9. DRAG-REORDER AUTO-SCROLL: step list must scroll when dragging near edges.
HELD / NOT IN 3.0.4: restart-at-end after scheduled runs (see correction
above); hidden-element error message polish (optional, rides along if cheap).
CLARIFIED (Matthew, 2026-07-17): item 6 — "once is ment for build up and tear
  down, automation is a once flow with the automation checkbox checked". So the
  schedules picker filter = once-flows whose AUTOMATION FLAG is true (the flag
  in the flow JSON is the source of truth, NOT the subfolder — a once+automation
  flow files under once/ today and that is fine). listOnceFlows must surface
  the automation flag so the picker can filter on it.
  Item 8 (D3 typing lockup): SKIPPED for now per Matthew — stays logged,
  out of 3.0.4 scope.
=============================================================================
3.0.4 SHIPPED 2026-07-17 (same day as scoped). Branch v3.0.2 HEAD a61abbd,
tag v3.0.4, release BUU-2.0-Setup-3.0.4.exe, update channel VERIFIED serving
3.0.4 BOM-free. All 7 scope items landed; restart-at-end HELD per agreement.
NEXT VALIDATION IS LIVE: Matthew updates + runs a real scheduled flow. Watch:
 - scheduled worker log shows LOGIN STEPS executing (no more dead-session-
   recover-on-first-nav trace), flow errHandle honored in the pool meta
 - back-to-back runs WITHOUT closing BUU: no stale jobs re-run, crash-loop
   breaker never needed. If stale state STILL bites => restart-at-end in 3.0.5.
 - duplicate-note class: after-check timeout rows show errorCategory
   validation and do NOT retry.
STILL OPEN: D3 typing lockup (skipped per Matthew; repro questions pending),
scheduler completion-watch label lost " · scheduled" suffix (cosmetic, staged
label now comes from the shared path), 2.2.9 quarantine folder
_to_delete_BUU-2.0-stale-2.2.9 awaiting Matthew's delete.
=============================================================================
3.0.5 BACKLOG
=============================================================================
BUG (2026-07-17, Matthew) — in-app UPDATE CHECK "still fails with the same
  error" (recurring; exact on-screen error text NOT yet captured — get it from
  Matthew or reproduce in dev with the update dialog open).
  PROBED AT REPORT TIME from the same machine (scripts/_304-updcheck-probe.js):
  the channel itself is HEALTHY — GET version-buu2.json = HTTP 200 in 118ms,
  1140 bytes, first byte 123, parses, version 3.0.4. So the failure is app-side,
  not the channel. SUSPECTS, in order: (1) checkForUpdates() error path only
  reports on MANUAL checks and shows e.message with no context - what message?
  (2) fetchJSON has no timeout at all - a hung socket = eternal silence, which
  the user reads as "failed"; (3) renderer update-status error display; (4) the
  old D1 note: second-instance handler never re-checks updates.
  NEXT STEP: capture the exact error string, then reproduce in dev (the check
  path is drivable over CDP: API.checkForUpdates() with update-status listener).
CRITICAL BUG (2026-07-17, data loss, ship the fix FIRST in 3.0.5) — a MANUALLY
  RUN installer DELETES user data. Measured timeline on the main rig:
  Matthew ran BUU-2.0-Setup-3.0.4.exe by hand at 9:10 AM (because the in-app
  update check was failing). electron-builder ran the OLD uninstaller, which
  removes $INSTDIR (C:\BUU) RECURSIVELY. The .nsh park-and-restore for flows/
  logs/failures only arms ${isUpdated} — true only for IN-APP updates — so a
  manual run parks NOTHING. Result: Schedule Test-flow.json (created 07-16),
  ALL 07-16/07-17 worker logs, and the C:\BUU\schedules definitions were
  deleted. flows/ was recreated at 9:15 from a STALE 7/10-era preserve copy
  (mtimes 5/1..7/10) — meaning an old $TEMP\buu-preserve existed and restored
  over the fresh install. SUSPECTED second bug enabling that stale park:
  customInstall gates restore on IfFileExists "$TEMP\buu-preserve\flows\*.*"
  which does NOT match a folder containing only SUBFOLDERS (once\, general\)
  — a failed restore strands the park in TEMP until some later install slurps
  it. VERIFY this on the next controlled update.
  RECOVERED: Schedule Test-flow rebuilt from the 8:11 pool journal meta into
  flows\once\ (automation:true so the picker lists it; Save-step After changed
  url->element per the duplicate-notes diagnosis). Add Billing Note verified
  IDENTICAL to what ran 07-16 (no edits lost there). The schedule definition
  itself must be recreated by hand. Worker logs 07-16/17 unrecoverable (the
  journals + xlsx logs in %APPDATA%\buu-2 survive - they live OUTSIDE C:\BUU).
  FIX DIRECTION (Matthew to pick): (a) uninstaller NEVER deletes flows/logs/
  failures/schedules (delete app files only) — safest; (b) park UNCONDITIONALLY
  including schedules\ and fix the IfFileExists-vs-subfolders check; (c) move
  user data out of $INSTDIR entirely (contradicts R8 one-place decision).
  RELATED: the in-app update-check failure that pushed him to a manual install
  is the previous backlog entry — fixing it removes the trigger, not the gun.
=============================================================================
3.0.5 SHIPPED 2026-07-17 (same day). Tag v3.0.5, channel VERIFIED serving
3.0.5 BOM-free. Contents: uninstaller NEVER deletes user data (unconditional
park to C:\BUU-preserved incl schedules, stale-park shove to *-prev, plain-dir
restore checks, legacy TEMP-park restore for the 3.0.4->3.0.5 transition);
code-side flows+schedules backup to userData\update-backup before any in-app
update; update-check 15s timeout + diagnostic errors (live check from dev
WORKED - his installed-app failure never reproduced; next failure names its
cause); startMode saves with the flow (pre-key flows load run-all); empty
picker hint. Schedule Test-flow rebuilt earlier from journal meta with
automation:true.
LIVE VALIDATION FOR MATTHEW (in order):
 1. Update IN-APP to 3.0.5 (schedules dir is empty right now, so nothing to
    lose in this last old-uninstaller transition; flows ride the TEMP park +
    are backed up to userData\update-backup by nothing yet - 3.0.4 has no
    backup code - the NSIS TEMP park is the protection this one time).
 2. AFTER updating: verify flows survived, recreate the Schedule Test
    schedule, confirm the picker lists the flow.
 3. Save the flow with Run all; scheduled fire should log in via locked steps
    and run unattended. Back-to-back fires need no BUU restart.
NEXT-UPDATE CHECK (3.0.5 -> 3.0.6 eventually): C:\BUU-preserved should be
created and emptied in the same install; if a *-prev folder ever appears
there, a restore failed - investigate, data is IN it, not lost.

3.0.6 SHIPPED 2026-07-17 minutes after 3.0.5 (Matthew never installed 3.0.5; he jumps 3.0.4 -> 3.0.6). ROOT CAUSE of the recurring update-check failure FOUND via his screenshot: read ECONNRESET on the FIRST connection after app open (corporate firewall cold-path reset), success on second - one reset was treated as final and also silently killed the startup check (no update bar on first open). Fix: check retries 3x/2s on transient net errors, download retries once. Everything from the 3.0.5 ship note still applies - update in-app FIRST, then recreate the Schedule Test schedule.
INCIDENT #2 (2026-07-17 ~10:15-10:36) — Schedule Test-flow.json deleted AGAIN
  during the update hops to 3.0.6. MEASURED TIMELINE: 3.0.5 built 9:54; 3.0.6
  built 10:15; userData\update-backup CREATED 10:36:14 by a 3.0.5+ install-
  update (so a 3.0.4->3.0.5 hop happened first, then 3.0.5->3.0.6 at 10:36);
  3.0.6 exe landed 10:36:48; flows dir (re)created 10:36:57. The 10:36 backup
  ALREADY lacked Schedule Test => the file died in the FIRST hop (3.0.4's OLD
  uninstaller/TEMP-park era), not in the new machinery. The SECOND hop (3.0.5
  uninstaller park -> 3.0.6 restore) preserved all 22 files intact AND took the
  code-side backup — the new machinery worked on its first live run.
  UNRESOLVED: exactly how hop 1 dropped one file (whole-dir renames are all-or-
  nothing; suspicion remains on the 3.0.4-era TEMP park/restore or a manual
  install of 3.0.5). Academic unless it recurs: every future transition runs
  3.0.5+ uninstallers only.
  RECOVERED: Schedule Test-flow rebuilt again from the journal meta (10:42).
  WATCH ON NEXT UPDATE (3.0.6 -> next): flows file count identical before/
  after; update-backup refreshed; C:\BUU-preserved created and emptied in the
  same install; no *-prev folders. If ANY file goes missing again with the new
  machinery on both sides, the park/restore theory is wrong — escalate to
  moving user data out of $INSTDIR entirely (option c).
=============================================================================
3.0.7 SHIPPED 2026-07-17 (~11 AM). FLOWS TRAVEL WITH THE INSTALLER (Matthew:
"every flow i make here on my main computer is avalible where ever i install
the BUU" - a previously-directed feature that had NEVER actually been built).
 - build/snapshot-flows.js (tracked via force-add; build/ dir ignore defeats
   ! negations) snapshots C:\BUU\flows -> flows-bundle at npm run build;
   ships via extraResources. 23 flows in the 3.0.7 package, verified in
   dist\win-unpacked\resources\flows-bundle.
 - seedBundledFlows() on boot copies bundled flows the machine LACKS. NEVER
   overwrites - local edits win; delete a flow file + relaunch to re-seed.
   Dev runs never seed. VM builds with no C:\BUU\flows = empty bundle, valid.
VM TEST (Matthew doing): install BUU-2.0-Setup-3.0.7.exe on the VM -> full
23-flow library should appear on first launch, Schedule Test in the schedules
picker (automation-flagged). Main rig update 3.0.6->3.0.7 doubles as the FIRST
full test of the new park machinery on both sides: watch flows count 23 before/
after, update-backup refreshed, C:\BUU-preserved created+emptied, no *-prev.

STANDING DECISION (Matthew, 2026-07-17, recurring - STOP RAISING IT): public exposure of flows/URLs/customer IDs in the repo or installers is a NON-ISSUE - all of it is meaningless without the company key, API key, and logins, which are never in the repo or bundle. Do not bring up this class of security concern again. Flows-bundle is now TRACKED in git per his original suggestion (version history = free recovery from any future loss).

LATER RELEASE (Matthew, 2026-07-17): GO PRIVATE. Make the release repo private and teach the updater to authenticate. Scope when picked up: fine-grained read-only GitHub token baked into the app (or a public releases-only mirror), fetchJSON + downloadFile send the auth header, raw.githubusercontent fetch of version-buu2.json switches to the authenticated contents API, verify in-app update end-to-end from a private repo before flipping visibility. Not scheduled - Matthew will say when.
=============================================================================
3.0.8 BACKLOG
=============================================================================
BUG (2026-07-17, Matthew on the VM, 3.0.7) — scheduled fire hits the login
  step, LOGIN FAILS (bad/unreadable stored credentials suspected), worker is
  killed, a new worker spawns, "cycle continues indefinatly EVEN IF I TELL IT
  TO STOP". Two distinct defects on top of the credential problem:
  DEFECT A — THE CRASH-LOOP BREAKER IS EVADED BY SLOW FATALS. The 3.0.4
  breaker counts only exits <15s with 0 rows. A login failure burns selector
  timeouts first (30s+), so every login-failed fatal exits SLOWLY, the
  instant-exit counter never increments, and the stall-guard respawns forever.
  FIX SHAPE: count consecutive FATAL-message exits with zero rows REGARDLESS
  of lifetime (the fatal message already marks them); 3 in a row => stop pool,
  surface the error. The <15s rule stays as a catch-all for silent crashes.
  DEFECT B — STOP DID NOT STOP IT (per Matthew). Unconfirmed mechanism; needs
  the VM logs. Suspects: pool-stop vs a mid-login worker (login not at a step
  boundary; drain/stop cmd unread until login resolves, force-kill fuse 10s
  should still fire); scheduler re-fire window; or the stop click erroring in
  the renderer. DO NOT GUESS - read the logs first.
  CREDENTIAL SIDE (root trigger): profiles = %APPDATA%\buu-2\credentials.enc
  (DPAPI = machine+user bound - COPYING IT BETWEEN MACHINES CANNOT WORK) +
  Windows Credential Manager entries under service BUU2. VM remedy: delete +
  re-create the profile in-app on the VM. WORTH A GUARD in 3.0.8: if the
  profile store fails DPAPI decryption, say so in the UI ("credentials were
  created on another machine/user - re-create the profile") instead of letting
  workers discover it as a login crash-loop.
  DIAGNOSIS MATERIALS WANTED FROM THE VM: C:\BUU\logs newest buu2-worker-*.log
  (a few) + the pool-journal meta from %APPDATA%\buu-2 for the looping run.
=============================================================================
3.1.1 BUG (found right after shipping 3.1.0, 2026-07-17) — DUPLICATE FLOWS,
root vs subfolder, self-perpetuated by flows-bundle.
=============================================================================
C:\BUU\flows has every OLDER flow TWICE: once loose in the root AND once in its
general\ / once\ subfolder. 47 files = 22 subfolder + 22 root dupes + 2 once + 1
automation. New flows (saveFlow) go to subfolders only, so they are clean.

DANGER (real): read-flow-by-name scans ROOT FIRST (order ["", general, automation,
once]) but saveFlow WRITES to subfolders. Verified the "Add Billing Note" pair has
DIVERGED (root 1647B @12:29 vs sub 1623B @10:57) => a pool run can execute the ROOT
copy while the builder edits/saves the SUBFOLDER copy. Edit a flow, run it, and it
may run the OLD version. Latent, time-wasting.

ORIGIN CHAIN (mine): root-loose copies pre-existed (6/29 legacy migration copies
FLAT to root; marker dated 2026-06-29). snapshot-flows.js walks C:\BUU\flows
RECURSIVELY incl the root-loose files and bundles them at flows-bundle root.
seedBundledFlows (on every install/launch) copies bundle-root files back into
flows root => the dupes regenerate every install. Self-perpetuating.

FIX (3.1.1):
 (a) snapshot-flows.js: SKIP a root-loose flow whose basename also exists in a
     subfolder (subfolders are canonical). Likely skip root-loose entirely.
 (b) read-flow-by-name + list-once-flows: prefer SUBFOLDER over root (put root LAST,
     or de-dupe by basename keeping the subfolder copy).
 (c) ONE-TIME CLEANUP: move the 22 root-loose dupes out of C:\BUU\flows so subfolder
     copies win. NEEDS MATTHEW — root mtimes are seed-time not edit-time, so "newest"
     is misleading; must confirm the SUBFOLDER copies are the ones edited in the
     builder. device_bash cannot delete; move to a _to_delete folder for him to remove.

DO NOT auto-delete his flows. The 3.1.0 FEATURE is unaffected (Fieldwork is new).
ALSO: the tracked flows-bundle/ in git now carries the dupes too — after fix (a),
regenerate + re-commit a clean bundle.
=============================================================================
BUG (2026-07-23, Matthew) — in-app update DOWNLOADS but the installer never runs.
=============================================================================
Update bar showed, hit Install, progress bar filled, BUU closed — but did NOT
update or launch the installer. Still on 3.0.7 afterward.
FORENSICS (main rig):
 - installed = 3.0.7 (target was 3.1.0). update FAILED at the LAUNCH step, not
   download.
 - install-update DID run: userData\update-backup written 8:36:52 (the 3.0.6+
   pre-update backup fired), then buu-update.exe fully downloaded 8:37:02
   (217,451,425 bytes = complete, matches the release). BUU quit (0 procs).
 - So: backup OK, download OK, then shell.openPath(tmp)+app.quit() ran but the
   installer never elevated/installed.
SUSPECTS (in order):
 1. shell.openPath(tmp) return value is IGNORED — it returns a non-empty error
    STRING on failure (never throws). If Windows refused to open the exe (assoc,
    AV lock, policy) we would never know. FIX: check the return; if non-empty,
    surface it and do NOT quit (leave BUU up with a "run this file" path).
 2. Unsigned installer + SmartScreen/UAC: a brand-new unsigned exe can be blocked
    with the elevation/SmartScreen prompt appearing AFTER BUU already quit, or the
    prompt dismissed. forceCodeSigning is off (build), so this is plausible.
 3. 2s app.quit() race after openPath — if the shell had not yet spawned the
    detached installer, quitting could orphan it. Increase delay or wait for spawn.
FIX SHAPE (later): capture openPath error + keep BUU alive on failure with a
clickable path; consider ShellExecute "runas" for the installer; lengthen the quit
delay. RELATED backlog: the ECONNRESET-era update-check issues + this launch issue
are the whole updater hardening pass.
IMMEDIATE UNBLOCK for Matthew: the complete installer is already at
%APPDATA%\buu-2\updates\buu-update.exe — double-click it to install 3.1.0 now.
=============================================================================
BUG / ARCHITECTURE (2026-07-23, Matthew) — BUU must be FULLY self-contained in
C:\BUU. All BUU-written paths belong under the install root, not %APPDATA%.
=============================================================================
Matthew: "everything BUU goes in the BUU folder... all download or write paths
need to be in the BUU folder self contained."

CURRENT SPLIT (installed app):
 - IN C:\BUU (correct, via buuRoot(): flows\ logs\ failures\ schedules\.
 - IN %APPDATA%\buu-2 (WRONG, via app.getPath(userData)): credentials.enc,
   buu-config.json, ALL pool journals (pool-journal-*.jsonl/.meta/.done, ~50 of
   them), worker-pids.json, update-backup\, updates\ (the downloaded installer!),
   browsers\. Plus Electron chromium cache (Cache/GPUCache/Network/... — leave
   those; regenerable, and moving them means fighting Electron).

THIS is why the 3.1.0 update .exe downloaded to %APPDATA%\buu-2\updates instead
of C:\BUU (install-update uses getPath(userData)/updates, main.js ~1411).

EXACT SITES to move from app.getPath(userData) -> buuRoot() (a new buuDataDir()):
 - main.js: credFilePath (217), getConfigPath (283), update-backup (1402),
   updates dir (1411), worker-pids (1937), browsers (210), the ud/pf refs (1924/1937).
 - journal.js: coordJournalPath/MetaPath/DonePath + the dir scans (12,13,119,132,154,186).
 - coordinator.js: PIDFILE (15), orphan-scan dir (83), worker runContext userDataDir (290).

MIGRATION COST (the careful part — do NOT skip): credentials.enc, buu-config.json,
and existing journals currently live in %APPDATA%. If the path just flips, Matthew
LOSES saved credentials + config (has to re-enter) and orphan-resume loses history.
=> the version that flips paths MUST run a one-time migrate: on first launch, if a
BUU-data file exists in %APPDATA%\buu-2 and not in C:\BUU, copy it over (guarded by
a marker). Same shape as migrateLegacyFlowsOnce.

NOTE dev mode already uses userData as buuRoot(), so switching installed paths to
buuRoot() is CONSISTENT — dev keeps using userData, packaged uses C:\BUU.
PAIRS WITH the just-logged updater-launch bug (openPath return ignored): fixing both
is the updater/self-containment hardening pass.
=============================================================================
BUG / DESIGN (2026-07-23, Matthew) — scrape "dry run" write-toggle is a footgun;
a scrape step must ALWAYS write its output.
=============================================================================
The "Write Frankware scrape to CSV" checkbox (index.html ~926, config
scrapeCsvEnabled) gates the WRITE on/off: unchecked = "scrapes but writes no file"
(its own hint). Matthew reasonably assumed it was a FORMAT choice (CSV vs XLSX for
size) — it is NOT; there is no xlsx path. It is a persist-across-runs write-yes/no
toggle, and being left unchecked from an earlier Frankware session silently turned a
2,241-location / 702-cancellation Fieldwork run into a dry run (no file). Recovered
this time by parsing the worker log (_311-recover-fieldwork.js).

Matthew, verbatim: "why would there even be an option for this, this steps only
pourpose is to scrape a file". Correct — a scrape step whose whole purpose is the
output should not be able to silently produce nothing.

FIX:
 1. Scrape steps (fw-scrape-orders AND fieldwork-cancel-scrape) ALWAYS write. Remove
    the write-on/off gate (coordinator: drop the scrapeCsvEnabled skip; always call
    coordAppendScrape / coordAppendFieldwork). Delete or repurpose the checkbox.
 2. IF a real need exists, replace it with a FORMAT picker (CSV | XLSX) — CSV for
    huge scrapes, XLSX for convenience — NOT a write on/off. Default CSV (crash-safe
    append; xlsx would need an end-of-run single write). Matthew floated XLSX-for-size.
 3. Until fixed: label is also wrong ("Frankware" — it gates Fieldwork too).
INTERIM: user must CHECK "Write Frankware scrape to CSV" for any scrape run to save.
CORRECTION (Matthew, 2026-07-23) — the scrape output toggle is a FORMAT choice:
CSV vs XLSX, chosen for FILE SIZE (big scrape -> CSV, smaller -> XLSX). It ALWAYS
writes. It is NOT a write-on/off / dry-run switch. That is the intended design;
build it that way. The current write-yes/no behavior (scrapeCsvEnabled gating the
write) is the bug — replace with the format picker, output always produced. Applies
to BOTH scrape steps (Frankware orders + Fieldwork cancellations); label must not
say "Frankware".
