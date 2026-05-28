# SKILL: PestPac Lead-State Reconciliation & Rerun-Sheet Building

**What this is:** the standard, deterministic procedure for answering any "which leads still
need X / why did these leads end up wrong / build me a sheet to rerun Y" question in the BUU
PestPac work. Follow it exactly, every time. It exists because hand-assembling sheets and
reporting counts from memory produced a real error (336 leads mislabeled CLEANUP instead of
DUPLICATE on 2026-05-28). The fix is to ALWAYS derive from authoritative sources and ALWAYS
verify before handing a file to Matthew.

**When to use it:** any request shaped like one of these —
- "build me a sheet of the leads that still need [voiding / closing / updating]"
- "why did these leads end up [wrong status / wrong close reason]"
- "cross-reference X against Y"
- "which of these are actually done / still open / mislabeled"
- any rerun / leftover / skip / fix sheet for a PestPac bulk operation

---

## THE ONE RULE THAT MATTERS MOST

**Derive from authoritative ROOT sources. NEVER derive from an intermediate output sheet.**

The 2026-05-28 error happened because a sheet was built by carrying close-reason values
forward from a previously-built sheet (LEFTOVER-4100) instead of from the roots. Intermediate
sheets inherit and compound mistakes. Always go back to:

1. **INTENT** — the original list that says what each lead SHOULD be (e.g. the Duplicate Lead
   Clean Up list = "these should all be DUPLICATE"). This is ground truth for the goal.
2. **REALITY** — the most recent live PestPac scrape (a Read Lead Status flow output) = what
   each lead ACTUALLY is right now. This is ground truth for current state.
3. **HISTORY (optional)** — the pool journals = what BUU actually did. Use to explain WHY, not
   to decide WHAT (journals under-report success; see note below).

A rerun/fix sheet is always: INTENT minus REALITY, scoped and verified. If you find yourself
opening a previously-built rerun/leftover/fix sheet to copy values out of it, STOP — open the
root sources instead.

---

## FILE FORMATS (verified 2026-05-28 — the real column names, not guesses)

### Live scrape (Read Lead Status flow output) — REALITY source
Sheet name is usually `Read fields`. Columns:
```
Row | OP ID | URL | Won Status | Won Status (raw) | Close Reason | Close Reason (raw)
```
- `Won Status (raw)`: single letter. O=Open, V=Void, W=Won, L=Lost, H=Hold, N, A.
- `Close Reason (raw)`: e.g. CLEANUP, DUPLICATE, or blank.
- Join key is **OP ID** (numeric). Always compare as String(id).trim().

### Original intent lists (e.g. Duplicate Lead Clean Up.xlsx) — INTENT source
Often have a junk/blank row 0, with the real header on row 1. Read with `range:1`.
Seen columns: `Opp ID | Lead Contact | Address `  (note: "Opp ID" not "OP ID", and
"Address " has a trailing space). ALWAYS print Object.keys(row0) first to confirm before
assuming column names — they vary file to file.

### When there is no OP ID column
Extract it from the URL field: the number after `SalesOppID=` in
`https://app.pestpac.com/leads/detail.asp?Mode=Edit&SalesOppID=<ID>&StatusType=`
Regex: `/SalesOppID=(\\d+)/`

### Pool journal (HISTORY source) — at %APPDATA%/buu-2/pool-journal-pool<ts>.jsonl
One JSON object per line: `{"j":"<jobId>","r":<rowNum>,"s":"<status>"}`
- `r` = 1-based row number into the DATA rows of the source sheet (header excluded).
- `s` = ok | skip | error | ok (retry).
- Sibling `.meta.json`: keys poolId, batchSize, startedAt, jobs[]; each job has jobId,
  label, spreadsheetPath, errHandle, totalRows, flowSteps.

---

## THE PROCEDURE (follow in order, every time)

