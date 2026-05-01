# BUUA DESIGN — BUU Automated (v2.0)

**Status:** Early planning. To begin AFTER BUU v1.2.4 ships and is validated.
**Working name:** BUUA / BUU Automated / v2.0 — final branding TBD.
**Author:** Outgoing Claude (work account, 2026-05-01), based on Matthew's verbal direction.

---

## 1. WHAT BUUA IS

A separate product, forked from BUU v1.2.4, focused entirely on **unattended automation at scale**. Where BUU is a manual-operator tool for one-off runs, BUUA is a queue-driven, multi-runner, headless-by-default automation system. Designed to run off-site (separate machine, VM, or cloud) with no UI babysitting.

### 1.1 The fork point

- BUU v1.2.4 ships as the "feature complete" manual tool — maintained for bug fixes only afterward.
- BUUA forks from v1.2.4's codebase as its starting point.
- After fork, the two products evolve independently. **No more cross-pollination.** A bug fix in BUU may or may not apply to BUUA depending on whether the underlying code still exists. A feature in BUUA does not backport to BUU.

### 1.2 Why a fork instead of a major version bump

The architectural shifts are too large for a single codebase to gracefully support both modes:
- BUU is interactive-first; BUUA is headless-first.
- BUU has Live Dry Run / step-through / verification UI (preserved by v1.2.4); BUUA has none of that.
- BUU is one-runner; BUUA is many-runners.
- BUU runs on the operator's desktop; BUUA runs unattended off-site.
- BUU has a build/test page for selector probing; BUUA receives flow definitions from BUU exports and runs them.

Trying to support both in one codebase would mean every new BUUA feature has to also work in BUU's manual mode — slowing down the automation work — or BUU's manual code has to constantly skip the automation features — bloating the code. The fork keeps each product focused.

---

## 2. CORE BUUA FEATURES (PARKING LOT — NOT FINAL DESIGN)

These are the ideas captured so far. Each will need its own design pass before code.

### 2.1 Multi-runner concurrency

- Multiple browser automations running simultaneously inside ONE BUUA process.
- No cross-process file locking needed — single process, internal state, fan-out events.
- Configurable cap (the original v1.3.0 plan said 3; revisit for BUUA).
- Slot reservation model: keep one slot for "manual / urgent" overrides? TBD.
- Built into the architecture from day one — not bolted on.

### 2.2 Job queue and folder-based lifecycle

Inherited from the original handoff Section 7 v1.3.0 plan, but now scoped to BUUA:

```
jobs/unstarted/   ← dropped here
jobs/queued/      ← validated, queued
jobs/running/     ← runner processing (checkpoint.json appears here)
jobs/done/        ← completed (log.xlsx appears here)
jobs/failed/      ← errored beyond retry, with subfolders by reason
```

- Folders ARE the persistence — no separate `queues.json`.
- Crash recovery: orphan in `running/` → resume on next launch.
- Pre-flight validation at submission, not runtime.
- Auto-rejection emails to BUU admin on validation failure.

### 2.3 Job submission — multiple channels

- **Folder drop** (v1 of BUUA): files arrive in `jobs/unstarted/<date>_<flow>_<file>/` as job folders containing `workbook.xlsx` + `job.json` + `flow.json`.
- **Email pickup** (v1 or v2): BUUA watches an inbox. Email subject carries metadata: `[BUU] flow=invoiceDivision priority=high urgent=yes`. Attachment downloaded into `unstarted/`.
- **Mobile companion app** (v2+): submit jobs from phone, view queue status, receive notifications.

### 2.4 Priority and queue logic

- **Priority queue** + **Non-priority queue**.
- Sort within queue: priority (urgent → high → medium → low → unmarked), then size-asc within tier (smaller jobs jump ahead of same-priority larger jobs).
- "Size" = `rows × steps = actions`.
- **Line-jump default** — high-priority job starts when a slot opens; running jobs aren't interrupted.
- **Urgent override** — `urgent: true` plus no slot available → preempt lowest-priority running job (current row finishes, checkpoint saves, slot frees, urgent runs, paused job resumes).
- Preemption is expensive (~30-60 sec overhead). Use sparingly.

