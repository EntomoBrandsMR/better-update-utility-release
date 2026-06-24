# BUU v2.4.0 — Design Doc

> **Renumbered from v2.3.0 on 2026-06-24.** The v2.3.0 slot was consumed by the Frankware
> platform release shipped as **v2.2.5**, so all planned versions shifted +1: this release
> v2.3.0 → v2.4.0, and its deferred items (Field Catalog, parallel multi-flow) v2.4 → v2.5.
> The v3.0 API/hybrid slot is unchanged. Shipped docs (v2.2.2/v2.2.3) keep their original
> "v2.3" mentions as historical record.

**Status:** Not started. Agenda locked 2026-05-27 in a long live-debugging session against PestPac's Void Lead flow.
**Predecessor:** v2.2.1 (lossless reclaim on elastic scale-down + license-leak/logout/free-count fixes + colName focus + worker card border). Currently shipped.
**Release theme:** Refactor + dialog handling + diagnostics + new capabilities. The release that pays down v2.x's accumulated debt and adds the missing primitives the Void debugging session exposed.

---

## STANDING CONTEXT (always true — do not re-ask)

- **Matthew is the only user of BUU right now.** Sole operator, no other install in the field.
  When Matthew says ship, ship all the way (bump, commit, tag, push, AND publish the GitHub
  release). He tests on his own machine after the fact.
- **Two apps now, fully separate:** BUU Legacy (branch `v1.3.5-legacy`, `version.json` channel,
  productName "Better Update Utility") and BUU 2.0 (branch `v2.0.0-elastic`, `version-buu2.json`
  channel, productName "BUU 2.0", appId `com.entomobands.buu-2`). Separate userData folders
  (`%APPDATA%\buu-2` for 2.0). v2.4 work targets BUU 2.0 only.
- **Workflow:** diff-by-diff sign-off on non-trivial changes; tests after push, not during the
  session; prefers brutal honesty over softened status. Use desktop-commander `edit_block` /
  `write_file` (not Filesystem `edit_file` — EPERM rename locks). PowerShell quote-mangling on
  inline `-m` / `node -e` is a known footgun — use `git commit -F <file>` and Node script files
  instead of inline. Validate: `node --check src/main.js`, `node --check src/preload.js`,
  `node scripts/_check-html-js.js`, `node scripts/_validate-runner.js`,
  `node scripts/_validate-pool-worker.js`, `node scripts/_test-coordinator.js`.
- **Release pipeline:** `npm run build` on `v2.0.0-elastic` branch → `gh release create` →
  update `version-buu2.json` on `main` (BOM-free; write via Node `fs.writeFileSync(path, str, 'utf8')`,
  verify first bytes are `7b 0a 20`).

---

## v2.4.0 OVERALL SHAPE

v2.4 is anchored on **runtime unification**. BUU 2.0 was layered on top of BUU Legacy's
single-runner without unifying — there are effectively three runtimes in `src/main.js` today
(single-runner, pool-worker template, sweeper template), each with their own copies of login,
logout, step execution, dialog handling, and error reporting. Every fix has to be applied
multiple times. Every divergence (e.g. the sweeper-login `LoginForm-loginBtn` bug fixed in
v2.2.1) is the cost of that. v2.4 unifies the runtime first, then ships the rest of the
features on top of the cleaner base.

The Void debugging session on 2026-05-27 surfaced two categories of missing primitives:
- **Wait primitives** beyond "selector appears" (URL-change, navigation-complete, state-aware
  selectors like `:enabled` / `:disabled`).
- **Diagnostic primitives** so a failed row produces evidence instead of just a one-line error.

Plus a UX simplification (dialog handling moves onto the action steps themselves; the
standalone Handle Dialog step type goes away), and two new capability classes: spreadsheet-free
flows and scheduled / sequentially-queued runs.

**Build order:** runtime unification first, by itself, get it stable. Then everything else
lands on the cleaner base. Don't try to combine unification with feature work — it'll get
muddy.

**Sized as a tight, shippable release.** Field Catalog, parallel multi-flow, and PestPac API
integration are explicitly deferred (Field Catalog and parallel multi-flow to v2.5; API to a
v3.0 branch).

---

## v2.4.0 ITEMS (25 items, in build order)

### Foundation

**1. Unify the runtime.** [LARGEST SINGLE ITEM — DO FIRST, BY ITSELF.]

Single step-execution engine shared by single-runner mode, the worker pool, and the sweeper.
One login routine, one logout routine, one dialog handler, one error/skip/reclassification
path. Thin wrappers around the core for each call site.

Today's structure: `src/main.js` has three template-string runtimes — the worker
template (`buildPoolWorker`, ~22k chars), the sweeper template, and the once-flow runner
template (~5-6k chars each). Plus the single-runner code path in `runStep` etc. Every step
type (`click`, `select`, `type`, `navigate`, `dialog`, etc.) has its execution logic copied
across these. Same for login (`loginToPestPac` appears in all three), logout, dialog handling,
and error reporting. The 2.2.1 sweeper-login bug existed because someone updated the worker
template's `loginToPestPac` but missed the sweeper's copy.

