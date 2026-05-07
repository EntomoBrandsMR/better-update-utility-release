# BUU DESIGN INDEX

**Purpose:** Single entry point for active design work. Read this first.
**Last updated:** 2026-05-07 (post v1.2.7 ship; v1.2.8 design doc renumbered from v1.2.7).

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

> **Strategic note (2026-05-07):** The "BUU enters bug-fix mode after v1.2.5; BUUA takes over feature work" plan from earlier is shelved. BUU continues to grow features (v1.2.8 is a feature release). BUUA work remains parked pending WorkWave API authentication unblock. See `BUU-v1.2.8-DESIGN.md` Section 1 strategic note.

---

## Project status snapshot (2026-05-07, post-v1.2.7-ship)

- **v1.2.3 SHIPPED 2026-05-01** — Icon, run guards, heartbeat, live counters, resume-on-launch, log retries.
- **v1.2.4 SHIPPED 2026-05-01** — Unified runner with start-mode picker (step / step-row / run-all).
- **v1.2.5 SHIPPED** — Resilience pack: configurable retry, circuit breaker, network-aware retry, re-auth, retry-failed-rows, log enrichment, default `errHandle` flipped from `stop` to `retry`.
- **v1.2.6 SHIPPED** — Iframe-aware selectors. Click-step debug checkbox shipped as permanent feature.
- **v1.2.7 SHIPPED 2026-05-07** — Dialog handler crash fix. Single-issue hotfix; `page.once('dialog')` listener no longer leaks across rows when no dialog actually fires.
- **v1.2.8 is the next BUU release.** Drafting in `BUU-v1.2.8-DESIGN.md`. Setup-and-teardown flows (three-phase pipeline). Originally numbered v1.2.7; renumbered to v1.2.8 on 2026-05-07 when the dialog hotfix took the v1.2.7 slot. Estimated 15-20 hours; not yet locked, not yet started.
- **BUU is no longer feature-frozen post-v1.2.5.** That earlier plan is shelved. BUUA work remains parked pending WorkWave API access.

---

## v1.2.8 — the next thing to build

**One-line summary:** Setup-and-teardown flows. Three-phase pipeline: setup-once → main-per-row → teardown-once.

The motivating use case is the chargeback workflow, which needs to create a batch once at the start, post service orders into it per row, then release the batch once at the end. Today's per-row-only flow model can't express the create-once / release-once envelope. v1.2.8 adds flow composition: a per-row flow can declare a setup flow and a teardown flow; all three phases share one logged-in browser session.

Estimated effort: 15-20 hours. Design doc at `BUU-v1.2.8-DESIGN.md` (still drafting, not yet locked). Originally numbered v1.2.7; renumbered when the dialog hotfix took the v1.2.7 slot on 2026-05-07.

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

**Current state (2026-05-07):** Parked. The strategic plan to fork BUU into a feature-frozen branch and have BUUA take over is shelved. BUU continues to grow features (v1.2.8 is a feature release for setup/teardown). BUUA work is awaiting WorkWave API authentication unblock — see SESSION PICKUP NOTE above. When the API access lands, the BUUA-DESIGN.md sections flagged stale (2.1, 2.5, 2.9, 2.10) get rewritten with probe data.

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
