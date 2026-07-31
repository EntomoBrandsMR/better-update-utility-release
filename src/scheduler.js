// src/scheduler.js — R16: scheduled runs for spreadsheet-free (once) flows ONLY.
// No cron. Schedule types: once (date+time) / daily / weekly (day set) / monthly (day N).
// Every schedule carries an EXPLICIT IANA timezone (default America/New_York) — fire
// times are computed from that zone regardless of the machine clock, which is the whole
// point for a future VM whose clock may be UTC. Each schedule reserves a time block
// (default 15 min); the editor refuses overlapping blocks across the next 14 days.
// Persisted one JSON per schedule under <buuRoot>/schedules/; loaded on start.
// Missed-while-closed schedules surface as a per-flow popup on launch: Run now / Skip.
'use strict';
const fs = require('fs');
const path = require('path');
const CM = require('./pool/crashmem'); // 3.2.1: shared est-left-time formula (also used by the coordinator's backstop re-arm)

const DAY_MS = 86400000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// What does `epoch` read as on a wall clock in `tz`?
function partsInZone(epoch, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  for (const q of f.formatToParts(new Date(epoch))) p[q.type] = q.value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    hh: +(p.hour === '24' ? '0' : p.hour), mm: +p.minute,
    wd: WD.indexOf(p.weekday),
  };
}

// Epoch of a wall-clock time IN tz. Guess UTC, measure the guess in the zone, correct
// by the difference; a second pass settles DST edges. (Times inside the spring-forward
// gap don't exist — they resolve to an ADJACENT instant, ±1h, verified pre-gap edge in
// the unit test; fall-back ambiguity resolves to one of the two occurrences. Both are
// acceptable for run scheduling: one odd hour, once a year, on a nonexistent wall time.)
function zonedEpoch(y, mo, d, hh, mm, tz) {
  let guess = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  for (let i = 0; i < 2; i++) {
    const p = partsInZone(guess, tz);
    const asIf = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm, 0, 0);
    guess += Date.UTC(y, mo - 1, d, hh, mm, 0, 0) - asIf;
  }
  return guess;
}

// Next fire time strictly AFTER `after` (epoch ms), or null (disabled/expired once).
function nextFire(s, after) {
  if (!s) return null;
  const t = String(s.time || '09:00').split(':');
  const hh = parseInt(t[0], 10) || 0, mm = parseInt(t[1], 10) || 0;
  const tz = s.tz || 'America/New_York';
  if (s.type === 'once') {
    const dd = String(s.date || '').split('-').map(Number);
    if (!dd[0]) return null;
    const fire = zonedEpoch(dd[0], dd[1], dd[2], hh, mm, tz);
    return fire > after ? fire : null;
  }
  // Walk zone-days forward from `after` (62 covers any monthly gap incl. day-31 months).
  for (let k = 0; k < 62; k++) {
    const probe = partsInZone(after + k * DAY_MS, tz);
    if (s.type === 'weekly' && (!Array.isArray(s.days) || !s.days.includes(probe.wd))) continue;
    if (s.type === 'monthly' && probe.d !== (parseInt(s.dayOfMonth, 10) || 1)) continue;
    const fire = zonedEpoch(probe.y, probe.mo, probe.d, hh, mm, tz);
    if (fire > after) return fire;
  }
  return null;
}

// All fire times for `s` within [from, from+horizonDays), for the overlap check.
function firesWithin(s, from, horizonDays) {
  const out = [];
  let cursor = from;
  const end = from + horizonDays * DAY_MS;
  for (let i = 0; i < 200; i++) {
    const f = nextFire(s, cursor);
    if (f == null || f >= end) break;
    out.push(f);
    cursor = f;
  }
  return out;
}

// Would candidate's reserved blocks overlap any OTHER enabled schedule's over 14 days?
// Returns null or a human-readable description of the first collision.
function findOverlap(candidate, others, now) {
  const horizon = 14;
  const cBlock = Math.max(1, parseInt(candidate.blockMin, 10) || 15) * 60000;
  const cFires = firesWithin(candidate, now, horizon);
  for (const o of others) {
    if (!o || o.id === candidate.id || o.enabled === false) continue;
    const oBlock = Math.max(1, parseInt(o.blockMin, 10) || 15) * 60000;
    const oFires = firesWithin(o, now, horizon);
    for (const cf of cFires) {
      for (const of2 of oFires) {
        if (cf < of2 + oBlock && of2 < cf + cBlock) {
          return 'collides with "' + (o.flowName || o.id) + '" at ' + new Date(Math.max(cf, of2)).toLocaleString()
            + ' (blocks: ' + (cBlock / 60000) + 'min vs ' + (oBlock / 60000) + 'min)';
        }
      }
    }
  }
  return null;
}

