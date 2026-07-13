// _test-r1-journal.js — offline semantics test for the R1 journal writer + reader.
// Stubs electron's app.getPath into a temp dir; exercises: normalization, reasons,
// ok-wins + sup marking, requeued-not-completed, in-flight surfacing, spill merge.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buu-r1-'));
require.cache[require.resolve('electron')] = { exports: { app: { getPath: () => tmp } } };

const journalMod = require(path.join(__dirname, '..', 'src', 'journal.js'));
const COORD = { jobs: new Map(), setupScope: 'per-worker', startMode: 'run-all', startModeTarget: { workers: 1 }, diagnosticCapture: 'off', captureBucketCap: 0 };
COORD.jobs.set('jobA', { jobId: 'jobA', label: 'T', spreadsheetPath: 'x.xlsx', profileId: 'p', errHandle: 'skip', totalRows: 5, flowSteps: [], retryCount: 2, retryRowIndexes: null, reauthIntervalMin: 0, startRow: 1 });
const J = journalMod({ COORD });

let fails = 0;
function ok(cond, name) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; }

J.coordOpenJournal();
const poolId = COORD.poolId;
J.coordJournalAppend('jobA', 1, 'ok', { durationMs: 1200 });
J.coordJournalAppend('jobA', 2, 'error', { reason: 'timeout', error: 'selector wait timed out' });
J.coordJournalAppend('jobA', 2, 'ok (retry)');
J.coordJournalAppend('jobA', 3, 'error', { reason: 'requeued', error: 'worker died mid-row' });
J.coordJournalAppend('jobA', 1, 'error', { error: 'late duplicate' }); // ok already won -> sup
J.coordJournalAppendDialog('jobA', 2, 'Do you want X?', 'confirm', 'ts');

const lines = fs.readFileSync(path.join(tmp, 'pool-journal-' + poolId + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
ok(lines.length === 6, 'six lines written (flush-per-row)');
ok(lines[2].s === 'ok' && lines[2].rs === 'after-retry', "'ok (retry)' normalized to ok + after-retry");
ok(lines[1].rs === 'timeout' && lines[1].e && lines[1].ms === undefined, 'reason + error captured');
ok(lines[4].sup === 1 && lines[4].s === 'error', 'late line after ok is sup-marked');
ok(lines[0].ms === 1200 && !!lines[0].ts, 'duration + timestamp on lines');

const st = journalMod.readJournalRowStates(poolId);
ok(st.completedByJob.jobA && st.completedByJob.jobA.has(1) && st.completedByJob.jobA.has(2), 'rows 1,2 completed (ok-wins over sup line)');
ok(!st.completedByJob.jobA.has(3), 'requeued row 3 NOT a completion');
ok(st.inFlight.length === 1 && st.inFlight[0].r === 3, 'row 3 surfaced as in-flight');

// spill merge (prefix-fix regression test)
fs.writeFileSync(path.join(tmp, 'journal-spill-wtest.jsonl'), JSON.stringify({ poolId, j: 'jobA', r: 4, s: 'ok', error: '', ts: 'x' }) + '\n');
const merged = journalMod.mergeSpillFiles();
ok(merged === 1, 'spill merged 1 line');
const st2 = journalMod.readJournalRowStates(poolId);
ok(st2.completedByJob.jobA.has(4), 'spilled row 4 counts completed after merge');
ok(!fs.existsSync(path.join(tmp, 'journal-spill-wtest.jsonl')), 'spill file deleted after merge');

console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS');
process.exit(fails ? 1 : 0);