**Concretely what unification looks like:**
- Extract step execution into a single set of step handlers callable from any host (main
  process for single-runner, child process for pool workers, sweeper-as-special-case).
- One `loginToPestPac(page, creds)` function. One `logoutFromPestPac(page)`. One
  `handleDialogOn(action, mode)`.
- The pool worker becomes a thin shell that pulls batches, calls the unified step engine per
  row, emits results. The sweeper becomes a one-shot caller of `logoutAllSessions(page)`.
- The flow JSON schema doesn't change in this item (existing flows keep working). What changes
  is what executes them — one runtime instead of three copies.

**Acceptance:** the existing coordinator test suite still passes (49/49 today), all template
validators still pass (`_validate-pool-worker.js`, `_validate-runner.js`,
`_check-html-js.js`), and a real run against a small flow produces identical journal entries
to v2.2.1.

**Pay-for-itself property:** almost every other v2.4 item is easier and lower-risk because
it's built once instead of two-or-three times. Items 2 (dialog checkboxes), 6 (diagnostic
capture), 8-12 (wait primitives), and 13 (Run Pool is the only Run) all depend on this
unification not being a per-runtime patch.

### Dialog handling — replaces the Handle Dialog step type entirely

**2. Auto-accept / auto-decline checkboxes on every action step that can trigger a dialog.**

Add a pair of mutually-exclusive checkboxes to Click, Select, Type, and Navigate step types:
- ☐ Auto-accept dialog
- ☐ Auto-decline dialog

When checked, the runner registers a `page.on('dialog', d => d.accept())` (or `.dismiss()`)
listener **immediately before** the action fires. Listener handles *all* dialogs that fire
during the action window (not just the first — multiple sequential confirms in a row work,
e.g. "Are you sure? → Really sure? → Confirmed."). Teardown the listener after the action
completes.

**Permissive on zero dialogs.** If no dialog fires, the listener is harmless and the action
proceeds normally. Never blocks waiting for a dialog that might not come. **This is the fix
for the "program just sits and waits" bug** Matthew hit on 2026-05-27 — a previous design
that armed a listener and *waited* for a dialog would hang on actions that didn't trigger one.

**Designed to grow into per-dialog routing later.** v2.4 ships the two-checkbox simple version
("any dialog → accept" or "any dialog → decline"). When per-dialog routing is needed (Matthew
named the case: yes to one dialog, no to another in the same step), the UI grows from
checkboxes to a small rules list (`if dialog text matches X → accept; else → decline`), but the
underlying schema stays compatible. Don't build the rules editor in v2.4 — leave the door open.

**3. Remove the Handle Dialog step type.**

The standalone `dialog` step type goes away. On flow load, migrate: any Handle Dialog step is
removed from the flow, and the **previous** step (the one whose action triggered the dialog)
has its `autoAcceptDialog` set to `true`. Save the migrated flow on next save. No broken
flows; transparent to the user.

This is the root cause of much of the Void debugging session's confusion: the Handle Dialog
step *appears* to handle dialogs (the dialog disappears from the screen), but it doesn't
actually click OK — Playwright's default-dismiss behavior cancels the dialog. The user sees
"the dialog was handled" and assumes OK was clicked; in reality Cancel was clicked and the
gated action (Reopen, in our case) never submitted. Eliminating the step type eliminates the
confusion.

**4. Dialog text always logged on the triggering row, regardless of outcome.**

Whether the row succeeds, fails, or had a dialog accepted/declined — capture the dialog's
exact text into the per-row Excel log. The data is free (Playwright's `dialog` event includes
the message). Right now we throw it away. Logging it converts "479 mystery skips" into "479
skips with the exact PestPac message that fired" — usable distribution analysis without
needing to dig through worker `.log` files.

**5. Skip-vs-error reclassification.**

A dialog blocking a save is an **error**, not a **skip**. Today they're conflated in the
journal as `s: skip`. The two have different semantics:
- **Skip:** "I chose not to do this" (e.g. row filtering, user-configured).
- **Error:** "PestPac stopped me" (validation failed, required-field block, server error).

