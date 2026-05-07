# v1.2.7 — Dialog handler crash fix

Single-issue hotfix for a runner crash discovered while running an Employee# update job. Mid-batch crash that looked random but turned out to be a deterministic state leak across rows.

## What was broken

The `dialog` step type used `page.once('dialog', ...)` to register a one-shot listener. The intent was: "register a handler, the next dialog that fires gets handled, then we're done."

The bug was a quiet assumption that **the dialog would always fire**. In reality, PestPac only shows certain confirm dialogs conditionally — for example, the "This Employee has no Access Rights" warning only appears for employees who actually lack rights. For employees who DO have rights, the save just completes without prompting.

When that happened:

1. Step 6 (`dialog`) registered `page.once('dialog', ...)` — listener now attached
2. Step 7 (`click butSave`) — no dialog fires, save completes
3. Row finishes. The listener is **still attached**, waiting for a dialog that already came and went
4. Next row begins. Step 6 registers ANOTHER `page.once`. Now two listeners stacked
5. Repeat for every row that doesn't fire a dialog

Eventually a row hits an employee who DOES need the warning. PestPac fires the dialog. **All stacked listeners run**, each calling `.accept()` on the same dialog. The first one succeeds; every other one throws `Cannot accept dialog which is already handled`. That's an unhandled promise rejection inside an async listener, which terminates the runner subprocess with exit code 1.

The runner log showed multiple `{type:"dialog",...}` events for the failing row before the stack trace, even though the flow only has one `dialog` step. That was the tell — but it took piecing together the row's data, the flow JSON, and the listener lifetime to find it.

## What changed

**Dialog listeners now clean themselves up.** The runner now stashes the current dialog listener on the `page` object and removes any previous listener before registering a new one. So step 6 of row N+1 cleans up step 6's leftover listener from row N, regardless of whether it ever fired.

**Defense in depth.** `dialog.accept()` and `dialog.dismiss()` are now wrapped in try/catch inside the listener. If a "Cannot accept dialog which is already handled" race ever does occur, it gets logged and swallowed instead of crashing the process.

**No flow changes needed.** The fix is entirely in the runner template. Existing flows that have any `dialog` step start working correctly without modification.

## What's NOT changed

Auto-update, resume, retry-failed, network-aware retry, re-auth, circuit breaker, iframe-aware selectors, Excel log enrichment, defaults, settings — all continue from v1.2.6 unchanged.

## Note on roadmap

The version 1.2.7 was originally going to be the "setup and teardown flows" feature release (the chargeback workflow architecture work). That design doc has been renumbered to **v1.2.8** so this hotfix could go out cleanly under its own version number. Implementation of the setup/teardown work has not started; it's still in design review.

## Compatibility

Existing flows, profiles, credentials carry over unchanged. Flows that previously crashed mid-batch on the dialog stacking pattern should now run to completion.

## Stats

1 commit since v1.2.6. ~30 lines changed in `src/main.js` (the `case 'dialog':` block in the runner template).
