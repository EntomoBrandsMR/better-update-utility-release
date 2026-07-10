#!/usr/bin/env node
// _compare-golden.js <baseline.jsonl> <candidate.jsonl>
// PASS = per-row terminal status matches after normalizing "ok (retry)" -> "ok".
// Retry deltas + dialog-count diffs reported as INFO, never failure.
'use strict';
const fs = require('fs');

function load(p) {
  const rows = new Map(); const dlg = new Map(); let retries = 0;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o.t === 'dlg') { dlg.set(o.r, (dlg.get(o.r) || 0) + 1); continue; }
    if (o.r !== undefined && o.s !== undefined) {
      const norm = String(o.s).startsWith('ok') ? 'ok' : 'error';
      if (String(o.s).includes('retry')) retries++;
      rows.set(o.r, { raw: o.s, norm }); // later line wins (append-only)
    }
  }
  return { rows, dlg, retries };
}

const [, , basePath, candPath] = process.argv;
if (!basePath || !candPath) {
  console.error('usage: node _compare-golden.js <baseline.jsonl> <candidate.jsonl>');
  process.exit(2);
}
const B = load(basePath), C = load(candPath);
let fail = 0;
const allRows = new Set([...B.rows.keys(), ...C.rows.keys()]);
for (const r of [...allRows].sort((a, b) => a - b)) {
  const b = B.rows.get(r), c = C.rows.get(r);
  if (!b) { console.log(`FAIL row ${r}: not in baseline (cand: ${c.raw})`); fail++; continue; }
  if (!c) { console.log(`FAIL row ${r}: missing in candidate (base: ${b.raw})`); fail++; continue; }
  if (b.norm !== c.norm) { console.log(`FAIL row ${r}: ${b.raw} -> ${c.raw}`); fail++; continue; }
  const note = b.raw !== c.raw ? `  (raw: ${b.raw} -> ${c.raw})` : '';
  const dd = (B.dlg.get(r) || 0) !== (C.dlg.get(r) || 0)
    ? `  [dialogs ${B.dlg.get(r) || 0} -> ${C.dlg.get(r) || 0}]` : '';
  console.log(`ok   row ${r}${note}${dd}`);
}
console.log(`INFO retries: baseline=${B.retries} candidate=${C.retries}`);
console.log(fail ? `RESULT: FAIL (${fail} row diffs)` : 'RESULT: PASS');
process.exit(fail ? 1 : 0);
