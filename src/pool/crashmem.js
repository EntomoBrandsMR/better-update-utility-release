'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 3.2.1 PAGE-CRASH GOVERNOR + MEMORY GOVERNOR — pure helpers & tunables.
// This module has NO electron/fs/child_process dependency ON PURPOSE: coordinator.js
// cannot be required under plain node (it pulls electron), so the crash/memory decision
// logic lives here where the offline test can require and exercise it directly. The
// coordinator requires this module and uses these exact functions/constants — one source
// of truth for the thresholds, so the tests and the shipping code can never drift.
//
// Design (Matthew, 2026-07-29/30):
//  • A renderer that crashes tears the worker DOWN (worker exits; the eval commissions a
//    replacement) — we never rebuild the page in a worker whose memory already blew up.
//  • A crash is "young" — a HOST-PRESSURE signal — when the worker had done little work.
//    A worker that ran thousands of rows then died is normal Chromium bloat, NOT a ratchet
//    trigger. Only young crashes count toward the cluster ratchet.
//  • N young crashes clustered in a window ratchet the worker ceiling DOWN and HOLD it for
//    the rest of the run, so the pool stops refilling into the same wall.
//  • A single ROW that keeps crashing workers is a poison row: quarantine it (error, don't
//    requeue) so one bad account can't kill worker after worker.
//  • Every eval cycle (same cadence as the license check) we measure each worker's real
//    process-tree footprint and recycle the fat ones before they OOM-crash.
// ─────────────────────────────────────────────────────────────────────────────

const CRASH_POISON_CAP = 3;          // a row that has crashed >= this many workers is quarantined
const CRASH_RATCHET_N = 3;           // this many YOUNG crashes within the window ratchets the ceiling down
const CRASH_RATCHET_WINDOW_MS = 300000; // 5-min clustering window for "repeated" young crashes
const CRASH_YOUNG_ROWS = 200;        // a crash is young if the worker completed fewer than this many rows...
const CRASH_YOUNG_MS = 180000;       // ...OR lived less than this long (3 min)
const DEFAULT_WORKER_MEM_MB = 1500;  // recycle a worker whose tree RSS exceeds this (config.workerMemThresholdMB overrides; 0 disables)

// A young crash = host pressure, not end-of-life bloat. `rowsDone` OR short life qualifies.
function isYoungCrash(rowsDone, ageMs){
  return (Number(rowsDone) || 0) < CRASH_YOUNG_ROWS || (Number(ageMs) || 0) < CRASH_YOUNG_MS;
}

// A poison row has now crashed CRASH_POISON_CAP workers — stop feeding it to fresh ones.
function isPoisonRow(rowCrashes){
  return (Number(rowCrashes) || 0) >= CRASH_POISON_CAP;
}

// The cluster ratchet trips once this many young crashes have landed inside the window.
function shouldRatchet(youngCrashCount){
  return (Number(youngCrashCount) || 0) >= CRASH_RATCHET_N;
}

// Keep only crash timestamps still inside the clustering window ending at `now`.
function recentCrashTimes(times, now){
  const cutoff = (Number(now) || 0) - CRASH_RATCHET_WINDOW_MS;
  return (Array.isArray(times) ? times : []).filter(t => t >= cutoff);
}

// Sum a process subtree's working-set (bytes) from a flat Win32_Process snapshot
// ([{ProcessId, ParentProcessId, WorkingSetSize}, ...]), walking children down from rootPid.
// The bloat lives in the Chromium renderer child, not the little node worker, so we MUST sum
// the whole subtree — the worker's own RSS alone would badly understate the footprint.
function coordSumProcessTree(procList, rootPid){
  const rss = new Map(), byParent = new Map();
  for (const p of (Array.isArray(procList) ? procList : [])){
    const pid = Number(p.ProcessId), ppid = Number(p.ParentProcessId);
    rss.set(pid, Number(p.WorkingSetSize) || 0);
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  let total = 0; const seen = new Set(), stack = [Number(rootPid)];
  while (stack.length){
    const pid = stack.pop();
    if (seen.has(pid)) continue;      // guards against pid-reuse cycles in the snapshot
    seen.add(pid);
    total += rss.get(pid) || 0;
    const kids = byParent.get(pid);
    if (kids) for (const k of kids) stack.push(k);
  }
  return total;
}

// Est. time left (ms) from remaining rows and rows/min. 0 when unknown (no work left, or no
// throughput yet — e.g. a once-flow), which the scheduler backstop treats as "fall back to
// the reserved block length". Used by the scheduler's block-end re-arm fork.
function estLeftMs(remainingRows, rowsPerMin){
  const r = Number(remainingRows) || 0, rpm = Number(rowsPerMin) || 0;
  if (r > 0 && rpm > 0) return Math.ceil(r / rpm) * 60000;
  return 0;
}

module.exports = {
  CRASH_POISON_CAP, CRASH_RATCHET_N, CRASH_RATCHET_WINDOW_MS, CRASH_YOUNG_ROWS, CRASH_YOUNG_MS, DEFAULT_WORKER_MEM_MB,
  isYoungCrash, isPoisonRow, shouldRatchet, recentCrashTimes, coordSumProcessTree, estLeftMs,
};
