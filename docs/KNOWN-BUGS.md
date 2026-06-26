# BUU 2.0 — Known Bugs (running list)

Single place to track open defects between releases. Newest / highest-impact first.
Each entry: symptom → root cause (if known, with file refs) → fix direction. Mark items
fixed with the version that fixed them rather than deleting (keeps history).

---

## OPEN

### 1. Lingering "BUU 2.0" processes after a run — and the no-update-prompt it causes
**Status:** open. Diagnosed 2026-06-26. **High impact** (blocks builds; hides updates).

**Symptoms**
- After a run finishes, multiple `BUU 2.0` processes stay alive in Task Manager. Closing the
  window does not kill them.
- Opening BUU shows **no update prompt** even when a newer version was published — every time.
  A `npm run build` also fails on file locks because the app isn't really closed.

**Root cause (verified in source)**
These are the SAME bug. The auto update check runs only inside
`mainWindow.once('ready-to-show') -> checkForUpdates()` (src/main.js ~3592) — i.e. once per
genuinely fresh launch. There is a single-instance lock (src/main.js ~3601): a second launch
that cannot acquire the lock calls `app.quit()`, and the instance holding the lock handles
`second-instance` by only doing `mainWindow.focus()` (~3609-3613) — it does NOT re-check for
updates. So when stale processes keep the main process alive, it keeps holding the
single-instance lock; "reopening" BUU just re-focuses the stale window, `ready-to-show` never
fires again, and `checkForUpdates()` never re-runs. No prompt until every BUU process is killed
and a truly fresh launch happens. The same stale main process is what locks build output files.

The lingering processes themselves are not yet fully root-caused: confirm whether they are
orphaned per-worker child processes (the spawned node/Playwright workers) not being killed on
run completion / app quit, and/or the main process not quitting on `window-all-closed`.

**Fix direction (next release)**
1. Full teardown: on run completion AND on app quit, kill every spawned worker/child process;
   ensure the main process actually exits (handle `window-all-closed` → `app.quit()` unless a
   run is intentionally backgrounded). Audit the pool/worker spawn paths for orphan handles.
2. Mitigation (cheap, robust): make the `second-instance` handler also call
   `checkForUpdates(false)` so a focus-reopen rechecks for updates even when a stale instance
   holds the lock.
3. Optional: re-check for updates on window focus or on a low-frequency interval, not only at
   `ready-to-show`.

**Workaround for now:** fully kill all `BUU 2.0` processes (Task Manager / `Stop-Process`)
before reopening, or use the manual "check for updates" path (the `check-for-updates` IPC
already exists and calls `checkForUpdates(true)`).

---

### 2. Frankware runs invoke PestPac-only license/reauth machinery
**Status:** open. Diagnosed 2026-06-26. Medium impact (wasted resources; bad on small hosts).

A Frankware run has no PestPac license concept, but the PestPac-era machinery still fires:
- **Elastic license scale (`coordLicenseScale`, src/main.js ~1886):** when elastic mode is on,
  the timer logs in with the (Frankware) profile — login is platform-aware — but then hardcodes
  `page.goto('https://app.pestpac.com/license.asp?Mode=View')`, which the Frankware session isn't
  authed for. It reads no free-license value, `freeText == null`, and returns early WITHOUT
  scaling. So it does NOT change the worker count, but every interval it launches an extra
  headless Chromium + a fresh Frankware login, reads nothing, and closes — pure waste, and on a
  RAM-starved host it competes for the memory workers need.
- **Reauth (worker `REAUTH_INTERVAL`):** re-logs-in at row boundaries when the timer elapses,
  via the shared platform-aware login — so for Frankware it would re-login to Frankware (not
  PestPac). Not wrong, but usually unnecessary for an active scrape (Frankware's timeout is
  5-min INACTIVITY and an active worker keeps resetting it). Gated by the reauth interval (0 = off).
- **Manual "Auto" worker-cap button (`check-license-cap` path):** same root cause, different entry
  point. Hitting "Auto" on a Frankware profile tries to read PestPac licenses, waits for the
  PestPac login field `input[name="uid"]` (absent on Frankware), times out after 15s with
  "Could not read licenses", and falls back to the hardware cap. The fallback number is correct,
  but the error is confusing and the 15s hang is avoidable. Confirmed on the AWS VM 2026-06-26.

**Fix direction:** for Frankware profiles, skip the elastic license loop entirely (no license
signal to read) and default reauth off / make it Frankware-aware. Gate both on
`profile.platform === 'pestpac'`. The same gate should make "Auto" skip the license read for
Frankware and go straight to the hardware cap (no 15s timeout, no error dialog).

**Workaround now:** for Frankware runs, leave elastic license mode OFF and reauth interval at 0.

**NOTE — this is NOT why a Frankware run shows few workers.** That's the hardware cap
(`computeHardwareCap`, src/main.js ~36): spawned workers = `min(configured, cores×6,
floor(freeRAM×0.70 / 150MB))`. On a small VM with little free RAM the RAM term collapses to 1-2
and clamps the pool regardless of the configured count. Budget ~150MB free RAM per worker
(~214MB with headroom) → ~2GB+ free RAM for 10 workers. Run-all spawns all workers at once, so
"stuck at 1" is the cap, not slow ramp-up.

---

## OPEN (carried from prior sessions — not yet root-caused this pass)

### 3. `verifyAfterAction` false-mismatch on Add Billing Note / chargeback flows
Reads form fields AFTER the save button has navigated away and destroyed them, producing false
"mismatch" errors. Fix: verify must fresh-navigate and read, not re-read the post-save DOM.

### 4. Step-through / validation mode spawns extra live-browser workers
The pool scales up even during a paused single-step session; with `setupScope:"per-worker"`
each spawned worker runs a full PestPac login (burns licenses). Step mode should not scale the
pool.

### 5. Phantom "Do you want to delete this note?" confirm dialog during add-note flows
A confirm dialog appears during add-note flows that shouldn't. Needs source-level investigation
of the add-note step path.

### 6. Modal overlay covers the Add Profile modal (secondary machine)
`setupOverlay` / `resumeOverlay` / `pasteModal` overlays sit on top of the Add Profile modal.
Workaround: hide overlays via DevTools console. Real fix: overlays default to `display:none`
and are shown explicitly. Must ship from the main machine.

---

## FIXED

- **v2.2.8** — Frankware scrape stamp columns (PP Location Code / PP Invoice # / Frankware
  Property #) wrote blank: the three fields were read with raw `row[field]` access, so a
  `{{Token}}` entered by the user became `row['{{Old Acct #}}']` → undefined. Now resolved
  through `r()` like the URL field (with bare-name fallback); the three fields are also
  token-droppable in the UI.
- **v2.2.6** — Frankware profiles not saving (empty company-key secret rejected by Credential
  Manager; now empty secrets are deleted instead of stored).