Different counter in the pool status, different filter in rerun-sheet builders, different
default rerun behavior (errors retry, skips don't). The journal record schema needs a new
status value (or a sub-status field) to distinguish.

### Diagnostic capture (with bounded artifact size)

**6. Diagnostic capture, layer 1, with sampling controls.**

On row failure, capture per **row** (not per retry attempt — one capture at final-failure):
- Full-page screenshot (PNG, ~150-300KB)
- Gzipped DOM snapshot (~30-50KB)
- Current URL
- Last 5 step events with timestamps
- Browser console buffer (last N messages from `page.on('console')`)

Written to `failures/row-<N>-<reason>/` under the pool's log directory.

**Opt-in toggle on the pool launch screen** — off by default. Investigation runs turn it on;
production runs leave it off. The 3k-skip run that motivated this would otherwise produce
~900MB of artifacts; with capture off, the cost is zero.

**Per-error-bucket sampling cap (default 10 per bucket).** Runner hashes the error signature
on the fly and stops capturing once a bucket reaches the cap. 2,800 identical "WonStatus
disabled" failures produce 10 captures, not 2,800. Captures from rare-failure buckets are
preserved.

**End-of-run cleanup prompt:** "save / discard / delete in 7 days." Don't accumulate
silently.

With those three controls, layer 1 is a small fixed cost when on (~10MB per run typical) and
zero when off, regardless of skip count.

**7. Log retention / cleanup policy.**

Startup auto-delete of worker `.log` files and per-worker `BUU2-log-*.xlsx` files older than N
days. Keep merged journals and `.done` markers. N configurable via settings. Now becomes
table-stakes since item 6 will add diagnostic-capture folders that also need retention.
Matthew raised this twice in earlier sessions before today; it's been queued since the v2.2.1
work.

### Wait/state primitives (the Void debugging gap)

**8. URL-change wait condition on Click step.**

New `waitFor` mode: `urlChange` (URL differs from pre-click value) or `urlMatches: <pattern>`
(glob/regex match). Maps to `page.waitForURL()`. The Void Reopen click navigates PestPac away
from the lead detail page; the only reliable "the click took effect" signal is the URL
changing. Selector-on-the-current-page checks are the wrong primitive when the page is moving
out from under them.

**9. Navigation-complete wait condition on Click step.**

For clicks that you know trigger a navigation but don't care where. Wait for the next `load`
event after the click. Maps to `page.waitForLoadState('load')`. Companion to item 8.

**10. State-aware selectors in `waitFor`.**

Audit the runner: do `:enabled`, `:disabled`, `:visible`, `:checked` actually wait for the
**state**, or just for the element's existence in the DOM? PestPac toggles `disabled`
constantly as state changes; "element exists" matches both enabled and disabled, which is
useless for state-transition waits. Fix the runner to honor state pseudo-classes — likely by
routing such selectors through `page.waitForFunction` or
`locator.waitFor({ state: 'visible' | 'attached' | 'hidden' })` instead of plain
`waitForSelector`. Document supported pseudo-classes in the step builder UI.

This is the single highest-payoff fix for handling slow stateful apps like PestPac.

**11. Generic Wait step type.**

Standalone step: selector + state (visible / hidden / attached / detached / enabled /
disabled / a checkbox-checked-equals) + timeout. Maps to `page.waitForSelector` and
`page.waitForFunction` under the hood. The missing primitive for waiting between steps
without tying the wait to a click or select.

Many flows need "wait for X to happen before continuing" as a first-class concept; today the
only ways to wait are post-action `waitFor` fields on specific step types or a fixed
millisecond sleep. A generic Wait step gives flow authors a clear, explicit waiting mechanism.

**12. Per-step action timeout setting.**

Expose Playwright's per-action timeout (the 30s default that fires inside `selectOption`,
`click`, `fill`, etc., when an element is found but not in the right state) as a step-level
setting. Currently the user can configure wait-for-element timeout but not action timeout —
both default to 30s and the action one is invisible to the user. Multiple times in the Void
debugging Matthew raised the wait-for-element timeout (to 300s) with no effect, because the
failing timer was the unconfigurable action timer.

### Flow ergonomics

**13. Run Pool is the only Run. Pool respects start modes. Single Stop button.**

Today there are two separate run paths (Run automation = single-runner; Run pool = elastic
worker pool) with separate Stop buttons. The single-runner mode is now redundant — a pool of
size 1 with batch size 1 is functionally equivalent. Once workers are configurable down to 1
(they already are), kill the duplicate code path.

The pool should respect start modes (run-all / step / step-row). Today the pool ignores them;
only the single-runner honored them. Item 15 (Pool preview / verification mode) covers
restoring step-by-step in the pool.

Falls out naturally from item 1 (runtime unification) — once the step engine is unified, there's
nothing to duplicate.

**14. Step move-up / move-down buttons.**

Each step in the flow builder gets `▲` / `▼` buttons next to the existing controls. Disabled
at the boundaries (no `▲` on step 1, no `▼` on the last step). Routes through the same step-
array mutation path that drag-to-reorder uses so undo/save behavior stays consistent. Lives
in `renderSteps()` in `src/index.html`. Small, well-scoped, can ride along anywhere.

**15. Hot-reload flow edits between runs.**

The pool reads the **current saved flow** at run launch, not from a startup cache. Flow edits
saved while BUU is running take effect on the next run launch, without requiring app restart.

Today, edits silently no-op until the app is closed and reopened. This cost ~2 rounds of
diagnosis on 2026-05-27 — Matthew added a wait-for-element step, ran the pool, saw the same
failure, concluded the wait didn't help, when in reality the wait never ran (cache was stale).
Minimum safety net: a visible "flow last saved: [timestamp]" indicator on the pool launch
screen, so the user can see at a glance whether their edit landed.

**16. Pool preview / verification mode.**

Restore the single-runner step-by-step preview that broke when the pool was introduced. Make
it available before/at pool launch — user can step through a sample row to verify the flow
before committing the full pool. Required for verifying new flows or debugging stuck ones.

