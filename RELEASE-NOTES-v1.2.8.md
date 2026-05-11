# v1.2.8 — Setup and teardown flows

The biggest architectural change since v1.2.0: flows can now have setup (runs once at the start) and teardown (runs once at the end) phases. The motivating use case is the chargeback workflow — you need to create a PestPac batch once, post all the orders into it, then release the batch once — which the old per-row-only run model couldn't express.

(Renumbered from v1.2.7 mid-design because v1.2.7 shipped from another branch as a dialog-handler crash hotfix. v1.2.8 is the first version with the three-phase pipeline.)

## What this means in practice

Every flow now has a **runMode** property:

- **Per-row flow** (the existing behavior): loops over a spreadsheet, runs the steps once per row. This is what every pre-1.2.8 flow is, and they continue to work unchanged.
- **Once-flow** (new): a single set of steps with no spreadsheet binding. Cannot reference column tokens like `{{Account_Code}}`; can use new **run-context tokens**: `{{TODAY}}`, `{{RUNID}}`, `{{PROFILE_USERNAME}}`.

A per-row flow can attach up to one setup flow and one teardown flow, both of which must be once-flows. When that per-row flow runs, the pipeline is:

```
login -> setup (once) -> main (per-row loop) -> teardown (once) -> logout
```

All three phases share one logged-in browser session — no re-auth between them.

## What's new in the UI

**Build steps page** has a new "Flow type" card at the top:
- Radio: per-row flow vs once-flow
- Dropdowns: Setup flow / Teardown flow (populated from your saved once-flows)
- Notice banner when you switch to once-flow mode

**Run progress** panel now shows a phase indicator (Setup -> Main -> Teardown pips) when the flow has setup or teardown attached. Pips state-transition as each phase runs.

**Resume modal** now handles three new scenarios:
- Setup failed at step N -> Resume re-runs setup from the start (make sure your setup is idempotent)
- Teardown failed or didn't run -> New "Run teardown" button that runs ONLY teardown
- Setup or teardown stopped by user -> Same options as above, labeled differently

## What's new in the Excel log

New **Phases** sheet (only present when a run had setup or teardown) summarizing each phase: status, duration, step count, failure details. The Summary sheet's "Stopped reason" cell now also surfaces setup/teardown failures.

## What's new in checkpoints

Checkpoints bumped from schema v2 to v3 with two new fields: `flowMeta` (snapshot of runMode + setup/teardown refs) and `phaseProgress` (tracks which phases completed). v2 checkpoints continue to be loadable with synthesized defaults.

## Idempotency note

Setup and teardown flows can be re-run on resume. Idempotency is the flow author's responsibility — if your setup creates a record and the run fails partway, resuming will re-run setup and create another one. Either make setup idempotent (check-if-exists pattern) or be aware that resumes can leave duplicates.

## What stays unchanged

- All existing flows load and save unchanged. They auto-upgrade to v1.1 format with `runMode: 'per-row'` on first save.
- Per-row tokens, retry, breaker, network-aware retry, re-auth, retry-failed, error log enrichment all work as before.
- Verification modes (step / step-row) work across all three phases.

## Migration

No migration required. v1.0 files are still readable. First save in v1.2.8 upgrades to v1.1 silently.
