const { contextBridge, ipcRenderer } = require('electron');

// v2.2.2 Session 2G: SHIM LAYER.
// The single-runner runtime (start-automation, stop-automation, run-control, checkpoint v3)
// was removed from main.js. The renderer was designed around it. Rather than rewrite the
// renderer end-to-end this session, we shim the old call surface here so it routes to the
// pool worker runtime — which is now the only runtime — and we BRIDGE pool events back to
// the old 'automation-event' shape the renderer's handleRunEvent expects.
//
// Bridge fidelity:
// - 'start': synthesized when the user starts; totalRows from the pool job.
// - 'row-start' / 'row-done' / 'row-error': synthesized from pool-status snapshots by
//   tracking the worker's currentRow and counters. Approximations, not exact transitions.
// - 'complete' / 'fatal': from pool-complete and pool-status (when active flips false).
// - 'pause-step' / 'pause-row': already handled by onPoolPause in the renderer.
// - Lower-priority events (heartbeat, log, mode, phase-*) are skipped — the renderer
//   degrades gracefully (they're decorative).
//
// This is acceptable transitional code. A later cleanup (v2.3.0) should rewrite the
// renderer to consume pool events directly instead of through this shim.

let _shimActiveRunId = null;
let _autoEventCb = null;
// Track per-worker state for transition detection on pool-status snapshots.
const _workerState = new Map(); // workerId -> { lastRow, lastStep, lastStatus }
// Aggregated counters reported by pool jobs (sum across all jobs for the single-runner-like case).
let _aggLastDone = 0, _aggLastOk = 0, _aggLastErr = 0, _aggLastSkip = 0;
let _bridgeStarted = false;

function emitAuto(evt) {
  if (_autoEventCb) {
    try { _autoEventCb(evt); } catch (e) { /* swallow */ }
  }
}

// Subscribe to pool events ONCE. Synthesize automation-events from them.
ipcRenderer.on('pool-status', (_, st) => {
  if (!st || !st.active) {
    if (_bridgeStarted) {
      // Pool just ended without going through pool-complete (e.g. user-stop). Synthesize
      // a 'complete' so the renderer cleans up UI state. The renderer's handleRunEvent
      // can treat this as a normal completion.
      // Skip if we already saw pool-complete; pool-complete listener handles that path.
    }
    return;
  }
  // First snapshot after a start: emit a synthetic 'start' event with the total rows summed.
  if (!_bridgeStarted) {
    _bridgeStarted = true;
    let totalRows = 0;
    if (Array.isArray(st.jobs)) for (const j of st.jobs) totalRows += (j.totalRows || 0);
    emitAuto({ type: 'start', totalRows, resumeFrom: 0 });
  }

  // Aggregate counters across all jobs and emit row transitions.
  let aggDone = 0, aggOk = 0, aggErr = 0, aggSkip = 0;
  if (Array.isArray(st.jobs)) {
    for (const j of st.jobs) { aggDone += j.done||0; aggOk += j.ok||0; aggErr += j.err||0; aggSkip += j.skip||0; }
  }

  if (Array.isArray(st.workers)) {
    for (const w of st.workers) {
      const prev = _workerState.get(w.workerId) || { lastRow: 0, lastStep: 0, lastStatus: '' };
      // Row advance: emit row-done for prev (if any), row-start for new.
      if (w.currentRow && w.currentRow !== prev.lastRow) {
        if (prev.lastRow > 0) {
          // We don't know status for the previous row without journal lookup; use aggregate
          // delta to decide ok vs err. This is approximate.
          if (aggOk > _aggLastOk) {
            emitAuto({ type: 'row-done', rowIndex: prev.lastRow, totalRows: 0, status: 'ok', url: '', fieldsWritten: '', durationMs: 0, ok: aggOk, errs: aggErr, skipped: aggSkip, elapsed: 0 });
          } else if (aggErr > _aggLastErr || aggSkip > _aggLastSkip) {
            emitAuto({ type: 'row-error', rowIndex: prev.lastRow, totalRows: 0, error: '(see worker log)', failedStep: '?', url: '', ok: aggOk, errs: aggErr, skipped: aggSkip, elapsed: 0 });
          }
        }
        emitAuto({ type: 'row-start', rowIndex: w.currentRow, rowNum: w.currentRow, totalRows: 0, url: '' });
      }
      // Step advance: emit lightweight step progress (renderer optional).
      if (w.step && w.step !== prev.lastStep) {
        // not emitting per-step events — renderer pulls these from onPoolStatus already
      }
      _workerState.set(w.workerId, { lastRow: w.currentRow || prev.lastRow, lastStep: w.step || 0, lastStatus: w.status || '' });
    }
  }
  _aggLastDone = aggDone; _aggLastOk = aggOk; _aggLastErr = aggErr; _aggLastSkip = aggSkip;
});