### Reliability hardening (from this session's observations)

**17. Logout-attempt warnings surfaced in pool status.**

When a worker takes more than 2 logout attempts to log out, log it as a warning in the pool
status. Workers exiting without `logged-out: ok: true` get flagged as license leaks in the
report — they consumed a license slot and may not have freed it. Today this is invisible
unless you dig through worker `.log` files.

Background: 2026-05-27 had a worker take 6 logout attempts. v2.2.1's `licenseReaderLogout`
correctly retries when PestPac doesn't acknowledge a clean logout, but six attempts is a lot
of patience; another attempt or two and the worker would have been force-killed with the
session still consuming a license.

**18. Smarter logout retry strategy.**

After N (default 3) failed polls of "did the logout succeed," re-navigate to `Mode=Logout`
rather than continuing to poll the same already-failed state. Re-issuing the navigation is
more aggressive than polling and matches what a stuck human user would do. Low priority since
the polling does eventually succeed, but worth tightening.

### New capabilities

**19. Spreadsheet-free flow type.**

A new flow `runMode` (or distinct schema variant): runs once, no row iteration, no source
sheet. Just a sequence of steps that performs a discrete operation. Use cases Matthew named:
"send today's bills," "log in and check the appointment queue," "run the end-of-day report."

Implementation:
- New `runMode` value (existing values: `per-row`, `once` per v1.2.8 setup/teardown). Add
  e.g. `standalone`.
- UI: skip the spreadsheet picker entirely when this mode is selected.
- Runner: skip the batch loop; just execute the steps once.
- Logging: per-run summary (no per-row sheet).

Sibling to item 21 (scheduled runs) — a spreadsheet-free flow that fires on a schedule covers
most "automated daily routine" use cases without needing a spreadsheet.

**20. Sequential flow queueing.**

"Run flow B when flow A finishes." Pool gains a concept of a flow chain — a list of jobs to
execute in order, sharing the worker pool and login session.

