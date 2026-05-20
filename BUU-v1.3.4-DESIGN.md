# BUU v1.3.4 — Backlog & Design Notes

**Status:** Not started. Backlog captured 2026-05-20 from live use of v1.3.x find-by-text.
**Predecessor:** v1.3.3 (UI sizing: zoom 1.35, screen-relative window).

---

## STANDING CONTEXT (always true — do not re-ask)

- **Matthew is the only user of BUU right now.** Sole operator, no other install in the field.
  When Matthew says ship, ship all the way (bump, commit, tag, push, AND publish the GitHub
  release). He tests on his own machine after the fact. Do NOT propose holding a release "so
  others aren't affected" — there are no others.
- **Workflow:** diff-by-diff sign-off on non-trivial changes; tests after push, not during the
  session; prefers brutal honesty over softened status. Use desktop-commander edit_block (not
  Filesystem edit_file — that hit EPERM rename locks). Validate runner template edits with
  `node scripts/_validate-runner.js` (runs on Matthew's machine via start_process). PowerShell
  uses `;` not `&&`.

---

## Origin of this backlog

While building a real flow against a PestPac lookup table (~500 `<tr class="LookupTableRow">`
rows, each a service-area/tech-autofill row), two gaps in the v1.3.0 find-by-text feature surfaced.

Sample row (the thing being matched/clicked):
```html
<tr id="SearchRow3" onclick="rowClick(3, event)" lookupid="1903" code="20001" class="LookupTableRow " bgcolor="#FFFFF0">
  <td>20001</td>        <!-- zip -->
  <td>(Default)</td>
  <td>LEAD</td>          <!-- class -->
  <td>JACKSONBR</td>
  ... more cells ...
</tr>
```
Matthew needs to match on TWO values (zip `20001` AND class `LEAD`) to disambiguate, because
zip alone is shared across many rows. The whole `<tr>` carries the onclick, so the target
selector is left empty (click the row itself). Today this is only achievable via a hand-written
regex in match mode (`{{Zip}}.*{{Class}}` or the order-independent `(?=.*{{Zip}})(?=.*{{Class}})`).

---

## ITEM A — Multi-condition match builder (the big one)

**Problem.** find-by-text matches ONE text value against the row's combined visible text using
ONE mode. Real disambiguation often needs multiple conditions combined with boolean logic:
"match this AND that", "match this but NOT if it contains that", "match this only if it also
contains that". Today the only way to express AND is a hand-built regex, which most users
won't write and which breaks if token values contain regex-special characters.

**Design.** Replace the single match-text row with a **repeatable list of match conditions**.

UI:
- The match-text section gets a **+ button** to add condition lines.
- Each condition line has:
  - a **text field** (token or literal — same as today; plain text matches literally)
  - a **match mode** dropdown (the existing 7: contains/exact/starts/ends/contains-ci/exact-ci/regex)
  - a **boolean connector** dropdown that joins this condition to the overall match. Options:
    `AND` (must match), `OR` (any-of group), `NOT` (must NOT match). First line has no connector
    (it's the base), or treat its connector as implicit AND.
- A small × on each line to remove it. At least one line always present.

**Semantics (keep simple and predictable):**
- Default evaluation: all AND/NOT conditions must hold; OR conditions form an any-of group.
- Suggested rule to avoid precedence ambiguity: evaluate as
  `(all AND conditions true) AND (at least one OR condition true, if any OR lines exist) AND (no NOT condition true)`.
- This covers Matthew's stated cases: "match A and B", "match A but not B", "match A only if it
  also contains B" (= A AND B). Document the rule in the UI hint so behavior is never surprising.
- Still fail the row on zero or >1 matching container (never guess) — unchanged.

**Step JSON.** Replace single `matchText`/`matchMode` with a `matchConditions` array:
```
matchConditions: [
  { text: "{{Zip}}",  mode: "contains", connector: "and" },
  { text: "{{Class}}", mode: "contains", connector: "and" }
]
```
BACK-COMPAT: if `matchConditions` absent but legacy `matchText`/`matchMode` present, synthesize a
single-condition array. Keep reading old flows.

**Runner.** `findInContainer` currently calls `matchesText(rowText, matchText, mode)` once.
Change to evaluate the condition array against each container's text:
- For each container, compute per-condition booleans via the existing `matchesText`.
- Combine per the semantics rule above.
- The pause-panel preview (`resolvePreview`) should render the condition list readably, e.g.
  `in [tr.LookupTableRow] where: contains "20001" AND contains "LEAD"`.

**Validation.** `runValidation()` find-by-text branch: require at least one condition with text;
brace-check each condition's text; validate each `{{token}}` against columns as today.

**Regex-special-character trap (must address in builder).** When a condition uses regex mode, token
values are injected raw into the RegExp. Values containing regex-special chars — parentheses,
`. * + ? [ ] { } ^ $ | \` — break or misbehave. Real example: the class value `(Default)` would be
read as a regex GROUP, not the literal text "(Default)", so it'd match `Default` without the parens
(or error in a more complex pattern). Today's stopgap regex `(?=.*{{Zip Code}})(?=.*LEAD)` is safe
ONLY because zip (digits) and `LEAD` (letters) have no special chars. Fix in the builder: for
literal-text conditions, use the literal match modes (contains/exact) which already treat text
verbatim; and when a value must go into a regex, escape it first
(`s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`). With per-condition modes (Item A), the user matches
zip and `(Default)` each in the right mode and never hand-writes a fragile combined regex.

**Effort estimate:** 2.5–3 hr (UI repeatable-row builder is the bulk; runner logic is small).
This is the meaty item — do it diff-by-diff with sign-off, validate runner template after.

---

## ITEM B — Paste HTML button is wrong for the container selector

**Problem (confirmed in live use).** In find-by-text, the container field's Paste HTML button
runs the normal `extractSelector()`, which prioritizes `data-testid → name → id → placeholder`.
Pasting a `<tr id="SearchRow3" class="LookupTableRow">` yields `#SearchRow3` — the PER-ROW unique
id that changes every row — which is exactly wrong. For a container you want the STABLE selector
that matches MANY elements (here `tr.LookupTableRow`), the opposite of what extractSelector is for.

**Design.** The container field needs its own extraction logic (or a mode flag on the existing
extractor) that prefers selectors which intentionally match multiple elements:
- Priority for CONTAINER extraction: stable class(es) → tag+class → tag → data-* group attrs.
  Explicitly SKIP `id` when it looks per-row (numeric suffix, e.g. `SearchRow3`, `:r0:`, trailing
  digits) — those are the dynamic ids the existing code already distrusts elsewhere.
- For the sample row, this should yield `tr.LookupTableRow` (tag + stable class). Note the class
  attribute in the HTML has a trailing space (`class="LookupTableRow "`) — trim it; emit
  `tr.LookupTableRow`, not `.LookupTableRow ` or a two-class selector.
- If multiple classes are present, prefer the one that reads as a row/item grouping class; if
  ambiguous, offer tag+firstClass and let the user trim. Show the "why" line like the normal
  extractor does.

**Where.** `openPasteModal` / `parsePaste` / `extractSelector` in index.html. Cleanest approach:
when the paste modal is opened FOR a container field (pendingInsertField === 'containerSel'),
route to a new `extractContainerSelector(html)` instead of `extractSelector(html)`. The modal
already knows which field it was opened for.

**Effort estimate:** 1–1.5 hr.

---

## ITEM C — Workbook sheet selection: BUU loads sheet index 0 even when it's HIDDEN (real bug, confirmed root cause)

**Confirmed 2026-05-20, root cause nailed.** Matthew loaded `Palmetto Zips by PMC.xlsx`. BUU
reported "56 rows · 4 columns" with chips `{{Zip Code}} {{Us}} {{Them}} {{Us}}`. Matthew was
certain it was a single-tab file — and from his point of view it IS: in Excel only the "Palmetto"
tab shows. The file actually contains 14 sheets but **13 are HIDDEN**; only "Palmetto" is visible
and it's the active sheet. Sheet visibility states verified via openpyxl `sheet_state`:
- index 0 = "Cen Charlotte" — **hidden** (header: Zip Code | Us | (blank) | Them | Us) ← BUU loads THIS
- index 1 = "Palmetto" — **visible**, active (Zip Code | PMC Username) ← what the user wants
- indexes 2–13 — all hidden

**Root cause:** BUU reads sheet **index 0** regardless of visibility. The user's intended sheet is
the first VISIBLE one. A hidden sheet should never be the one that loads.

**This is NOT primarily a sheet-picker need.** Matthew deliberately works with single-(visible)-tab
files to avoid confusion, and that workflow is correct. The real fix is small and matches user
intent:

**Fix (primary):** when reading a workbook, **skip hidden/veryHidden sheets and load the first
VISIBLE sheet.** Prefer the workbook's active sheet if it's visible. exceljs exposes
`worksheet.state` ('visible' | 'hidden' | 'veryHidden'); the xlsx/SheetJS path exposes
`workbook.Workbook.Sheets[i].Hidden` (0 = visible, 1 = hidden, 2 = veryHidden) and
`workbook.SheetNames`. Pick the first name whose Hidden is 0 (or the active sheet if visible).

**Fix (secondary, optional):** if there is MORE THAN ONE visible sheet, then prompt with a picker
(dropdown of visible sheet names + row/col counts). With a single visible sheet — the common case —
load it silently, no prompt. This keeps Matthew's single-visible-tab workflow friction-free while
covering genuinely multi-visible-tab files.

**Why this matters:** today a hidden leftover sheet silently hijacks the load with NO warning. The
user sees wrong column chips and has no idea why, because the file looks single-tab in Excel.

**Workaround until built:** in Excel, right-click the visible tab → Move or Copy → New book →
Create a copy → save → load that. (Removes hidden sheets entirely.)

**Effort estimate:** ~1 hr for the primary fix (first-visible-sheet); +1 hr if adding the
multi-visible-sheet picker.

---

## Suggested order for 1.3.4
1. Item C first (load first VISIBLE sheet, not index 0 — silent-wrong-data bug, hit in live use).
2. Item B (container Paste HTML extraction — quality-of-life).
3. Item A (multi-condition builder + column-scoped matching — the real feature).

Items A and B touch find-by-text. Validate runner template after Item A's runner change.

---

## DISCUSSION TOPIC for 1.3.4 — column-scoped matching (match within a specific cell, not the whole row)

**Why this came up.** find-by-text matches against each container's ENTIRE combined visible
text. There is no way to say "match this value IN this specific column/cell." For the zip-tech
reassignment flow, Matthew matches `(?=.*{{Zip}})(?=.*LEAD)` to find the salesperson row
(class = LEAD) for a given zip. This works TODAY, but `LEAD` is matched anywhere in the row's
text, not specifically in the class column.

**The real, confirmed risk.** People are added to this lookup table constantly. A quick check
today found no collision (LEAD doesn't currently appear outside the class column on any same-zip
row), BUT it is only a matter of time before a tech username, area name, or person's name
contains "LEAD" (e.g. "Leadbetter", a route named "LEAD-something"). When that happens on a row
that shares a zip with a salesperson row, the match returns 2 containers and the row fails —
safe (no wrong click) but it will silently start skipping reassignments and Matthew has to
notice and diagnose. This is a latent data-dependent failure, not a hypothetical.

**What's needed.** A way to scope a match condition to a specific column/cell of the container,
so "class column equals LEAD" can be expressed precisely instead of "row text contains LEAD."

**Design sketch (fold into Item A's multi-condition builder — these are the same feature):**
- Each match condition optionally targets a sub-selector WITHIN the container instead of the
  whole container text. E.g. condition = { target: "td:nth-child(3)", text: "LEAD", mode: "exact" }
  would check only the 3rd cell. The runner already scopes locators inside a container (that's
  how the target-selector-inside-row works for the click itself), so the machinery exists —
  apply the same `containerLoc.locator(sub)` pattern, read THAT element's text, match against it.
- UI: each condition line could have an optional "in column/sub-element" field (CSS or a column
  index helper). Keep it optional — blank = match whole row text (current behavior).
- For tables specifically, a friendly affordance would be a column picker (1st cell, 2nd cell…)
  that generates `td:nth-child(N)` so the user doesn't hand-write it. Nice-to-have, not required
  for v1.
- Combined with Item A's AND/OR/NOT, Matthew's flow becomes: condition 1 = zip in column 1
  (exact), condition 2 = "LEAD" in class column (exact), connector AND. No regex, no whole-row
  ambiguity, immune to LEAD appearing elsewhere.

**Decision needed at build time:** how to expose the sub-target in the UI without cluttering the
condition row. Options: (a) always-visible optional CSS field per condition, (b) a small "scope"
toggle that reveals the field, (c) table-aware column dropdown when the container looks like a
row. Lean (b) or (c). Discuss with Matthew before building.

**Until then:** the regex `(?=.*{{Zip}})(?=.*LEAD)` is the working stopgap. If "matched 2
containers" failures start appearing in logs, that's this risk materializing — prioritize this.

---

## DISCUSSION TOPIC for 1.3.4 — single-visible-tab is the norm; confirm first-visible-sheet behavior

Matthew deliberately uploads single-(visible)-tab files to avoid confusion and does NOT want a
sheet-picker forced on him for the common case. This is the same root issue as Item C but captured
as a standing preference: the desired behavior is "load the first VISIBLE sheet, silently, no
prompt when there's only one visible sheet." Only prompt if 2+ visible sheets exist. Keep this in
mind so a future build doesn't over-engineer a picker that gets in his way. (See Item C for the
technical fix.)

---

## ITEM D — Drag-and-drop not working (needs reproduction detail)

**Reported 2026-05-20 by Matthew during the zip-reassignment flow build.** Drag and drop is "not
working." NOT yet reproduced or root-caused — capture and confirm exactly what before fixing.

Candidates for WHAT is broken (confirm with Matthew which one):
1. **Column-token chips → step fields.** The chip strip ("drag onto any field below") chips won't
   drag, or won't drop into a field. NOTE v1.3.0 Item 2 changed drag handling (drag scoped to the
   step card's drag-handle so text in fields became selectable). It is plausible that change
   affected chip drag/drop. This is the most likely suspect given the timing.
2. **Step reordering** via the drag handle (reorder steps in the flow list).
3. **File drag-drop** onto the spreadsheet/flow load area.

Things to check when reproducing:
- Did this break in v1.3.0+ specifically? Item 2 ("drag scoped to handle") is the prime suspect —
  the dragstart/dragend listeners were moved from the whole card to `.drag-handle`, and
  dragover/drop stayed on the card. If chip drag relies on a listener that got moved/removed, that
  would do it.
- Is it ALL drag-drop or just one kind?
- Console errors (F12) during the drag attempt.

**Do NOT theorize a fix until reproduced.** First step next session: ask Matthew which drag-drop
(chips / step reorder / file), then read the relevant listeners in index.html (initDragDrop and
the chip/handle markup) and confirm against the v1.3.0 Item 2 diff before changing anything.

---

## ITEM E — Validation shows error/warn COUNTS but not the messages (real UX gap, confirmed)

**Confirmed 2026-05-20 in live use.** On Run, the pre-run prompt told Matthew "2 errors and 1
warning." A step card showed "1 error" — but NOT what the error was, and he had no way to find the
other error or the warning. He had to guess which field/step was unhappy.

**The data already exists.** `runValidation()` builds a full `issues` array per step with real
messages (e.g. "{{Zip Code}} not in spreadsheet.", "Find-by-text is on but no container selector.",
"Find-by-text is on but no target selector inside the matched item."). Each step's `issues`,
`worst`, `errs`, `warns` are returned. `applyValidationHighlights(items)` colors the card borders
and sets a count badge — but the MESSAGE TEXT is never surfaced to the user. So the diagnosis is
computed and then thrown away at display time.

**Fix.** Surface the messages:
1. Per-step: make the validation badge expandable / show the issue messages inline under the step
   card (or as a tooltip on hover/click of the badge). The card already has the issues array in the
   items entry — render `issues[].msg` with err/warn styling.
2. Pre-run prompt: instead of just "2 errors and 1 warning", list them with step number + message,
   e.g. "Step 3 (Click): {{Zip Code}} not in spreadsheet" — and ideally make each line click-to-
   scroll to that step card. This is the high-value part: one consolidated, readable list of exactly
   what's wrong and where, so the user isn't hunting.

**Effort estimate:** 1.5–2 hr (mostly the pre-run consolidated issue list + per-card message display;
data is already there).

---

## ITEM F — Pause/verification panel STILL disappears when you hit Next Step (Item 3a regression / incomplete)

**Confirmed 2026-05-20 in live use.** In step mode, the paused/verification section still goes away
when the user clicks "Next Step." This is the exact symptom v1.3.0 Item 3a claimed to fix ("verification
panel persists between steps — removed hidePause() from the row-start handler to stop the flicker").
Either the fix was incomplete or there's a SECOND code path hiding the panel.

**Where to look (do NOT just re-apply the Item 3a change blindly — it's already applied):**
- The Next-Step button handler in index.html: `paneNextStep()` calls `await API.runControl({cmd:'next-step'})`
  and then **`hidePause()`**. THIS is almost certainly the culprit — clicking Next Step explicitly hides
  the panel, and it only reappears when the next `pause-step` event arrives from the runner. Between the
  click and the next pause event, the panel is gone (the "disappears" the user sees). Item 3a removed
  hidePause from the row-start *event handler* but the *button* handlers (`paneNextStep`, `paneNextRow`,
  `paneRunAll`) still call hidePause() directly.
- Compare `paneNextStep` / `paneNextRow` against the pause-step event handler. The intended behavior:
  Next Step should NOT hide the panel; it should leave it visible (perhaps dimmed/"working…") until the
  next pause-step event repopulates it, so it never blanks out.

**Likely fix:** remove the `hidePause()` call from `paneNextStep()` (and reconsider it in `paneNextRow`).
Let the next `pause-step` event update the panel content in place. Only truly hide on run end / stop.
Verify there's no flespecially flicker when the next step's pause arrives quickly.

**Effort estimate:** 30–45 min. Small but verify carefully against all three release-control buttons
(next-step, next-row, run-all) and run-end so the panel hides exactly when it should and not otherwise.

---

## ITEM G — "No URL column found" error is wrong when the flow uses a hardcoded navigate URL

**Confirmed 2026-05-20 in live use.** Per-row flow validation (in `runValidation`, the per-row branch)
hard-errors with "No 'URL' column found" whenever the spreadsheet has no column literally named `URL`:
```
if(!cols.some(c=>c.toLowerCase()==='url')){items.push({t:'err',msg:'No "URL" column found.'});errs++;}
```
This assumes every per-row flow navigates to a per-row `{{URL}}`. But many flows (Matthew's zip /
TechnicianAutoFill flow) **navigate ONCE to a hardcoded URL** (e.g. `https://app.pestpac.com/lookup/
TechnicianAutoFill/`) and then do all row work on that one page. These flows have a Navigate step with a
literal http URL and no per-row URL column — and the runner doesn't actually require a URL column
(no `row['URL']` usage found; `{{URL}}` is resolved like any other token only if present). So the
validator is over-requiring.

**Desired behavior (Matthew):** the URL check should pass as long as there IS a usable URL — i.e. a
Navigate step whose URL field is filled with something that starts with `http` (a hardcoded URL), OR a
`URL` column exists for per-row navigation. Only error if NEITHER is true (no URL column AND no navigate
step with a literal/usable URL).

**Fix sketch:** replace the bare column check with:
- pass if any navigate step's resolved URL field starts with `http` (hardcoded), OR
- pass if a `URL` column exists (per-row), OR
- pass if any navigate step uses a `{{token}}` that resolves to a column (per-row via token)
- else error "No URL column and no Navigate step with a URL — add one."
Downgrade to warning rather than hard error if uncertain, so it never blocks a runnable flow.

**Effort estimate:** 30–45 min. Pure validator logic in index.html; no runner change.

---

## CARRIED-FORWARD ITEMS — audit of all prior design docs (2026-05-20)

Reviewed DESIGN-INDEX.md, BUU-v1.2.4/1.2.5/1.2.8/1.3.0-DESIGN.md, POST-PUSH-NOTES.md, BUUA-DESIGN.md
for anything deferred/promised in earlier versions and never built. Findings:

### CF-1 — Historical run-log scanning in the Run Log tab (NEVER BUILT, oldest debt)
Originally the v1.2.4 backlog item; re-deferred in v1.2.5 ("depends on v1.2.4 backlog historical-log
scan"); also the original PROJECT-HANDOFF bug 6.1. **Confirmed still unbuilt** — no historical/log-scan
code exists in src (grep found nothing). Symptom: the Run Log tab shows only the current session's
in-memory `logEntries` (reset every launch) and reads "No log entries yet" on startup even though
`%APPDATA%\better-update-utility\logs\` is full of past BUU-log Excel files. Fix: on launch, scan the
logs folder for recent BUU-log-*.xlsx and populate a "historical runs" view in the Run Log tab.
Medium effort (folder scan IPC + read summary rows + render). Genuinely useful — Matthew has months of
run logs invisible in-app.

### CF-2 — Item 13: File-upload step type (NEVER BUILT, real business driver)
Deferred from v1.3.0. New step type using Playwright `setInputFiles(selector, path)`; path from a column
(e.g. `DocPath`) or static. **Origin: Matthew needs to upload ~20,000 documents to PestPac.** Scope
depends entirely on WHERE the files live at run time:
- Local-accessible files: ~4–5 hr (new step type + one runner case + path-exists preflight).
- Cloud-only (SharePoint/OneDrive/Drive): 20–30 hr (cloud SDK + OAuth + download-to-temp + cleanup).
BLOCKING QUESTION before scoping: where do the 20k files actually live, and is there a validated manual
PestPac upload flow? Until answered, can't estimate or schedule. This is the biggest latent feature.

### CF-3 — Item 12: Per-step on-fail flows (NEVER BUILT, deliberately big)
Deferred from v1.3.0 as a v1.2.8-magnitude feature (8–12 hr). Each per-row step optionally declares a
once-flow to run if the step fails after retry exhaustion. Motivating case: chargeback flows that fail
mid-service-order leave orphan service orders; on-fail would delete the partial before continuing.
Matthew explicitly rejected the cheaper per-ROW alternative (one flow-level on-fail) and wants per-STEP.
Touches schema (per-step `onFailFlowId`), runner control flow (intercept failure path), validation, UI
(dropdown per step), phase indicator (non-linear "in recovery"), Excel log, stop/resume semantics. Needs
its own full design doc. Candidate for a v1.4.0 rather than 1.3.4.

### CF-4 — BUUA hybrid backend (PARKED on external blocker, not missed)
BUUA v2.0 (API + browser-fallback hybrid) is blocked on WorkWave API access — four OAuth auth attempts
all 401'd; a real ClientId/ClientSecret was apparently never delivered. Email sent to WorkWave support.
NOT a missed item — correctly parked pending an external dependency. When WorkWave replies with real
credentials: update scripts/creds.ps1, run _api-auth-test.ps1, then _api-probe-sweep.ps1. (Also: the
GitHub raw-cache version.json fix was intentionally deferred to BUUA, which can use a non-cached endpoint.)

### Confirmed NOT debt (resolved or deliberate)
- Items 1–11 of the v1.3.0 backlog all shipped in v1.3.0–v1.3.3.
- v1.2.5 retry-failed-rows, resume, circuit breaker, network-aware timeouts — all shipped.
- DESIGN-INDEX.md still describes v1.3.0 as "the next thing to build / not yet designed" — STALE; v1.3.0
  shipped. Index needs a refresh pass to mark v1.3.0–1.3.3 shipped and point at this 1.3.4 doc. (Minor
  housekeeping, not a feature.)

---

## ITEM H — Cannot right-click into the Paste HTML box (and audit right-click/context-menu in all inputs)

**Reported 2026-05-20 in live use.** Matthew can't right-click into the "Paste HTML" box — i.e. the
right-click context menu (Paste, Select All, etc.) doesn't work in that field, so he can't right-click →
Paste his copied outerHTML; presumably has to use Ctrl+V instead. Right-click is the natural gesture for
pasting and its absence is friction in the one workflow (paste HTML) that's all about pasting.

**Likely cause:** a `contextmenu` event handler somewhere is calling `preventDefault()` and suppressing
the native context menu — either globally (to disable the default Electron right-click menu) or on a
container that includes the inputs. Electron apps often disable the context menu app-wide and then forget
to re-enable it on text inputs. Check index.html and main.js for:
- `addEventListener('contextmenu', ... preventDefault())` (renderer) or
- `webContents` context-menu suppression / missing `Menu` setup (main process).

**Fix:** allow the native context menu on editable fields (inputs/textareas), or build a minimal
right-click menu (Cut/Copy/Paste/Select All) for them. At minimum, never preventDefault the context menu
on an editable target.

**ACTION — audit ALL input boxes, not just Paste HTML (Matthew's explicit request).** Go through every
text input / textarea / editable field in the Build page and elsewhere and confirm:
- right-click context menu works (paste especially),
- Ctrl+C/V/X/A work,
- text is selectable (ties into v1.3.0 Item 2 / the drag-handle change and Item D drag-drop),
- focus/blur behaves (tokens, paste-modal fields, match text, container selector, all selector fields).
This is a once-over pass to catch any field where basic editing gestures are broken, since the drag-scope
change in v1.3.0 touched input interaction and may have side effects beyond what's been spotted.

**Effort estimate:** 30 min for the context-menu fix; +30–45 min for the full input audit.

---

## ITEM I — Run guard stuck on a ghost run; "Another automation is already running" with 0 done (Item 3 variant)

**Confirmed 2026-05-20 in live use, with screenshot.** Matthew ran a flow, then attempted to run a second
flow without closing the first. Got a native dialog: "Failed to start: Another automation is already
running (started 6:51:43 PM). Stop it first or wait for it to finish." Meanwhile the Run Progress panel
showed **"Starting…", elapsed ~10m, 0 done / 0 success / 0 errors, 0% complete.** So the FIRST run never
got past the "Starting…" phase — it stalled or died silently before reporting any rows — yet the
`automationProcesses` Map / `isRunning` guard still believed a runner was alive, so the second run was
(correctly) refused. The first run is a ghost that never fired `runStopped()`.

**Relationship to v1.3.0 Item 3.** Item 3 hardened stop/restart: idempotent `runStopped()`, a 5-second
safety timer in `requestStop()`, console instrumentation. But Item 3's safety timer fires on the STOP
path. This case is different: the run got stuck in "Starting…" (pre-first-row) and the user never
successfully stopped it — the start itself appears to have stalled/failed without cleanup. The guard was
set on start but never cleared because the runner never reported success, completion, OR error.

**Where to look:**
- `start-automation` in main.js: the guard (`automationProcesses` set keyed by runId) is added BEFORE
  spawn / early in the start sequence. If the runner process dies, fails to spawn, or never emits its
  first event, is there a path that removes it from the Map? Look for a spawn-failure / process-exit /
  timeout handler on the child process. If the child exits non-zero or never starts, `automationProcesses`
  must be cleaned up and the renderer told.
- Renderer: the "Starting…" state with a ticking elapsed timer but 0 done suggests the runner spawned (or
  the UI thinks it did) but no `row-start` / heartbeat / phase event ever arrived. The v1.2.3 phantom-run
  fix created the runner log before the chromium check — confirm a similar guarantee exists for clearing
  the run guard if the runner never heartbeats within N seconds.
- Add a STARTUP watchdog: if no heartbeat/phase/row event arrives within e.g. 30–60s of start, treat the
  run as failed-to-start, clear `automationProcesses`, reset the UI, and surface a real error ("Runner
  never reported in — start failed"). This is the missing safety net for the start path (Item 3 covered
  the stop path).
- Also: the Stop button should ALWAYS be able to clear the guard even from the "Starting…" ghost state.
  Confirm `requestStop` → `runStopped` clears `automationProcesses` even when no runner events were ever
  received (idempotent clear, not conditional on a known runId being "active").

**Immediate user workaround:** click Stop (5s safety timer should force runStopped); if that fails, restart
BUU. The whole point of this item is to make the restart unnecessary.

**UPDATED repro (Matthew, 2026-05-20):** the stuck guard followed a STOP, not a natural finish. Sequence:
ran a flow → clicked Stop on it → then tried to run the next flow → "Another automation is already running."
So Stop did NOT clear `automationProcesses` / the run guard. This makes Item I essentially "v1.3.0 Item 3
is still not fully fixed" — the idempotent runStopped + 5s safety timer from Item 3 are NOT clearing the
backend guard map (`automationProcesses` in main.js), even though they may reset the renderer UI. KEY
INSIGHT: separate the two states — (a) renderer `isRunning`/UI, (b) main-process `automationProcesses` Map
that `start-automation` checks. Item 3 likely fixed (a) but not (b). The "already running" dialog is thrown
by `start-automation` reading (b), so the fix must ensure Stop/runStopped clears the MAP, and that
`stop-automation` actually kills the child and deletes its Map entry even if the child already exited or
never reported. Confirm `requestStop`/`stop-automation` deletes from `automationProcesses` unconditionally.

**Effort estimate:** 1–1.5 hr. Startup watchdog + guaranteed guard-clear on spawn failure / process exit /
no-first-event. Validate runner template after if any runner-side change; mostly main.js + renderer.

---

## ITEM J — Step drag-reorder: no auto-scroll while dragging (made worse by the bigger UI)

**Reported 2026-05-20.** After the v1.3.3 size increase (zoom 1.35 + bigger window), steps take more
vertical space, so reordering a step often requires moving it past the visible area. Today you CANNOT
scroll with the mouse wheel while holding (dragging) a step, and the view does NOT auto-scroll when you
drag to the top/bottom edge of the scroll container. So if the destination is off-screen, you're stuck —
you have to drop, scroll, re-grab, repeat. The bigger UI amplified this (fewer steps fit on screen).

**Fix — two acceptable approaches (do one, ideally both):**
1. **Edge auto-scroll:** while a drag is active, if the cursor is within ~40px of the top or bottom of the
   steps scroll container, auto-scroll that container (requestAnimationFrame loop, speed scaled by how deep
   into the edge zone). Standard drag-autoscroll pattern. Stop on dragend/drop.
2. **Wheel-while-dragging:** allow the mouse wheel to scroll the steps container during an active drag
   (don't preventDefault wheel events mid-drag; ensure the drag library/handlers don't swallow them).
Edge auto-scroll (1) is the more standard, reliable fix; wheel support (2) is a nice add.

**Where:** the drag handlers in index.html (initDragDrop / the dragstart-dragover-drop wiring touched by
v1.3.0 Item 2). The steps list scroll container is the element to auto-scroll.

---

## ITEM K — Step drag-reorder: TWO drop-indicator lines appear, only one works; make it ONE smooth line

**Reported 2026-05-20 (detailed).** When reordering steps, the drop position is ambiguous and fiddly.
Specifically: as you drag over a target, a line appears at the TOP of the lower step ("the one you're
moving over") — but that line does NOT work. If you nudge the cursor up a little more, a SECOND line
appears at the BOTTOM of the upper step — and THAT is the one that actually works. So there are two
competing indicator lines for essentially the same gap, only one is the real drop target, and the working
one requires nudging into a narrow zone. Result: Matthew has to re-attempt a move 3–4 times because the
active drop zone is too restrictive. His words: "it's tiring having to move things 3-4 times bc it's a
little too restricting."

**Root cause (likely):** each step card is probably computing its own drop indicator (top-edge of one card
AND bottom-edge of the adjacent card both render a line for the same gap), and the actual drop logic only
honors one of them, with a too-small hit zone. So the user sees two lines, guesses wrong, and the move
fails until they hit the narrow correct band.

**Fix:** ONE drop indicator per gap, with a generous hit zone.
- Compute drop position from the cursor's Y relative to each card's vertical midpoint: if above midpoint,
  insert before this card; if below, insert after. This gives a single unambiguous insertion point per
  cursor position — no competing top/bottom lines.
- Render exactly ONE line at the resolved insertion gap (between card N and N+1), not two.
- Make the whole upper-half / lower-half of a card a valid drop zone (the midpoint split), so there's no
  narrow band to hunt for — anywhere over a card resolves to a clear before/after.
- Smooth it: the indicator should follow continuously as you move, snapping to the nearest gap, with no
  flicker between two lines.

**Where:** index.html drag-reorder handlers (dragover handler that positions the indicator + the drop
handler that computes the new index). This is the same subsystem as Item D and Item J — they should
probably all be fixed together in one focused drag-reorder overhaul.

**Effort estimate (J+K together):** 2–3 hr for a clean drag-reorder overhaul (single midpoint-based
indicator + edge auto-scroll + verify text-selection/drag-handle from Item 2 still intact). Worth doing as
one pass since J, K, and D all live in the same drag code.

## END