module.exports = { partsInZone, zonedEpoch, nextFire, firesWithin, findOverlap, DAY_MS };

// ─────────────────────────────────────────────────────────────────────────────
// Runtime. Main wires this once at startup. The scheduler never calls pool code
// directly — it sends a complete launch payload to the renderer, which is a dumb
// pipe into the existing pool-submit-job/pool-start IPC (zero renderer state).
// ─────────────────────────────────────────────────────────────────────────────
// 3.x run-notification email helpers.
const mailer = require('./mailer');
function _ordinal(n){ const s=['th','st','nd','rd'], v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }
function _timeLabel(t){ const p=String(t||'09:00').split(':'); let h=parseInt(p[0],10)||0; const m=(p[1]||'00'); const ap=h>=12?'PM':'AM'; h=h%12; if(h===0)h=12; return h+':'+m+' '+ap; }
const _DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
// R6: _DOW3 deleted — it duplicated WD (top of file) verbatim.
function _freqPhrase(s){
  if(s.type==='daily') return 'daily';
  if(s.type==='once') return 'once';
  if(s.type==='monthly') return 'monthly on the ' + _ordinal(parseInt(s.dayOfMonth,10)||1);
  if(s.type==='weekly'){
    const days=(Array.isArray(s.days)?s.days:[]).slice().sort((a,b)=>a-b);
    if(days.length===0) return 'weekly';
    if(days.length===1) return 'weekly on ' + _DOW[days[0]] + 's';
    return 'weekly on ' + days.map(d=>WD[d]).join(', ');
  }
  return String(s.type||'once');
}

