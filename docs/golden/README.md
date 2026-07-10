# GOLDEN BASELINE — captured 2026-07-10 on BUU 2.2.9 (repo tip = v2.2.9 + docs only)

## ⚠️ DO NOT RERUN Test.xlsx AS-IS
The URL column was drag-filled in Excel and INCREMENTED LocationID across 10 REAL
locations (1263957-1263966). The 2026-07-10 baseline run deleted real setups/renewals
and auto-accepted open-order cancellations (recovered by hand same day).
Before any checkpoint rerun:
1. Matthew provides the ONE safe test LocationID; rebuild all 10 URLs on it.
2. Change flow step 17 matchText BILLING -> BALFWD (only ever match the test setup).
Neither change affects per-row status comparability.

## Files
- baseline-2.2.9.jsonl / .meta.json — pool journal + meta (pool1783708422816)
- Test Flow.json — flow as-run (saved copy, matches meta.flowSteps)
- Test.xlsx — sheet as-run (poisoned URLs; reference only)
## Result: 10/10 rows ok. Rows 5 & 10 = "ok (retry)".
Retry cause: findByText BILLING matched a REAL setup; delete fired PestPac's chained
"cancel all open Orders" confirm; auto-accept landed off-page; waitFor butHistoryShow
hit the 30s selectorTimeout; retry gate swallowed the error silently (no reason logged
— R1 poster child) and reran the row.

## Compare rules (scripts/_compare-golden.js)
- PASS = per-row terminal status matches, after normalizing "ok (retry)" -> "ok".
- Retry deltas reported separately (informational, not failure).
- Dialog (t:"dlg") sequences reported as diff but NOT failure: baseline dialogs
  reflect real-account collisions; corrected-sheet reruns will differ legitimately.
- Post-teardown expected diffs (document before each checkpoint run): skip/batch
  fields removed; Handle Dialog steps auto-migrated; status vocabulary ok|error only.

## Secondary reference
Run was step-started then Released (startMode=step, 1 worker) — doubles as the
D8 step-then-Release acceptance reference.
