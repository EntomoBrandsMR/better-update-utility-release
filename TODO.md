# BUU TODO — consolidated master list

**Created 2026-07-04** by merging three sources: the 27-item chat agenda (captured 2026-07-03,
never previously written to disk), the v2.4.0 design doc's 25-item locked agenda
(`docs/design/BUU-v2.4.0-DESIGN.md`), and `docs/KNOWN-BUGS.md`. Overlaps deduped; each item
notes its origin (C# = chat item, D# = v2.4.0 design item, KB# = known bug).
Current shipped: **v2.2.9** (If-click step).

---

## TOP PRIORITY (next release candidates)

1. **Dynamic / adaptive worker scaling** (C10 + C27 + D22 — same umbrella).
   Three caps (license / PestPac response / local RAM+CPU), three signals (duration p75,
   wall-vs-Playwright time ratio, skip rate), ramped wave startup, Auto = ceiling not launch
   target, hardware formula includes RAM. Evidence: 2,823 `page.goto: Page crashed` renderer
   OOMs on the ATI run; 119-worker near-crash 2026-05-27. Full spec in D22.
2. **Reauth doesn't work on long runs** (C25). 3,557 rows failed through on a session drop
   without recovery. Same session-state machine as C24 (stop-hang re-login).
3. **Logging rework** (C11 + C15 + C16 + D24 + D4 — one umbrella).
   - Journal must exist and be usable on partial/aborted runs, not only clean finishes (C11).
   - Per-row terminal logging must be atomic — rows 568-570 vanished with no record (C11).
   - Only the coordinator writes the journal; workers emit row-results; first-write/ok-wins
     dedup rules; reclaim reasons tagged and surfaced in the counter (D24 a+b).
   - Column-token matcher false mismatch: trim + case-insensitivity (C15).
   - Dialog text always logged on the triggering row (D4).
   - Run Log tab: rework or cut as part of this (C16).
   - Breaker/dump bug: coordinator marks remaining rows error without attempting them after a
     breaker trip — fold the fix in here.

## FIRM BUGS

4. **Lingering BUU processes after a run** (KB1). Blocks update prompt + builds. Fix: full
   worker teardown on run end + app quit; `second-instance` handler re-checks updates.
   Partial mitigation shipped v2.2.9: installer.nsh taskkills before install.
5. **On stop, last worker hangs forever, often re-logs-in** (C24). Burns a license. Same
   drain machinery as restart (C22) and scale-down retirement (D22) — one design, three
   consumers.
6. **verifyAfterAction false-mismatch** (KB3). Reads post-save DOM after navigation destroyed
   it. Fix: verify must FRESH-NAVIGATE and read (D25 has the full verify-pass design —
   verify-on-failure default, verify-every-row opt-in, reclassify false skips).
7. **Step-through mode spawns extra live workers / burns licenses** (KB4).
8. **Phantom "delete this note?" confirm during add-note flows** (KB5).
9. **Overlay covers Add Profile modal** (KB6). Overlays should default display:none.
10. **Frankware runs invoke PestPac-only license/reauth machinery** (KB2). Gate on
    `profile.platform === 'pestpac'`; Auto skips license read for Frankware.
11. **Run-settings number inputs flaky** (C12).
12. **No right-click paste anywhere** (C13). Likely missing Electron context menu.

## FIRM FEATURES (small/medium)

13. **TODAY date token** (C1). Runtime-evaluated, mm/dd/yyyy, distinct chip color, usable in
    any value field. ({{TODAY}} exists for once-flows since v1.2.8 — extend to everywhere.)
14. **Popup auto-accept / auto-decline checkboxes on every action step** (C2 + D2 — SAME
    item). Listener armed just before the action, handles all dialogs in the window,
    harmless on zero dialogs. Then remove the standalone Handle Dialog step (D3, migration
    on load). Grows into per-dialog routing later — don't build the rules editor yet.
15. **Click step: wait-for-element timeout override** (C3) and **wait-until-enabled** (C4 +
    D10 state-aware selectors + D12 per-step action timeout). One cluster: the hardcoded 30s
    pool-worker element wait causes false errors on slow PestPac saves (flagged for v2.2.10
    along with pressAfter on type steps).
16. **Generic Wait step type** (D11). Selector + state + timeout.
17. **URL-change / navigation-complete waitFor modes on Click** (D8 + D9).
18. **Flows + logs move inside the BUU folder** (C7). Updater-wipe risk flagged; decision
    stands.
19. **Installer defaults to Desktop** (C8).
20. **Remove failure limit** (C9).
21. **Build-step page shows active flow name** (C14). Part of sidebar work (C17).
22. **Sidebar consolidation umbrella** (C17): all controls to left sidebar — flow name (C14),
    single Run button (C18 = D13 Run Pool is the only Run), run-progress-by-step (C23),
    Save Flow, worker-pool settings.
23. **Pool settings + start mode save with the flow** (C19). Restart bug (C22) proved it.
24. **Pool defaults** (C20): workers 1, batch 5, auto-scale on, every(min) 2, diagnostic off,
    verify off.
25. **Remove the "no URL" code + prompt** (C26). Open sub-question: prompt only or all URL
    handling?
26. **Step move-up/move-down buttons** (D14). Small, rides along anywhere.
27. **Hot-reload flow edits between runs** (D15) + "flow last saved" timestamp on launch.
28. **pressAfter param on type steps** (flagged for v2.2.10).

## BIG ROCKS (v2.4.0 core — see docs/design/BUU-v2.4.0-DESIGN.md for full specs)

29. **Runtime unification** (D1). LARGEST ITEM — do first, by itself. One step engine, one
    login, one logout, one dialog handler across single-runner/pool-worker/sweeper.
    (v2.2.2 dedup'd loginToPestPac; the rest remains.)
30. **Verify pass** (D25). Fresh-navigate readback of intended writes; reclassify false
    skips; name the failing field. Depends on/pairs with #6 above.
31. **Diagnostic capture with sampling caps** (D6) + **log retention policy** (D7).
32. **Skip-vs-error reclassification** (D5).
33. **Pool preview / verification mode** (D16). Pool respects start modes (part of D13).
34. **Logout-attempt warnings surfaced** (D17) + smarter logout retry (D18).
35. **Per-row total-time timeout** (D23). Row-timeout skip reason; worker stays alive.
36. **Spreadsheet-free flow type** (D19).
37. **Sequential flow queueing** (D20).
38. **Scheduled flow runs** (D21).
39. **Restart feature overhaul** (C22). Real use case: network recovery. Must reuse the flow's
    saved worker count + window mode. Shares clean-drain machinery with #5 and D22.

## DISCUSSION BUCKET

40. **IF/conditional logic in flows** (C6). Umbrella over #14. v2.2.9's If-click is the first
    slice.
41. **XPath text-locate click step** (C5). AND/OR/NOT compound text predicates. NOTE:
    `resolveStepLocator` already supports a `findByText` mode — audit before building.
42. **Batch vs one-at-a-time** (C21). Batch stays for now, default 5.

## BOTTOM OF LIST

43. **If-click: optional after-click "wait until gone"** (C28). For non-PestPac software with
    fade-out popups. PestPac doesn't have the problem.

## DEFERRED (unchanged from v2.4.0 doc)

- Field Catalog (v2.5). Parallel multi-flow (v2.5). PestPac API / hybrid (v3.0 branch —
  blocked on WorkWave OAuth credentials).