### Step 0 — Locate the real files, do not trust the stated path
Files get hand-moved between `upcoming/`, `upcoming/results/`, `upcoming/Finished/` constantly.
Before reading, search for the file by name across the whole repo (excluding node_modules/.git/
dist/chromium). If a path fails, search — do not give up and do not assume it was deleted.

### Step 1 — Identify which source is INTENT and which is REALITY
State it explicitly to yourself: "intent = <file>, reality = <file>". If the request only gives
one file, ask which is which, or determine if a fresh scrape is needed (see Step 5).

### Step 2 — Load each source and PRINT ITS COLUMNS before using them
Never assume column names. `console.log(Object.keys(rows[0]))` for every file. Confirm the
header row offset (some intent lists need range:1).

### Step 3 — Build the result by set logic against the roots
Typical: result = { id in INTENT } AND { id in REALITY } AND { reality state == the wrong/todo
state }. Output the TARGET values (what they should become), not values copied from any sheet.
Sort by OP ID for stable, reviewable output.

### Step 4 — VERIFY before writing, then VERIFY the written file (MANDATORY)
This is the step that was skipped on 2026-05-28. Never hand over a file without it. Assert:
- no duplicate OP IDs
- every row is in the INTENT set
- every row matches the expected REALITY state (e.g. all currently Open/blank)
- every row has the correct TARGET values (e.g. all Close Reason == DUPLICATE)
- every URL contains its own OP ID
Then write the file, READ IT BACK from disk, and re-assert row count + a sample of values.
Only after all assertions pass do you present it. Show Matthew the check results.

### Step 5 — If REALITY is stale or missing, say so and recommend a fresh scrape
Scrapes age. If two scrapes disagree, the newer one wins, but flag the disagreement. If you
cannot establish current state, build a CHECK sheet (OP ID + URL only) for a Read Lead Status
pass rather than guessing. Never action on stale state without flagging it.

---

## OUTPUT SHEET CONVENTIONS

- Save to `upcoming/results/` with name `MMDDYYYY_HHMM_<Purpose>-<COUNT>.xlsx`
  (e.g. `05282026_1155_VoidLead-FIX-DUPLICATE-336.xlsx`). The count in the name is a built-in
  sanity check — it must equal the row count.
- A "ready to run" void/close sheet has columns: `OP ID | URL | Won Status | Close Reason`
  (plus any others the flow reads). A "check" sheet has just `OP ID | URL`.
- Use SheetJS from the repo: `require(path.join(ROOT,"node_modules","xlsx"))`. There is no
  Python/openpyxl here.
- Build/verify with a Node REPL (`start_process node -i`). On Windows, avoid inline `node -e`
  with complex strings and avoid PowerShell heredocs — both mangle quoting. Use the REPL or a
  written .js file.

---

## CRITICAL CAVEAT: journals UNDER-REPORT success

Do NOT use journal `skip`/`error` status to decide a lead still needs work. Proven on
2026-05-28: a live check of 4,100 journal-"skipped" rows found 2,834 were actually already
Void in PestPac. The runner emits skip even when the write persisted (post-save dialog /
navigation race / action timeout confuses the result). So:
- REALITY (live scrape) decides what still needs work. Journals only help explain WHY.
- "It skipped" never means "it did not happen." Verify against the scrape.
- This is exactly what v2.3 item 25 (verify-after-failure) is meant to fix in BUU itself.

---

## ROOT-CAUSE WATCH: the close-reason flattening trap

The 336-lead mislabel originated because a run sheet had a BLANKET close reason (CLEANUP on
every row) instead of per-lead values. Two defenses:
   value applied to all rows (unless the task genuinely is uniform).
   COLUMN, not a literal typed into the step. A hardcoded step value silently overrides the
   column and re-flattens everything. Tell Matthew to check this.

1. When building a sheet, set each row target from its INTENT, never a single hardcoded value
   applied to all rows (unless the task genuinely is uniform across every lead).
