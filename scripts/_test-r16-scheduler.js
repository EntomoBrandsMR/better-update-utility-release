// _test-r16-scheduler.js — offline semantics test for the R16 zone/fire math.
// No electron needed (pure module). Exercises: zone conversion vs UTC, DST spring gap,
// daily/weekly/monthly nextFire in a non-machine zone, once expiry, overlap detection.
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'src', 'scheduler.js'));
let fails = 0;
function ok(cond, name, extra) { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : '')); if (!cond) fails++; }

// 1) zonedEpoch: 2026-01-15 09:00 America/New_York is UTC-5 -> 14:00 UTC.
const jan = S.zonedEpoch(2026, 1, 15, 9, 0, 'America/New_York');
ok(jan === Date.UTC(2026, 0, 15, 14, 0), 'EST winter conversion', new Date(jan).toISOString());

// 2) 2026-07-15 09:00 New York is UTC-4 (EDT) -> 13:00 UTC.
const jul = S.zonedEpoch(2026, 7, 15, 9, 0, 'America/New_York');
ok(jul === Date.UTC(2026, 6, 15, 13, 0), 'EDT summer conversion', new Date(jul).toISOString());

// 3) Spring-forward gap: 2026-03-08 02:30 New York does not exist; must resolve to an
//    ADJACENT instant (either gap edge: 01:30 EST = 06:30 UTC or 03:30 EDT = 07:30 UTC).
const gap = S.zonedEpoch(2026, 3, 8, 2, 30, 'America/New_York');
ok(gap === Date.UTC(2026, 2, 8, 7, 30) || gap === Date.UTC(2026, 2, 8, 6, 30), 'DST gap resolves to an adjacent instant', new Date(gap).toISOString());

// 4) daily nextFire from a UTC "VM clock" instant: after 2026-07-14 20:00 UTC (16:00 EDT),
//    a daily 09:00 New York schedule fires next at 2026-07-15 13:00 UTC.
const daily = { type: 'daily', time: '09:00', tz: 'America/New_York' };
const nf1 = S.nextFire(daily, Date.UTC(2026, 6, 14, 20, 0));
ok(nf1 === Date.UTC(2026, 6, 15, 13, 0), 'daily rolls to tomorrow in-zone', new Date(nf1).toISOString());

// 5) same daily, asked at 2026-07-15 08:59 New York (12:59 UTC) -> fires TODAY 13:00 UTC.
const nf2 = S.nextFire(daily, Date.UTC(2026, 6, 15, 12, 59));
ok(nf2 === Date.UTC(2026, 6, 15, 13, 0), 'daily fires later today', new Date(nf2).toISOString());

// 6) weekly Mon+Fri 07:00 Chicago: after Tue 2026-07-14 -> Fri 2026-07-17 12:00 UTC (CDT=UTC-5).
const weekly = { type: 'weekly', days: [1, 5], time: '07:00', tz: 'America/Chicago' };
const nf3 = S.nextFire(weekly, Date.UTC(2026, 6, 14, 20, 0));
ok(nf3 === Date.UTC(2026, 6, 17, 12, 0), 'weekly picks next enabled weekday', new Date(nf3).toISOString());

// 7) monthly day 31 skips 30-day months: after 2026-04-01 -> 2026-05-31 (April has 30 days).
const monthly = { type: 'monthly', dayOfMonth: 31, time: '12:00', tz: 'UTC' };
const nf4 = S.nextFire(monthly, Date.UTC(2026, 3, 1, 0, 0));
ok(nf4 === Date.UTC(2026, 4, 31, 12, 0), 'monthly day-31 skips April', new Date(nf4).toISOString());

// 8) once in the past -> null; in the future -> exact.
ok(S.nextFire({ type: 'once', date: '2026-01-01', time: '10:00', tz: 'UTC' }, Date.now()) === null, 'expired once is null');
const nf5 = S.nextFire({ type: 'once', date: '2026-12-25', time: '10:00', tz: 'UTC' }, Date.now());
ok(nf5 === Date.UTC(2026, 11, 25, 10, 0), 'future once exact', new Date(nf5).toISOString());

// 9) overlap: two dailies 10 minutes apart with 15-min blocks collide; 20 apart don't.
const a = { id: 'a', flowName: 'A', type: 'daily', time: '09:00', tz: 'UTC', blockMin: 15, enabled: true };
const b = { id: 'b', flowName: 'B', type: 'daily', time: '09:10', tz: 'UTC', blockMin: 15, enabled: true };
const b2 = { id: 'b2', flowName: 'B2', type: 'daily', time: '09:20', tz: 'UTC', blockMin: 15, enabled: true };
ok(!!S.findOverlap(a, [b], Date.now()), 'overlapping blocks refused');
ok(S.findOverlap(a, [b2], Date.now()) === null, 'non-overlapping blocks pass');

console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS');
process.exit(fails ? 1 : 0);