function initScheduler(deps) {
  // deps: { app, ipcMain, buuRoot, COORD, getWindow, readFlowByName, keytar }
  const { app, ipcMain, buuRoot, COORD, getWindow, readFlowByName, keytar } = deps;
  const dir = () => { const d = path.join(buuRoot(), 'schedules'); try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} return d; };
  let watch = null; // 3.2.1: { id, firedAt, blockMs, launched, done, emailed, rearms, timer } — the in-flight fired run

  function loadAll() {
    const out = [];
    try {
      for (const f of fs.readdirSync(dir()).filter(x => x.endsWith('.json'))) {
        try { out.push(JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'))); } catch (e) {}
      }
    } catch (e) {}
    return out;
  }
  function saveOne(s) { try { fs.writeFileSync(path.join(dir(), s.id + '.json'), JSON.stringify(s, null, 2)); } catch (e) {} }
  function deleteOne(id) { try { fs.unlinkSync(path.join(dir(), String(id).replace(/[^\w-]/g, '') + '.json')); } catch (e) {} }
  function send(ch, d) { try { const w = getWindow(); if (w) w.webContents.send(ch, d); } catch (e) {} }

  // 3.x: send the run-notification email for a completed scheduled run (best-effort; never
  // throws into the tick loop). Uses the step trail the coordinator captured (COORD._lastRunTrail).
  function maybeSendEmail(s, j, startTs, endTs) {
    try {
      if (!s || !s.emailNotify) return;
      const err = (j && j.err) || 0;
      if (s.emailOnlyOnFailure && err === 0) return; // "only on failure" opt-in
      const to = (s.emailTo && String(s.emailTo).trim()) || 'pestpac-help@palmettoexterminators.net';
      const trailObj = COORD._lastRunTrail;
      const trail = (trailObj && Array.isArray(trailObj.steps)) ? trailObj.steps : [];
      const data = {
        flowName: s.flowName,
        frequencyPhrase: _freqPhrase(s),
        scheduleTimeLabel: _timeLabel(s.time),
        tz: s.tz || 'America/New_York',
        startTs: startTs, endTs: endTs,
        ok: (j && j.ok) || 0, err: err, total: (j && j.totalRows) || 1,
        trail: trail,
        errorText: (trailObj && trailObj.error) || '',
        poolId: COORD.poolId,
        recipients: to,
      };
      const built = mailer.buildRunEmail(data);
      mailer.sendMail(keytar, { to: to, subject: built.subject, body: built.html, html: true })
        .then(() => { try { const cur = loadAll().find(x => x.id === s.id); if (cur) { cur.lastResult = Object.assign({}, cur.lastResult, { emailed: true }); saveOne(cur); send('schedules-changed', {}); } } catch (e) {} })
        .catch((e2) => { console.error('[scheduler] run-notification email failed:', e2.message); try { const cur = loadAll().find(x => x.id === s.id); if (cur) { cur.lastResult = Object.assign({}, cur.lastResult, { emailError: e2.message }); saveOne(cur); send('schedules-changed', {}); } } catch (e) {} });
    } catch (e) { console.error('[scheduler] email build failed:', e.message); }
  }
  function summarize(s) {
    const nf = s.enabled === false ? null : nextFire(s, Math.max(Date.now(), s.lastFiredAt || 0));
    return Object.assign({}, s, { nextFireTs: nf, nextFireLocal: nf ? new Date(nf).toLocaleString() : null });
  }

  // ── 3.2.1 EVENT-DRIVEN COMPLETION + BLOCK-END BACKSTOP ──────────────────────
  // The old design polled COORD.active every 30s to detect completion. A run that
  // STARTED and FINISHED inside one 30s gap was never observed active, so it got a false
  // never-started error and NO email went out — while a slower FAILING run WAS observed
  // and emailed (the exact 07-29 VM symptom). Completion is now event-driven off the real
  // pool-complete signal (COORD.onPoolComplete, wired below, fired in-process the instant
  // the pool drains), so run DURATION no longer decides whether the email fires. A
  // self-scheduling block-end backstop guarantees we ALWAYS reconcile even if that signal
  // is somehow missed, and re-arms with the run's own est-left-time while it is still going.

  // Est. time left (ms) for the live run, from the same rows/min + remaining the UI shows.
  // 0 when unknown (e.g. a once-flow with no per-row throughput) — caller falls back.
  function estLeftMs(){
    try {
      let remaining = 0;
      for (const j of COORD.jobs.values()) remaining += Math.max(0, (j.totalRows||0) - Math.max(0,(j.nextRow||1)-1)) + (j.requeue ? j.requeue.length : 0);
      return CM.estLeftMs(remaining, Number(COORD.throughput) || 0); // rows + rows/min -> ms (0 = unknown; caller falls back to the block length)
    } catch (e) {}
    return 0;
  }

  // Reconcile ONCE per fire: record the result and send the email if it hasn't gone yet.
  // Idempotent — whichever of {pool-complete hook, backstop} reaches it first wins; the
  // other no-ops (watch.done). `j` is the run's job (may be null on the never-started path).
  function finalize(nowTs, resultObj, j){
    if (!watch || watch.done) return;
    watch.done = true;
    if (watch.timer) { try { clearTimeout(watch.timer); } catch (e) {} watch.timer = null; }
    const s = loadAll().find(x => x.id === watch.id);
    if (s) {
      s.lastResult = resultObj; saveOne(s); send('schedules-changed', {});
      // "if the run is done it checks to see if the worker emailed, if not then it does":
      if (!watch.emailed) { watch.emailed = true; maybeSendEmail(s, j, watch.firedAt, nowTs); }
    }
    watch = null;
  }

  // THE real completion signal. The coordinator calls this in-process the moment the pool
  // drains (see coordinator.js pool-complete). Duration-independent — this is the fix.
  function onPoolCompleteInternal(){
    if (!watch || watch.done) return; // no scheduled run in flight (e.g. a human Run) — ignore
    const now = Date.now();
    const j = Array.from(COORD.jobs.values())[0];
    finalize(now, { ts: now, status: (j && j.err) ? 'errors' : 'ok', ok: (j && j.ok) || 0, err: (j && j.err) || 0 }, j);
  }

  // Block-end backstop. The FIRST check is mandatory at the reserved block length (there is
  // no est-left-time at the very start). If the run is still going, re-arm with est-left + 60s
  // grace and check again — a fork loop that "always checks" until the run is done.
  function armBackstop(waitMs){
    if (!watch) return;
    try { if (watch.timer) clearTimeout(watch.timer); } catch (e) {}
    watch.timer = setTimeout(() => {
      if (!watch || watch.done) return;
      if (COORD.active) {
        // still running — re-arm off the live ETA (+60s), with a stall ceiling so a run that
        // never reports done can't spin timers forever.
        if ((watch.rearms = (watch.rearms||0) + 1) > 120) {
          finalize(Date.now(), { ts: Date.now(), status: 'error', error: 'run exceeded its maximum wait window (see live log)' }, Array.from(COORD.jobs.values())[0]);
          return;
        }
        armBackstop(Math.min(3600000, (estLeftMs() || watch.blockMs) + 60000));
        return;
      }
      // Not active. If the run launched, it FINISHED and the pool-complete hook was somehow
      // missed — reconcile from the job (belt-and-suspenders). If it never launched, it truly
      // did not start (renderer never confirmed launch): record it (not a run outcome to email).
      if (watch.launched) {
        const j = Array.from(COORD.jobs.values())[0];
        finalize(Date.now(), { ts: Date.now(), status: (j && j.err) ? 'errors' : 'ok', ok: (j && j.ok) || 0, err: (j && j.err) || 0 }, j);
      } else {
        const s = loadAll().find(x => x.id === watch.id);
        if (s) { s.lastResult = { ts: Date.now(), status: 'error', error: 'run did not start within its reserved block (see live log)' }; saveOne(s); send('schedules-changed', {}); }
        watch = null;
      }
    }, Math.max(1000, waitMs|0));
  }

  function fire(s, dueTs, manual) {
    s.lastFiredAt = dueTs || Date.now(); // advance FIRST — a crash mid-fire must not double-fire
    saveOne(s);
    const fr = readFlowByName(s.flowName);
    if (!fr) { s.lastResult = { ts: Date.now(), status: 'error', error: 'flow "' + s.flowName + '" not found' }; saveOne(s); send('schedules-changed', {}); return; }
    let flow; try { flow = JSON.parse(fr.json); } catch (e) { s.lastResult = { ts: Date.now(), status: 'error', error: 'flow unreadable' }; saveOne(s); return; }
    watch = { id: s.id, firedAt: Date.now(), blockMs: Math.max(1, parseInt(s.blockMin, 10) || 15) * 60000, launched: false, done: false, emailed: false, rearms: 0, timer: null };
    // 3.0.4 SINGLE CODE PATH: the scheduler no longer builds a launch payload. It names
    // the flow and the renderer runs it through the EXACT same functions as a human run
    // (applyLoadedFlow + poolLaunchCurrent): locked login/logout steps, the flow's saved
    // poolSettings and config (errHandle/retryCount/reauth/...) all come from the one
    // shared path. The old hand-built job/start payload here is what caused the 07-16/
    // 07-17 scheduled-run bugs (no login steps, hardcoded retry, ignored config).
    send('schedule-fire', {
      scheduleId: s.id,
      flowName: s.flowName,
      profileId: s.profileId,
      manual: !!manual,
    });
    // 3.2.1: arm the mandatory block-end backstop. Completion normally arrives first via the
    // in-process pool-complete hook; this guarantees we still reconcile + email if that signal
    // is missed, and re-arms with est-left-time if the run outlasts its reserved block.
    armBackstop(watch.blockMs);
    send('schedules-changed', {});
  }

  function tick() {
    const now = Date.now();
    // 3.2.1: completion detection is EVENT-DRIVEN (onPoolCompleteInternal, fired by the
    // coordinator in-process, + the block-end backstop armed in fire()) — NOT polled here.
    // A run that started AND finished between 30s ticks used to be missed by this poll and
    // given a false never-started error with no email. tick() now ONLY launches due schedules.
    for (const s of loadAll()) {
      if (s.enabled === false) continue;
      const after = Math.max(s.lastFiredAt || 0, s.createdAt || 0);
      const nf = nextFire(s, after);
      if (nf == null || now < nf) continue;
      const windowEnd = nf + Math.max(1, parseInt(s.blockMin, 10) || 15) * 60000;
      if (now >= windowEnd) {
        // due window fully passed while we were running something else / asleep
        s.lastFiredAt = nf;
        s.lastResult = { ts: now, status: 'missed', error: 'reserved window passed (pool busy or app asleep)' };
        saveOne(s); send('schedules-changed', {});
        continue;
      }
      if (COORD.active || watch) continue; // wait within the window; next tick retries
      fire(s, nf, false);
      break; // one launch per tick
    }
  }

  // Missed-while-closed detection: anything due before NOW at boot is offered, not fired.
  function missedAtBoot() {
    const now = Date.now();
    const out = [];
    for (const s of loadAll()) {
      if (s.enabled === false) continue;
      const after = Math.max(s.lastFiredAt || 0, s.createdAt || 0);
      const nf = nextFire(s, after);
      if (nf != null && nf <= now) out.push({ id: s.id, flowName: s.flowName, dueLocal: new Date(nf).toLocaleString(), dueTs: nf });
    }
    return out;
  }

  ipcMain.handle('schedules-list', async () => loadAll().map(summarize));
  ipcMain.handle('schedule-save', async (_, s) => {
    s = s || {};
    if (!s.id) s.id = 'sch' + Date.now();
    if (!s.createdAt) s.createdAt = Date.now();
    s.tz = s.tz || 'America/New_York';
    s.blockMin = Math.max(1, parseInt(s.blockMin, 10) || 15);
    if (!s.flowName) return { ok: false, error: 'Pick a flow.' };
    if (!s.profileId) return { ok: false, error: 'Pick a login profile.' };
    const fr = readFlowByName(s.flowName);
    if (!fr) return { ok: false, error: 'Flow "' + s.flowName + '" not found on disk.' };
    try { const fj = JSON.parse(fr.json); if (fj.runMode !== 'once') return { ok: false, error: 'Only spreadsheet-free (once) flows are schedulable. "' + s.flowName + '" is a per-row flow.' }; } catch (e) { return { ok: false, error: 'Flow unreadable.' }; }
    if (nextFire(s, Date.now()) == null && s.type === 'once') return { ok: false, error: 'That date/time is in the past.' };
    const clash = findOverlap(s, loadAll(), Date.now());
    if (clash) return { ok: false, error: 'Reserved blocks overlap: ' + clash };
    saveOne(s);
    return { ok: true, schedule: summarize(s) };
  });
  ipcMain.handle('schedule-delete', async (_, { id }) => { deleteOne(id); return { ok: true }; });
  ipcMain.handle('schedule-toggle', async (_, { id, enabled }) => {
    const s = loadAll().find(x => x.id === id);
    if (!s) return { ok: false };
    s.enabled = !!enabled; saveOne(s);
    return { ok: true, schedule: summarize(s) };
  });
  ipcMain.handle('schedule-run-now', async (_, { id }) => {
    const s = loadAll().find(x => x.id === id);
    if (!s) return { ok: false, error: 'not found' };
    if (COORD.active) return { ok: false, error: 'Pool is busy.' };
    fire(s, Date.now(), true);
    return { ok: true };
  });
  ipcMain.handle('schedule-skip-missed', async (_, { id }) => {
    const s = loadAll().find(x => x.id === id);
    if (!s) return { ok: false };
    s.lastFiredAt = Date.now(); s.lastResult = { ts: Date.now(), status: 'skipped', error: 'missed while BUU was closed; skipped by user' };
    saveOne(s);
    return { ok: true };
  });
  // The renderer reports the LAUNCH outcome of a fired schedule here (NOT the run result —
  // that comes from the pool-complete hook). ok = the pool started, so we just note it and
  // wait for completion. !ok = the launch failed/was skipped (bad flow, no profile, unsaved
  // edits): terminal, so record it and drop the watch (+ its backstop timer) immediately
  // rather than waiting out the whole reserved block for a run that will never happen.
  ipcMain.on('schedule-result', (_, d) => {
    if (!d || !watch || watch.id !== d.id) return;
    if (d.ok) { watch.launched = true; return; }
    if (watch.timer) { try { clearTimeout(watch.timer); } catch (e) {} watch.timer = null; }
    const s = loadAll().find(x => x.id === d.id);
    if (s) { s.lastResult = { ts: Date.now(), status: 'error', error: d.error || 'launch failed' }; saveOne(s); send('schedules-changed', {}); }
    watch = null;
  });

  // 3.2.1: the coordinator calls this in-process the instant a pool run finishes — the
  // authoritative, duration-independent completion signal that replaces the old 30s poll.
  COORD.onPoolComplete = onPoolCompleteInternal;

  setInterval(tick, 30000);
  // Offer missed schedules shortly after the window exists.
  setTimeout(() => { const miss = missedAtBoot(); if (miss.length) send('schedules-missed', miss); }, 6000);
}

module.exports.initScheduler = initScheduler;