2. Before any rerun, confirm the BUU flow Close Reason step reads the {{Close Reason}} COLUMN,
   not a literal typed into the step. A hardcoded step value silently overrides the column and
   re-flattens everything. Tell Matthew to check this.

---

## WORKED EXAMPLE (the 336 duplicate-reason fix, 2026-05-28)

Goal: which Duplicate-Clean-Up leads are still wrong, and build a fix sheet.

```javascript
const fs=require("fs"), path=require("path");
const ROOT="C:/Users/bigma/OneDrive/Desktop/Better Update Utility";
const XLSX=require(path.join(ROOT,"node_modules","xlsx"));

// INTENT: original duplicate list (should all be DUPLICATE). Header on row 1.
const dup=XLSX.utils.sheet_to_json(XLSX.readFile(INTENT_PATH).Sheets["New Advanced Report"],{range:1,defval:""});
const shouldBeDup=new Set(dup.map(r=>String(r["Opp ID"]).trim()).filter(Boolean));

// REALITY: live scrape. Build OP ID -> state map.
const scrape=XLSX.utils.sheet_to_json(XLSX.readFile(REALITY_PATH).Sheets["Read fields"],{defval:""});
const byId=new Map(scrape.map(r=>[String(r["OP ID"]).trim(),r]));

// RESULT: should-be-DUPLICATE AND currently Open/blank (i.e. not yet done correctly).
const fix=[];
for(const id of shouldBeDup){
  const s=byId.get(id); if(!s) continue;
  if(String(s["Won Status (raw)"]).trim()==="O" && String(s["Close Reason (raw)"]).trim()===""){
    fix.push({"OP ID":id, URL:"https://app.pestpac.com/leads/detail.asp?Mode=Edit&SalesOppID="+id+"&StatusType=", "Won Status":"Void", "Close Reason":"DUPLICATE"});
  }
}
fix.sort((a,b)=>Number(a["OP ID"])-Number(b["OP ID"]));

// VERIFY (all must be true before writing)
const ids=fix.map(r=>String(r["OP ID"]));
console.assert(ids.length===new Set(ids).size, "dupe ids");
console.assert(fix.every(r=>shouldBeDup.has(String(r["OP ID"]))), "not all intent");
console.assert(fix.every(r=>r["Close Reason"]==="DUPLICATE"&&r["Won Status"]==="Void"), "target wrong");
console.assert(fix.every(r=>r.URL.includes("SalesOppID="+r["OP ID"])), "url mismatch");

// WRITE then READ BACK and re-verify
XLSX.writeFile(/*wb from fix*/, OUT_PATH);
const rb=XLSX.utils.sheet_to_json(XLSX.readFile(OUT_PATH).Sheets[SHEET],{defval:""});
console.assert(rb.length===fix.length, "row count drifted on disk");
```

Result: 336 rows, every check green, identical to an independent derivation. THAT is the bar.

---

## CHECKLIST (the short version — run through it every time)

- [ ] Located the real files (searched, did not trust stated path)
- [ ] Identified INTENT source and REALITY source explicitly
- [ ] Printed Object.keys() of every source before using columns
- [ ] Derived from ROOTS, not from any intermediate/previously-built sheet
- [ ] Set per-row targets from intent (no blanket value unless truly uniform)
- [ ] Verified in memory: no dupes / all intent / right state / right target / url matches id
- [ ] Wrote file, read it back, re-verified count + sample
- [ ] Filename count matches row count
- [ ] Flagged any stale-scrape ambiguity; recommended fresh scrape if needed
- [ ] Reminded Matthew to confirm the flow reads the {{Close Reason}} column, not a hardcoded value
- [ ] Showed Matthew the verification results, not just the file

---

*Created 2026-05-28 after the 336-lead CLEANUP/DUPLICATE mislabel. The lesson encoded here:
the data (intent lists + live scrapes + journals) is enough to be deterministic — the job is to
use the roots and verify, every time, before handing anything over.*