### 2.5 Hybrid flow embedding

Spreadsheet metadata in vertical A:B layout:
```
A1: priority    B1: high
A2: flow        B2: invoiceDivision
A3: profile     B3: overflow
A4: urgent      B4: no
A5: flow_def    B5: { full flow JSON if needed }     ← OPTIONAL
A6: (blank — separator)
A7: <data column headers>
```

If `flow_def` (B5) present → use it. Otherwise look up `flow` (B2) in BUUA's local flow library. Lets you submit a portable archive (with embedded flow_def) OR a thin reference (just `flow` name).

### 2.6 Notification system

The "eyes and ears" for unattended operation. Configurable per-event:

**Events that should trigger notifications:**
- Run completed successfully
- Run failed (fatal error)
- Run hit error threshold (e.g., >5% errors in last N rows)
- Resume modal needs attention on launch (orphan checkpoint)
- Queue paused / stalled
- Approaching license/credit limits (if applicable)

**Channels — easiest to hardest:**
1. **Email** — easiest. SMTP config, nodemailer module. Works to any phone via carrier email-to-SMS gateway as a fallback.
2. **Push via Pushover or ntfy.sh** — slightly more involved, requires account setup.
3. **SMS via Twilio** — requires paid account, best UX for "look at this NOW."
4. **Phone call via Twilio Voice** — heaviest weapon, save for catastrophic failures.
5. **Mobile companion app** — see below.

**Suggested implementation order:** ship email-first in v2.0. Add Pushover/ntfy in v2.1. SMS/phone for v2.2+ if the email-and-push combo isn't catching attention fast enough. Mobile app is its own multi-month project.

### 2.7 Mobile companion app

Floated as a possibility in this session, not yet committed. Would provide:
- Real-time queue status (what's running, what's queued, what failed)
- Live notifications (push, with action buttons)
- Job submission from phone (upload spreadsheet, set metadata)
- Run history and logs
- Remote start/stop/pause

**Implementation tradeoffs:**
- Native (Swift + Kotlin): best UX, most work
- React Native or Flutter: one codebase for iOS+Android, decent UX
- PWA (web app installed to home screen): cheapest, push notifications work on Android well, iOS push limited
- Just a webhook + 3rd-party app like ntfy: bare minimum, most-flexible-least-work

For BUUA v2.0, suggest **defer mobile app entirely**. Ship email + Pushover first. If those don't satisfy the "I need to know NOW" need, then evaluate mobile. The companion app is a tar pit if started prematurely.

### 2.8 Off-site / headless deployment

