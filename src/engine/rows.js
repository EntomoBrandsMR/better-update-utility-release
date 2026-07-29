// engine/rows.js — THE spreadsheet ingestion module. SINGLE SOURCE for loading,
// counting, and header-reading spreadsheets (.xlsx / .xls / .csv). Consumed two ways:
//   1. require()d by the main process (staging count, results workbook, preview),
//   2. interpolated VERBATIM into the pool worker via ${ROWS_SRC} (the worker declares
//      `const XLSX = _require('xlsx')` before this file is inlined; the functions pick
//      up that global — under require() they load the xlsx module themselves).
// Do NOT add a second copy of any of this anywhere.
//
// v3.0.2 HEADER CONTRACT lives here: row keys are TRIMMED once at load — only when a
// header is actually dirty, so clean 25k-row sheets pay nothing — paired with the token
// resolver's ref-trim (engine/tokens.js) so {{Account Number}} matches "Account Number ".
//
// R6 (3.2.0): CSV parsing goes through the xlsx library EVERYWHERE. The worker's old
// hand-rolled split(',') broke on quoted commas and blank-ish lines, so the coordinator
// (xlsx-parsed) and the worker (hand-parsed) could disagree about the SAME file's rows.
// One parser now: the row count staging shows is exactly the set of rows a worker runs.
function _buuXlsxLib(){ return (typeof XLSX !== 'undefined') ? XLSX : require('xlsx'); }

// Trim row-object keys when (and only when) a header carries stray whitespace.
function buuTrimRowKeys(rows){
  if(!Array.isArray(rows) || !rows.length) return rows;
  let dirty = false;
  for(const k in rows[0]){ if(k !== String(k).trim()){ dirty = true; break; } }
  if(!dirty) return rows;
  return rows.map(function(r){ const o = {}; for(const k in r) o[String(k).trim()] = r[k]; return o; });
}

// Full load: array of row objects, every header present on every row (defval:''),
// keys trimmed per the v3.0.2 contract. NOTE: cell VALUES may be typed (a CSV "1"
// arrives as the number 1) — exactly how xlsx sheets have always arrived; every
// consumer goes through resolveToken/String(), so tokens always substitute as text.
function buuLoadRows(fp){
  const X = _buuXlsxLib();
  const isCsv = String(fp).toLowerCase().endsWith('.csv');
  const wb = isCsv ? X.readFile(fp, { raw: false }) : X.readFile(fp);
  return buuTrimRowKeys(X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }));
}

// Data-row count. Same truth as buuLoadRows — what staging counts is what workers run.
function buuCountRows(fp){
  try { return buuLoadRows(fp).length; } catch (e) { return 0; }
}

// Header row only (order preserved, trimmed, blanks dropped) — cheap: reads one row.
function buuReadHeaders(fp){
  const X = _buuXlsxLib();
  const isCsv = String(fp).toLowerCase().endsWith('.csv');
  const wb = isCsv ? X.readFile(fp, { sheetRows: 1, raw: false }) : X.readFile(fp, { sheetRows: 1 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const hdr = (X.utils.sheet_to_json(ws, { header: 1, defval: '' })[0]) || [];
  return hdr.map(function(h){ return String(h).trim(); }).filter(Boolean);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = { buuLoadRows, buuCountRows, buuReadHeaders, buuTrimRowKeys }; }