This is the sequential-only version of multi-flow; **parallel multi-flow ("run A and B at the
same time") is explicitly v2.5**. Sequential is small and contained; parallel introduces
license-sharing, log-namespacing, and worker-allocation concerns that need a real architecture
pass.

UI: a "+Job" or "Add next flow" button on the pool launch screen builds the chain. Each
chained flow has its own row source, its own start condition (e.g. "when previous finishes
successfully" vs "when previous finishes regardless"), and shares the pool's licenses and
worker headroom.

**21. Scheduled flow runs.**

Specify a time (or recurring schedule) for a flow to start automatically.

UI (no cron syntax for normal users):
- Run **once** at [date] [time]
- Run **daily** at [time]
- Run **weekly** on [Mon Tue Wed Thu Fri Sat Sun] at [time]
- Run **monthly** on [day of month] at [time]
- Advanced: cron expression for power users

Under the hood: cron. Persistence: schedule entries saved in `%APPDATA%\buu-2\schedules\`,
loaded on app start.

**Edge cases to handle explicitly:**
- **BUU offline at scheduled time:** default "skip and log" so the user can see "scheduled run
  at 6am — BUU was offline." Alternative: Windows Task Scheduler entry that wakes BUU; more
  reliable but adds installer complexity. Default first; Windows-wakeup as optional.
- **Overlapping schedules:** same queue semantics as item 20 (sequential queueing). A scheduled
  job that fires while another is running joins the queue.
- **License-aware scheduling:** optional precondition on a schedule entry — "only run if at
  least N licenses are free." Skip with a logged reason otherwise. Useful for "run at 2am" type
  schedules to avoid collisions with humans.

Applies to both spreadsheet flows and spreadsheet-free flows (item 19).

### Concurrency control + burn-time caps (added 2026-05-27 after the 9,854-row big run)

**22. Adaptive worker scaling — three caps, three signals, ramped startup.**

Static worker counts are a guess. There are **three independent caps** on how many workers can
run productively, and the coordinator needs to respect all three:

1. **PestPac license cap** — already enforced today via `check-license-cap`. Pool can't exceed
   free licenses minus configured buffer.
2. **PestPac response cap** — PestPac's own capacity slows down under concurrent load. The
   2026-05-27 big run with 124 workers had healthy OK p50=23s but skip p50=102s; manual loads
   took 3-5 minutes during the run. The right worker count for a slow PestPac is much lower
   than for a fast PestPac, and changes minute-to-minute based on other users' load.
3. **Local machine cap** — confirmed on 2026-05-27 after the big run: launching a Quick check
   flow with Auto-set 119 workers nearly crashed the host machine and the run actually went
   *slower* than at a much lower worker count. 119 Chromium instances × ~300-400MB RAM each is
   24-48GB, plus the CPU thrash of 119 processes context-switching. Past this ceiling,
   throughput goes negative.

**Three signals to monitor:**

- **OK-row duration p75** climbing (PestPac slowing).
- **Wall-clock-to-Playwright-measured-time ratio.** If wall-clock per row is much larger than
  Playwright's own action timings sum, the difference is being eaten by local resource
  contention (process scheduling, GC pauses, swap). This is the *direct* local-saturation
  signal — distinguishes cap #2 from cap #3.
- **Skip rate** over the last N rows. A skip-rate spike often shows up before duration spikes
  do, especially when the failure mode is action-timeout (skip is fast-failing at the 30s
  Playwright wall).

**Coordinator response, in order of preference:**

- If skip-rate spikes or duration p75 climbs >1.5× baseline → scale workers down by 25%, wait
  2-3 minutes for equilibrium, re-measure.
- If wall-clock/Playwright-time ratio climbs >1.3× → same response; this signals local
  saturation specifically.
- If durations stay healthy after scale-down, hold. If they recover, *don't* immediately scale
  back up — wait a longer window before attempting growth.
- Never go below 1 worker; never exceed the user-set max.

**Ramp-up curve, not jump.**

Spawning N workers simultaneously creates two separate problems:
- **Cold-start storm** — N workers all hit PestPac login in the same second; the login service
  itself becomes the bottleneck.
- **Resource shock** — N Chromium instances all allocate RAM and JIT-compile in parallel,
  fighting for the same CPU during startup. Doing this in waves is faster than doing it all at
  once.

New behavior: workers spawn in waves of ~5-10 every 30 seconds, until either the max is
reached or one of the three signals says "stop adding." This is BUU's version of TCP slow
start. Auto and elastic both use the ramping curve.

**Auto's calculation becomes a ceiling recommendation, not a launch target.**

Today's Auto picks min(hardware, licenses) and *spawns that many* at once. Amended behavior:
Auto picks min(hardware, licenses) as the **ceiling**; coordinator ramps from a small starting
count (10-15) up toward that ceiling only as long as throughput keeps improving. The user sees
"Auto set max to 36, starting at 10, will ramp up if PestPac is keeping up" so they know what's
happening.

**Hardware calculation should include RAM, not just CPU cores.**

Each Chromium needs realistically ~300-400MB RAM under load. A 16-core / 16GB machine hits the
RAM wall well before the CPU wall. New formula for hardware cap (tunable, calibrated
empirically on Matthew's machine): `min(cpu_cores × 4, available_ram_gb × 3, 100)`. The hard
ceiling of 100 protects against a 256GB workstation Auto'ing into 700 workers and discovering
PestPac's session-limit and the local network stack the hard way.

**Why all of these in one item, not split into four?** Because they only make sense together.
A static ramp without signal-based scaling overshoots when PestPac is slow. Signal-based
scaling without a ramp produces the cold-start storm and resource shock. A hardware cap that
ignores RAM produces the local-machine crash. Worker scaling needs to be holistic.

**Open question: what's the right starting count when ramping?** Probably 10-15. Big enough
that the first 5 minutes of a run gets meaningful work done; small enough that even on a slow
PestPac day, the first wave doesn't trigger immediate scale-down.

**Not a static cap based on Playwright's 30s timer.** The 30s timer doesn't predict capacity;
it's just the window after which a stuck action gives up.

**23. Per-row total-time timeout ("row-timeout" skip reason).**

New step-config or pool-level setting: "abandon any row that takes longer than N seconds
total." Default off; opt-in at the pool launch screen with a sensible default (90 or 120
seconds for PestPac work).

Semantics:
- Timer starts at row-start.
- On every step boundary, check elapsed.
- If exceeded: stop the current action (signal to Playwright), mark row as `skip` with reason
  `row-timeout`, close the current PestPac page, request next batch. Worker **stays alive**,
  keeps its session, picks up next row. **Does not log out** — logging out per failed row would
  cost ~30s of overhead × hundreds of failures + license thrash. Only the session-dead path
  triggers re-login (existing re-auth handles that).
- Pairs with item 12 (per-step action timeout). Step timer is "stop a single action"; row
  timer is "stop the whole row." Both are useful; they don't replace each other.

The 2026-05-27 big run shows the value directly: skip rows took p99=160s, max=187s. A 90s
per-row cap would have saved roughly 60-100s per skip × 4,100 skips = 70-110 wall-clock minutes
of pure-burn time. Cheaper failure, faster overall run, faster turnaround for the rerun.

**24. Dup-row-counter cosmetic fix + reclaim double-record investigation.**

Two parts.

**(a) Counter display — show distinct rows as the headline, and EXPLAIN the extras instead of
hiding them (Matthew's 2026-05-28 request).** Today the counter shows raw journal-line count
over total, e.g. `9,867 / 9,854 done · 0 left` (big run) or `342 / 336 done · 0 left` (the
MISLABELED-336 void run). Those over-counts are real reclaim/pick-back-up events, not errors,
but the display is confusing.

Fix in two layers:
- **Headline = distinct rows.** Show `336 / 336 done · 0 left` (count distinct row numbers
  from the journal, not raw lines). This is the number that should match the source sheet.
- **Then surface the extras as a labeled breakdown**, e.g. a small secondary line:
  `+6 re-processed (4 handed back on worker close-down, 2 after crash)`. Don't bury them and
  don't alarm — they're normal elastic-pool behavior (a draining/closing worker hands its
  in-flight rows back, another worker re-runs them). The point is the user sees *why* the
  number was ever above the total, in plain language.

To classify the extras, the coordinator already knows the cause when it requeues a row:
  - **reclaim on graceful drain/scale-down** → label "handed back on worker close-down"
  - **catch-all reclaim in `proc.on('close')` after a non-zero exit / crash** → label "after
    crash"
  - **request-batch race / other** → label "re-processed (other)"
Tag each reclaim with its reason at requeue time, carry the reason into the journal/coordinator
state, and the status panel can tally them by category. This turns the confusing `342/336`
into `336/336 done · +6 re-processed (4 close-down, 2 crash)` — same underlying data, now
legible. (Depends on item 24(b) tagging reclaim reasons, and pairs with item 17's
crash/logout surfacing.)

**(b) Underlying behavior.** The 13 duplicate rows clustered in two groups (rows 1396-1399 and
rows 6902-6910) and showed mixed status patterns (`ok+skip`, `skip+ok`, `skip+skip`). That
shape suggests:
- A worker emitted `row-result` for a row, was then drained/crashed before the coordinator
  acknowledged it,
- The reclaim path (or a request-batch race) re-handed the same row to another worker, who
  attempted it again, possibly getting a different outcome.

Likely fix: only the **coordinator** writes the journal record, not workers directly. Workers
send `row-result` to coordinator; coordinator writes one record per row, applying a "first-
write-wins" or "ok-wins-over-skip" rule for duplicates. This makes the journal the
authoritative single source of truth and removes the racing-writers possibility.

Also: when reclaim hands a row back to the queue, the coordinator should *mark it as already-
attempted* and not re-record it if the new worker also writes. Or: don't reclaim rows that
already had a `row-result` emitted; only reclaim *unstarted* batch tail (the original v2.2.1
spec — possibly the implementation drifted to also reclaim in-flight rows).

Worth investigating during the runtime-unification work since the journal-writer pattern lives
in the worker template that's being unified.

**Related note: navigation-interrupted skip pattern (1,272 in the big run).**

Not its own item, but worth flagging for the runtime-unification work. 31% of the big run's
skips were `page.goto: Navigation to <URL> is interrupted by another navigation to <URL>` —
i.e. the runner fired the same `page.goto` twice and Playwright killed the first. Most likely
cause: the runner template's per-step retry loop fired the second `goto` before the first
finished. Should be eliminated naturally by the unification (one retry policy, one navigation
implementation), but verify during the unification work.

### Verification (the field-readback idea) — added 2026-05-28

**25. Verify pass — read back what the flow wrote, compare actual vs intended.**

**The problem this solves, with hard evidence.** Across multiple Void runs, BUU reported `skip`
on rows where the void *actually succeeded in PestPac*. The 2026-05-27 big run: a live Read
Lead Status check of the 4,100 "leftover" (skipped) rows found **2,834 were already `V`
(Voided)** — i.e. the journal under-reported successes by ~69% of the leftover set. Again at
small scale on 2026-05-28: of 19 reported skips on the 1,266-row run, Matthew manually checked
and **14 were already voided, only 5 genuinely open**. The runner's success/failure
determination is simply wrong on a consistent fraction of rows — the write lands in PestPac
(WonStatus set, CloseReason typed, Save submitted, PestPac persists it) but something
downstream (post-save dialog, navigation race, action timeout) makes the worker emit `skip`.
This is not an overload artifact — it reproduced cleanly at 5-15 workers with a clean journal.

**The mechanism.** A write step already encodes its own spec: "Select WonStatus = Void" knows
the selector (`WonStatus`) and the intended value (`Void`); "Type CloseReason = CLEANUP" knows
the field and value. So the verifier **derives its checks automatically from the flow's own
write steps** — no separate hand-built scrape flow per automation (which would be a maintenance
burden and would drift out of sync). For each Select/Type/Check step, the verifier knows
selector + intended value; it navigates to the row, reads each selector, and compares.

- All intended values present → the row **succeeded**; reclassify `skip`/`error` → `ok`.
- Any intended value missing/wrong → **genuine failure**; keep as failure AND record *which
  field(s)* didn't match. ("Failed: WonStatus still O" vs "Failed: CloseReason rejected" are
  different mechanisms — this is exactly the per-field signal that's been missing all along.)

**CRITICAL DESIGN POINT — the read must be a FRESH-NAVIGATE read, not a same-page inline read.**
Matthew proposed an alternative: scrape every field inline during the run, right after writing
it, instead of on failure. That is *worse*, for a subtle and decisive reason: an immediate
same-page readback reads the value you just typed into the DOM **before Save persists it**. It
confirms "the field accepted my input," NOT "PestPac kept it." Tonight's entire bug class is
rows where the field was set and the row still didn't end up correct (or did, but was
misreported) — an inline same-page read would show the typed value either way and give a
*false* pass on exactly the rows that lie. Only a read *after a fresh navigate* proves
persistence. So every flavor of this feature must re-navigate before reading. (This also means
inline-always is not even cheaper in the way it appears, because to be meaningful it would
*also* have to re-navigate — which is most of the cost.)

**Two modes, one engine:**

- **Verify-on-failure (default, always on).** On any `skip`/`error`, run the verify pass:
  fresh-navigate to the row, read back the intended fields, reclassify to `ok` if all match,
  else keep as failure with the mismatching field(s) named. Cost is paid only on the failing
  rows (a few hundred at most), which is where 100% of the diagnostic value is. Replaces the
  manual PestPac spot-checking Matthew did tonight, and — critically — prevents wasteful reruns
  of rows that were already done (tonight that was 2,834 rows in one run that would otherwise
  have been re-run).
- **Verify-every-row (opt-in toggle on the launch screen, off by default).** Same fresh-
  navigate-and-read engine, run on every row regardless of outcome. For paranoid / new-flow-
  validation runs where you want ground truth on all rows and knowingly accept the roughly
  doubled per-row time (navigate, write, save, re-navigate, read).

**Scope for v2.4 (tractable):** simple value-equality with basic normalization (trim
whitespace, case-insensitive). Verifiable step types only — Select, Type, Check (a field with a
readable value). Skips Click / Navigate / Save (an action has no stable readback; its effect is
verified indirectly via the field reads). If a flow has zero verifiable fields, the feature
no-ops for that flow.

**Deferred (the hard 20%):** fields PestPac reformats on save (dates, phone numbers, currency —
read-back won't string-match the input without normalization rules), multi-value fields,
conditionally-rendered fields. These likely need the Field Catalog (v2.5) to know what PestPac
does to each field. Don't block v2.4 on them.

**Relationship to other items:** this is the mechanism that makes **item 5 (skip-vs-error
reclassification)** actually *correct* — item 5 says "classify based on what happened," and the
verify pass is how you know what happened (read PestPac's real state, don't guess from the error
string). It also shrinks the load on **item 6 (diagnostic capture)**: a row that "failed" but
verifies as actually-succeeded needs no screenshot — diagnostic capture then fires only on the
genuine, verify-confirmed failures, a much smaller and higher-signal set.

**Open question:** when verify reclassifies a `skip` to `ok`, does the row's journal entry get
rewritten, or does the verify pass append a new authoritative record? Given item 24's "only the
coordinator writes the journal" direction, cleanest is: verify result goes to the coordinator,
coordinator writes the final authoritative status. Decide alongside item 24.

---

## DEFERRED

- **Field Catalog as observation store** — persistent record of fields BUU has seen on each
  page (selector / label / type / options / disabled-flag), populated by use, the foundation
  for required-field discovery without manual prep. Significant work; deferred to **v2.5**.
  Needs the unified runtime under it to be sane.
- **Parallel multi-flow runs** — two flows running concurrently sharing the pool. License-
  sharing and log-namespacing are real architecture problems. **v2.5**.
- **Smaller default batch size + clean-boundary worker retirement** — only if not addressed
  inside the runtime unification (#1). Lower priority now that v2.2.1's lossless reclaim makes
  drops harmless.
- **PestPac API integration / hybrid mode** — the Void debugging session made the case for it,
  but the right place is a **v3.0 branch**, not a v2.x sub-release. The browser automation
  and the API path have different operational models and shouldn't be glued together inside the
  v2.x line.

---

## OPEN QUESTIONS

- **Unified runtime — what stays in `main.js`, what moves to a dedicated `runtime/` module?**
  Step engines today are template strings (so they can be serialized to a worker child process
  as a runner script). The unified engine needs the same shape — a single module that's
  consumable as a template *and* as a direct callable. Worth a small spike before committing.
- **Schedule storage format.** Plain JSON files in `schedules/` keyed by id, or a single
  registry file? Plain files easier to inspect, single file easier to lock atomically.
- **Item 5 (skip-vs-error) — flow author's choice or always-on?** I.e. when PestPac shows a
  validation dialog, is that always an error, or should some configurable "expected" dialogs
  count as skip-equivalent? Probably always error, with the user telling the system "this is
  expected" via a different mechanism if needed.
- **Spreadsheet-free flow logging.** Today every run produces a per-row Excel log. A flow
  with no rows produces what — a one-row "summary only" sheet, a different file shape, just
  the merged journal? Probably the merged journal is enough; no per-row sheet.

---

## REPO HOUSEKEEPING / FILE CLEANUP (added 2026-05-28)

Matthew asked for a full pass on file organization and bloat, not just the docs. This is a
standalone chore — NOT gated behind the runtime unification, can be done any time, but should
be done as its own commit (or left uncommitted if it only touches untracked files). Verified
inventory as of 2026-05-28 below.

### Disk bloat (excl node_modules/.git) — all the big stuff is UNTRACKED, safe to delete

| Size | Path | What | Action |
|---|---|---|---|
| 5.7 GB | `dist/` | electron-builder output (installers per version, 435 files) | untracked — safe to wipe; rebuilt on demand by `npm run build` |
| 513 MB | `upcoming/` | working data; mostly the 5 "Cancel List for Import" files (~450MB, three 111-115MB VERIFIED/FUZZY/MATCHED intermediates of one dataset) | review; keep final, delete intermediates |
| 406 MB | `chromium/` | bundled browser for Playwright | untracked — needed at runtime; leave unless stale copies |
| 34 MB | `API DOCUMENTATION/` | PestPac API spec + SDKs (3436 files) | keep (v3.0 needs it); confirm `portal-prose/` API key still gitignored |
| 1 MB | `_asar-installed/` | leftover unpack artifact | untracked — safe to delete |

`dist/` alone is 5.7GB and rebuildable — clearing it reclaims almost all the bloat.

### Loose root cruft to remove (verified untracked unless noted)

- Build logs: `build-buu2.log`, `build-buu2-201/202/202b/202c/202d/202e/202f/210/211/212/220.log`,
  `build-buu2-v2.log`, `build-legacy.log` — all untracked, all stale, delete.
- `_launch-err.log`, `_launch-out.log` — untracked scratch, delete.
- `BUU-v1.2.5-DESIGN.md.bak`, `BUU-PROJECT-HANDOFF.md.bak` — untracked editor backups, delete
  (the real files are now in `docs/design/` and root respectively).
- `error-log.txt` — **TRACKED**; decide whether it belongs in the repo at all (probably not —
  remove from tracking and gitignore).
- `_skip-analysis.json` — **TRACKED**; a scratch artifact from the void analysis. Probably
  should be untracked + gitignored.
- `~$*.xlsx` files anywhere (e.g. in `upcoming/results/`) — Excel lock/temp files; delete when
  the workbook is closed.

### .gitignore additions to prevent re-bloat

Add (verify each isn't already covered): `dist/`, `_asar-installed/`, `build-*.log`,
`_launch-*.log`, `*.bak`, `~$*`, `error-log.txt`, `_skip-analysis.json`. `chromium/` and
`node_modules/` should already be ignored — confirm.

### Working-data organization (`upcoming/`)

The void effort generated many ad-hoc spreadsheets with inconsistent placement — some in
`upcoming/`, some in `upcoming/results/`, some in `upcoming/Finished/`, and files get moved
around by hand between runs (which already bit us twice tonight when a sheet wasn't where it
was written). Proposed convention:
- `upcoming/` — **inputs only**: sheets queued to be run.
- `upcoming/results/` — **outputs only**: what a flow wrote, timestamped (already the naming
  convention: `MMDDYYYY_HHMM_<flow> · <source>.xlsx`).
- `upcoming/Finished/` — **archive**: runs that are fully done and reconciled.
- Stop hand-moving files mid-process; if a run needs an input that's an earlier output, copy it
  into `upcoming/` explicitly rather than moving it, so the output record stays put.

This convention also feeds BUU itself: items 19-21 (spreadsheet-free flows, sequential
queueing, scheduled runs) will be cleaner if input/output locations are predictable.

### scripts/ folder

64 files, ~0.2MB — many are one-off diagnostic scripts from the void debugging
(`_forensics.js`, `_diag-*.js`, `_build-*.js`, `_dump-*.js`, etc.). Low disk impact so not
urgent, but worth a pass: keep the reusable validators (`_test-coordinator.js`,
`_check-html-js.js`, `_validate-*.js`) and the genuinely reusable diagnostics; archive the
one-shot build/rerun scripts into a `scripts/_archive/` subfolder so the useful ones are easy
to find.

### Already done (2026-05-28)

- Design docs moved to `docs/design/` (8 files, via `git mv` — history preserved).
- Release notes moved to `docs/release-notes/` (11 files).
- Root now holds only navigational docs (`DESIGN-INDEX.md`, `BUU-PROJECT-HANDOFF.md`,
  `README.md`, `GITHUB_GUIDE.md`, `POST-PUSH-NOTES.md`).
- These moves are staged but NOT committed (per the no-unattended-commit rule). Commit message
  when ready: "Reorganize docs into docs/design and docs/release-notes".
- NOTE: there are pre-existing staged `skip-analysis/*` deletions sitting in git status,
  unrelated to this cleanup — don't let them ride along into an unrelated commit by accident.

## NOTES FOR THE NEXT CLAUDE SESSION

- The 2026-05-27 session (this one) was where this design was locked. Read this doc for the
  agenda; read `BUU-PROJECT-HANDOFF.md` Section 0 for current overall state.
- Matthew explicitly said: **runtime unification first, by itself**, not mixed with feature
  work. Don't let scope creep break that.
- **The Void debugging session that motivated several items is real-world ground truth.** When
  in doubt on a design question, ask "would this have shortened that session?" The dialog
  checkboxes (item 2), diagnostic capture (item 6), and state-aware selectors (item 10) would
  each have saved real hours. They earned their slot.
- This is BUU 2.0, not Legacy. Target branch `v2.0.0-elastic`. Don't touch Legacy.