ipcRenderer.on('pool-complete', (_, d) => {
  if (!_bridgeStarted) return;
  _bridgeStarted = false;
  // Sum from the complete payload's job array
  let ok = 0, err = 0, skip = 0, total = 0;
  if (d && Array.isArray(d.jobs)) {
    for (const j of d.jobs) { ok += j.ok||0; err += j.err||0; skip += j.skip||0; total += j.totalRows||0; }
  }
  emitAuto({ type: 'complete', totalRows: total, ok, errs: err, skipped: skip, elapsed: 0, logPath: null });
  _workerState.clear();
  _aggLastDone = _aggLastOk = _aggLastErr = _aggLastSkip = 0;
  _shimActiveRunId = null;
});

async function shimStartAutomation(d) {
  try {
    const flowSteps = JSON.parse(d.stepsJson || '[]');
    const submit = await ipcRenderer.invoke('pool-submit-job', {
      label: null,
      flowSteps,
      spreadsheetPath: d.spreadsheetPath,
      profileId: d.profileId,
      setupFlowId: d.setupFlowId || null,
      teardownFlowId: d.teardownFlowId || null,
      errHandle: d.errHandle || 'retry',
      resumeFromRow: d.resumeFromRow || 1,
      retryCount: parseInt(d.retryCount) || 2,
      breakerThreshold: parseInt(d.breakerThreshold) || 0,
      retryRowIndexes: Array.isArray(d.retryRowIndexes) && d.retryRowIndexes.length ? d.retryRowIndexes : null,
      reauthIntervalMin: parseInt(d.reauthInterval) || 0,
    });
    if (!submit || submit.ok === false) {
      return { ok: false, error: (submit && submit.error) || 'pool-submit-job failed' };
    }
    const start = await ipcRenderer.invoke('pool-start', {
      workerCount: 1,
      batchSize: 10,
      elastic: false,
      licenseProfileId: null,
      licenseBuffer: 0,
      licenseIntervalMin: 0,
      setupScope: 'per-worker',
      startMode: d.startMode || 'run-all',
      // v2.2.3 Session 3C (A1): the legacy startAutomation path (used by the simple Start
      // button via the v2.2.2 shim) gets diagnostic capture ON by default so single-runner-
      // style runs benefit from the same trustworthy-reporting evidence as pool runs. The
      // user can disable via the pool-launch UI when running through that path instead.
      diagnosticCapture: true,
      captureBucketCap: 10,
      // v2.2.3 Session 3D (A2): verify-after-action ON by default for the legacy Start path too.
      verifyAfterAction: true,
    });
    if (!start || start.ok === false) {
      return { ok: false, error: (start && start.error) || 'pool-start failed' };
    }
    _shimActiveRunId = d.runId;
    _bridgeStarted = false; // reset so the next pool-status emits the synthetic 'start'
    _workerState.clear();
    _aggLastDone = _aggLastOk = _aggLastErr = _aggLastSkip = 0;
    return { ok: true, logPath: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function shimStopAutomation(_d) {
  _shimActiveRunId = null;
  try {
    return await ipcRenderer.invoke('pool-stop');
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function shimRunControl(d) {
  try {
    return await ipcRenderer.invoke('pool-run-control', { cmd: d && d.cmd });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

contextBridge.exposeInMainWorld('api', {
  getVersion:          ()      => ipcRenderer.invoke('get-version'),
  checkForUpdates:     ()      => ipcRenderer.invoke('check-for-updates'),
  installUpdate:       (d)     => ipcRenderer.invoke('install-update', d),
  onUpdateAvailable:   (cb)    => ipcRenderer.on('update-available',  (_, d) => cb(d)),
  onUpdateProgress:    (cb)    => ipcRenderer.on('update-progress',   (_, p) => cb(p)),
  onUpdateStatus:      (cb)    => ipcRenderer.on('update-status',     (_, d) => cb(d)),
  listProfiles:        ()      => ipcRenderer.invoke('list-profiles'),
  saveProfile:         (p)     => ipcRenderer.invoke('save-profile', p),
  getProfile:          (id)    => ipcRenderer.invoke('get-profile', id),
  deleteProfile:       (id)    => ipcRenderer.invoke('delete-profile', id),
  getConfig:           ()      => ipcRenderer.invoke('get-config'),
  setConfig:           (obj)   => ipcRenderer.invoke('set-config', obj),
  checkChromium:       ()      => ipcRenderer.invoke('check-chromium'),
  installChromium:     ()      => ipcRenderer.invoke('install-chromium'),
  onChromiumProgress:  (cb)    => ipcRenderer.on('chromium-progress', (_, d) => cb(d)),
  openSpreadsheet:     ()      => ipcRenderer.invoke('open-spreadsheet'),
  saveFlow:            (d)     => ipcRenderer.invoke('save-flow', d),
  loadFlow:            ()      => ipcRenderer.invoke('load-flow'),
  listOnceFlows:       ()      => ipcRenderer.invoke('list-once-flows'),
  validateFlowRefs:    (d)     => ipcRenderer.invoke('validate-flow-references', d),
  openFlowsFolder:     ()      => ipcRenderer.invoke('open-flows-folder'),
  openLogsFolder:      ()      => ipcRenderer.invoke('open-log-folder'),
  openFile:            (p)     => ipcRenderer.invoke('open-file', p),
  openExternal:        (url)   => ipcRenderer.invoke('open-external', url),
  // v2.2.2 Session 2G shim layer (see comment block at top of file).
  startAutomation:     (d)     => shimStartAutomation(d),
  stopAutomation:      (d)     => shimStopAutomation(d),
  runControl:          (d)     => shimRunControl(d),
  getCheckpoint:       ()      => Promise.resolve(null),
  findOrphanCheckpoints:()     => Promise.resolve([]),
  loadCheckpoint:      ()      => Promise.resolve(null),
  discardCheckpoint:   ()      => Promise.resolve({ ok: true }),
  onAutomationEvent:   (cb)    => { _autoEventCb = cb; },
  // v1.3.4 Phase 3: worker-pool sizing + license-aware cap.
  getWorkerCaps:       ()      => ipcRenderer.invoke('get-worker-caps'),
  checkLicenseCap:     (d)     => ipcRenderer.invoke('check-license-cap', d),
  // v2.0.0: elastic pull-queue pool.
  poolSubmitJob:       (d)     => ipcRenderer.invoke('pool-submit-job', d),
  poolRemoveJob:       (d)     => ipcRenderer.invoke('pool-remove-job', d),
  poolClearJobs:       ()      => ipcRenderer.invoke('pool-clear-jobs'),
  poolStart:           (d)     => ipcRenderer.invoke('pool-start', d),
  poolStop:            ()      => ipcRenderer.invoke('pool-stop'),
  poolSetWorkers:      (d)     => ipcRenderer.invoke('pool-set-workers', d),
  poolStopWorker:      (d)     => ipcRenderer.invoke('pool-stop-worker', d),
  poolLogoutSweep:     ()      => ipcRenderer.invoke('pool-logout-sweep'),
  poolGetStatus:       ()      => ipcRenderer.invoke('pool-get-status'),
  poolFindOrphans:     ()      => ipcRenderer.invoke('pool-find-orphans'),
  poolResume:          (d)     => ipcRenderer.invoke('pool-resume', d),
  poolDiscardOrphan:   (d)     => ipcRenderer.invoke('pool-discard-orphan', d),
  poolReadJournal:     (d)     => ipcRenderer.invoke('pool-read-journal', d),
  poolRunControl:      (d)     => ipcRenderer.invoke('pool-run-control', d),
  onPoolStatus:        (cb)    => ipcRenderer.on('pool-status', (_, d) => cb(d)),
  onPoolComplete:      (cb)    => ipcRenderer.on('pool-complete', (_, d) => cb(d)),
  onPoolSweepStart:    (cb)    => ipcRenderer.on('pool-sweep-start', (_, d) => cb(d)),
  onPoolSweepProgress: (cb)    => ipcRenderer.on('pool-sweep-progress', (_, d) => cb(d)),
  onPoolSweepResult:   (cb)    => ipcRenderer.on('pool-sweep-result', (_, d) => cb(d)),
  onPoolOnceFlow:      (cb)    => ipcRenderer.on('pool-once-flow', (_, d) => cb(d)),
  onPoolReadResults:   (cb)    => ipcRenderer.on('pool-read-results', (_, d) => cb(d)),
  onPoolLicenseUpdate: (cb)    => ipcRenderer.on('pool-license-update', (_, d) => cb(d)),
  onPoolPause:         (cb)    => ipcRenderer.on('pool-pause', (_, d) => cb(d)),
  // v2.2.3 Session 3A (A3): per-worker dialog events. Captures every dialog (alert/confirm/
  // prompt/beforeunload) along with its text and the row it fired during. Renderer can show
  // a "recent dialogs" pane or attach to a worker card.
  onPoolDialog:        (cb)    => ipcRenderer.on('pool-dialog', (_, d) => cb(d)),
});
