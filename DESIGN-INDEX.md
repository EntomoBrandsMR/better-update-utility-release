# BUU DESIGN INDEX

**Purpose:** Single entry point for active design work. Read this first.
**Last updated:** 2026-05-01 (after v1.2.3 ship and BUUA direction lock).

---

## What's where

| Document | Status | Read this when |
|---|---|---|
| **BUU-v1.2.4-DESIGN.md** | Locked design, ready to implement | Working on the next BUU release (unify-runner) |
| **BUUA-DESIGN.md** | Parking lot, not yet a design spec | Discussing the v2.0 fork or anything automation-related |
| **BUU-PROJECT-HANDOFF.md** | Mostly stale on roadmap, still valid for architecture facts | Need PestPac selectors, runner template details, build commands, file paths |

---

## Project status snapshot (2026-05-01)

- **v1.2.3 SHIPPED.** Released to GitHub today. First production run completed successfully (982 rows). All v1.2.3 fixes confirmed working: log file created up front, checkpoint v2 written per-row, heartbeats reach the UI, live counters update, run guard works.
- **v1.2.4 is the next BUU release.** Locked design in `BUU-v1.2.4-DESIGN.md`. Implementation hasn't started.
- **After v1.2.4 ships, the repo forks.** BUU goes feature-frozen forever (bug fixes only). Automation-everything moves to a new product (working name: BUUA / v2.0). See `BUUA-DESIGN.md`.

---

## v1.2.4 — the next thing to build

**One-line summary:** Unify "Live Dry Run" and "Run" into a single mode-aware runner. Eliminate the two-codepath design that caused today's confusion.

**Three start modes** (selectable via dropdown above Run button):
1. **Step through each step** *(default)* — pause BEFORE every action, show preview (rendered value, resolved selector). User clicks Next-step.
2. **Step through rows** — pause after each completed row.
3. **Run all** — fire and forget (today's behavior).

User can switch from any verification mode to "Run all" mid-run. **All modes write logs and checkpoints** — no work is wasted on verification rows. The run is always real, always resumable.

**Removed in v1.2.4:**
- `start-live-dryrun` IPC handler
- `dryrun-event` channel
- `buildDryRunner` and `buu-dryrun-*.js` temp file pattern
- The Build/Test page's "Live Dry Run" button (selector probing replaced with one-shot Playwright call)

**Five design questions all resolved.** See Section 5 of `BUU-v1.2.4-DESIGN.md`.

**Implementation order** (Section 4 of `BUU-v1.2.4-DESIGN.md`):
1. Refactor `buildRunner` for pause states (stdin command reader, mode state machine)
2. Add `run-control` IPC handler
3. Add start-mode dropdown to Run page
4. Add in-run pause controls
5. Validate v1.2.3 scenarios still work
6. Replace Build/Test selector probe with inline Playwright
7. Remove dry-run code
8. Smoke test
9. Ship

---

## BUUA — what comes after v1.2.4

**One-line summary:** A new product, forked from BUU v1.2.4, focused on unattended automation at scale.

**Headline differences from BUU:**
- Multi-runner concurrency (single process, many runners — built in from day one)
- Job queue with folder-based lifecycle (jobs/unstarted, queued, running, done, failed)
- Headless-by-default, designed to run off-site (separate machine / VM / cloud)
- Notification system for unattended operation (email first, push next, mobile companion eventually)
- No verification UI, no Live Dry Run, no Build/Test page — flows are imported from BUU

**What stays the same:** flow JSON format, profile credential storage pattern (keytar + AES fallback), checkpoint v2 format, Excel log format, runner template approach, PestPac selectors, exceljs streaming.

**Strategic constraint:** Multi-runner does NOT belong in v1.2.4. BUU v1.2.4 stays focused on the unify-runner work. Multi-runner is BUUA's first feature, not BUU's last. This boundary is deliberate.

See `BUUA-DESIGN.md` for the parking lot of ideas, open questions, and proposed milestones.

---

## What this index is NOT

- It's NOT a substitute for reading the actual design docs
- It's NOT a project roadmap or schedule
- It's NOT the architecture handoff (that's `BUU-PROJECT-HANDOFF.md`)

**For a new Claude session:**
1. Read this index first (you're here)
2. Read `BUU-v1.2.4-DESIGN.md` if working on v1.2.4
3. Read `BUUA-DESIGN.md` if discussing or working on BUUA
4. Read `BUU-PROJECT-HANDOFF.md` for architecture, selectors, build commands, environment details
5. Ask Matthew clarifying questions before assuming anything

---

## Maintenance

**This index needs updating when:**
- A new design doc is added → add a row to "What's where"
- v1.2.4 ships → update status snapshot
- BUUA-DESIGN.md graduates from parking lot to design spec → update its row
- Strategic direction changes → update sections 2-4

**Last edited by:** Claude (work account), 2026-05-01.