- BUUA is designed to run on a separate machine — server, VM, or cloud instance.
- No GUI required for normal operation. Optional admin web UI for queue status / log access / job submission.
- Headless chromium by default (BUU's bundled chromium continues to work; just always set `headless: true`).
- Profile credentials stored on the BUUA host. Same keytar/AES-256 fallback pattern as BUU.

**Deployment options to evaluate:**
- Always-on Windows machine at office (cheap, you already have hardware probably)
- Mini-PC / NUC dedicated to BUUA (~$300-500 one-time)
- Cloud Windows VM (~$50-100/mo, true off-site, no maintenance)
- Linux container (would need to swap chromium binary, smaller cost, no Windows-specific deps)

### 2.9 What stays from BUU

- Flow definition format (JSON, same schema)
- Profile / credential storage pattern (keytar + AES-256 fallback)
- Spreadsheet streaming via exceljs (handles 480k+ rows already proven)
- Checkpoint format (v2 — full context, resumable)
- Excel log format (BUU-log-YYYY-MM-DD-runId.xlsx with Summary sheet)
- The runner template pattern (rendered template literal → spawned Node process via Playwright)
- PestPac-specific selectors (data-testid stable values from Section 3.2 of handoff)
- Paste-HTML auto-selector workflow (in BUU only — BUUA receives flows already built)

### 2.10 What's removed in BUUA

- All "Live Dry Run" code (v1.2.4 already removes this conceptually — BUUA inherits clean)
- Step-through-each-step verification mode (BUU keeps it, BUUA doesn't)
- Step-through-rows mode
- All visible-browser modes (everything headless)
- Build/Test page (selector probing happens in BUU; flows export to BUUA)
- Single-instance lock (BUUA inherently supports concurrent runners inside one process)
- Run guard's `MAX_CONCURRENT_RUNS = 1` ceiling
- Most of the Run page UI as it exists today — replaced by an admin/queue dashboard

---

## 3. OPEN QUESTIONS FOR BUUA

These DON'T need answers right now. Capturing for later when we start designing in earnest:

1. **Does BUUA share flow definitions with BUU?** Two options: (a) BUUA imports BUU-built flows from a shared location (OneDrive / network drive), (b) BUU "exports" a flow to BUUA via some publish mechanism.
2. **Can BUUA edit flows, or is it read-only?** Read-only is simpler — edit always happens in BUU, BUUA consumes.
3. **Multiple PestPac credentials per BUUA install?** Original handoff said 3 dedicated PestPac users for queue isolation. Still the right move?
4. **Authentication for the admin UI?** If BUUA has a web dashboard, who can access it?
5. **What does "feature freeze" look like for BUU?** Bug fixes only — but what counts as a bug fix? Cosmetic UI improvements? Selector adjustments when PestPac changes?
6. **Branding.** Is "BUUA" the actual product name? "BUU Automated" reads better. Marketing-wise, is this an internal tool or something Entomo Brands might license to other PestPac users?
7. **Update mechanism.** BUUA is server-style — pulling auto-updates on launch like BUU does (v1.2.3 pattern) might not be appropriate. Manual update / scheduled maintenance window might be safer.
8. **Logging at scale.** BUU's per-run BUU-log-*.xlsx works fine for one run at a time. With 3+ concurrent runners doing thousands of runs over weeks, this might need to be a database (sqlite locally? Postgres if we go cloud?).

---

## 4. NEXT STEPS (when work begins)

1. **Wait for v1.2.4 to ship.** No BUUA work starts until BUU v1.2.4 is the proven manual baseline.
2. **Fork the repo.** New name, new git history starting from v1.2.4. Move repo URLs, update auto-update endpoints.
3. **First design milestone:** the multi-runner core. Strip dry-run, step-through, build/test page. Convert run guard to multi-runner. Validate that one BUUA can run 3+ automations simultaneously without breaking.
4. **Second milestone:** folder-based job queue. Drop a job folder, BUUA picks it up, runs it, moves to done/. No queue priority logic yet — just FIFO.
5. **Third milestone:** queue priority + line-jumping + urgent preemption.
6. **Fourth milestone:** notifications (email first).
7. **Fifth milestone:** off-site deployment (move BUUA off Matthew's machine).
8. **Later milestones:** mobile companion app, advanced notifications, queue dashboard.

Each milestone is its own ship-able version. v2.0 is roughly milestones 1-4. v2.1 is milestone 5. v2.2+ is everything else.

---

## 5. END

This document is a parking lot, not a design spec. Use it to remember WHAT we want to build. Each section will need a proper design pass — comparable to what `BUU-v1.2.4-DESIGN.md` is for v1.2.4 — before code starts.

Major design discussions captured here happened during the 2026-05-01 v1.2.3 ship session, while the production run was processing 982 rows in the background. Decisions reached:
- Fork after v1.2.4
- Multi-runner is BUUA from day one (not bolted onto v1.2.4)
- BUU v1.2.4 stays focused on the unify-runner work, ships clean
- Notifications, off-site, and mobile companion are BUUA scope
- BUU and BUUA evolve independently after fork
