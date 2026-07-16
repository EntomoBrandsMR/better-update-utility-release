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
function initScheduler(deps) {
  // deps: { app, ipcMain, buuRoot, COORD, getWindow, readFlowByName }
  const { app, ipcMain, buuRoot, COORD, getWindow, readFlowByName } = deps;
  const dir = () => { const d = path.join(buuRoot(), 'schedules'); try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} return d; };
  let watch = null; // { id, firedAt, sawActive }

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
  function summarize(s) {
    const nf = s.enabled === false ? null : nextFire(s, Math.max(Date.now(), s.lastFiredAt || 0));
    return Object.assign({}, s, { nextFireTs: nf, nextFireLocal: nf ? new Date(nf).toLocaleString() : null });
  }

  function fire(s, dueTs, manual) {
    s.lastFiredAt = dueTs || Date.now(); // advance FIRST — a crash mid-fire must not double-fire
    saveOne(s);
    const fr = readFlowByName(s.flowName);
    if (!fr) { s.lastResult = { ts: Date.now(), status: 'error', error: 'flow "' + s.flowName + '" not found' }; saveOne(s); send('schedules-changed', {}); return; }
    let flow; try { flow = JSON.parse(fr.json); } catch (e) { s.lastResult = { ts: Date.now(), status: 'error', error: 'flow unreadable' }; saveOne(s); return; }
    watch = { id: s.id, firedAt: Date.now(), sawActive: false };
    send('schedule-fire', {
      scheduleId: s.id,
      job: {
        label: s.flowName + ' \u00b7 scheduled' + (manual ? ' (run now)' : ''),
        flowSteps: flow.steps || [],
        spreadsheetPath: null,
        profileId: s.profileId,
        setupFlowId: flow.setupFlowId || null,
        teardownFlowId: flow.teardownFlowId || null,
        errHandle: 'retry', resumeFromRow: 1, retryCount: 2, retryRowIndexes: null, reauthIntervalMin: 0,
      },
      start: {
        // v3.0.3: licenseProfileId was null here, so SCHEDULED runs skipped license
        // counting entirely — the one path left that contradicted "license counting is
        // unconditional" (it is a safety rail, never gated). Scheduled runs now count
        // seats against the same profile they log in with, honoring the default buffer.
        workerCount: 1, elastic: false, licenseProfileId: s.profileId || null, licenseBuffer: 10,
        licenseIntervalMin: 2, setupScope: 'per-worker', startMode: 'run-all',
        diagnosticCapture: false, captureBucketCap: 10, scaleMultiplier: 3,
      },
    });
    send('schedules-changed', {});
  }

  function tick() {
    const now = Date.now();
    // completion watch: record the result once the pool finishes (or never starts)
    if (watch) {
      if (COORD.active) watch.sawActive = true;
      else if (watch.sawActive) {
        const j = Array.from(COORD.jobs.values())[0];
        const s = loadAll().find(x => x.id === watch.id);
        if (s) { s.lastResult = { ts: now, status: j && j.err ? 'errors' : 'ok', ok: (j && j.ok) || 0, err: (j && j.err) || 0 }; saveOne(s); send('schedules-changed', {}); }
        watch = null;
      } else if (now - watch.firedAt > 120000) {
        const s = loadAll().find(x => x.id === watch.id);
        if (s) { s.lastResult = { ts: now, status: 'error', error: 'run never started (see live log)' }; saveOne(s); send('schedules-changed', {}); }
        watch = null;
      }
    }
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
  ipcMain.on('schedule-result', (_, d) => {
    if (!d) return;
    const s = loadAll().find(x => x.id === d.id);
    if (s) { s.lastResult = { ts: Date.now(), status: d.ok ? 'ok' : 'error', error: d.error || undefined }; saveOne(s); send('schedules-changed', {}); }
    if (!d.ok) watch = null;
  });

  setInterval(tick, 30000);
  // Offer missed schedules shortly after the window exists.
  setTimeout(() => { const miss = missedAtBoot(); if (miss.length) send('schedules-missed', miss); }, 6000);
}

module.exports.initScheduler = initScheduler;
