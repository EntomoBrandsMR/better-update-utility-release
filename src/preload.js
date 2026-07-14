const { contextBridge, ipcRenderer } = require('electron');


// R11: the v2.2.2 shim layer is GONE — the renderer consumes pool events directly.
// One start path (pool-submit-job + pool-start), one stop path (pool-stop), and a
// direct pool-row-error feed replace the synthesized automation-events.

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
  // v2.2.3 Session 3F (B2): working-data convention. Moves a finished spreadsheet from
  // upcoming/ into upcoming/Finished/ so the user stops hand-moving files mid-process.
  archiveSpreadsheet:  (d)     => ipcRenderer.invoke('archive-spreadsheet', d),
  saveFlow:            (d)     => ipcRenderer.invoke('save-flow', d),
  readFlowByName:      (d)     => ipcRenderer.invoke('read-flow-by-name', d), // R5b Tier 1

  setFlowDirty:        (v)     => ipcRenderer.send('flow-dirty-state', !!v), // R10
  confirmUnsaved:      ()      => ipcRenderer.invoke('confirm-unsaved'),     // R10
  flowCloseNow:        ()      => ipcRenderer.send('flow-close-now'),        // R10
  onSaveFlowThenClose: (cb)    => ipcRenderer.on('save-flow-then-close', () => cb()), // R10
  loadFlow:            ()      => ipcRenderer.invoke('load-flow'),
  listOnceFlows:       ()      => ipcRenderer.invoke('list-once-flows'),
  validateFlowRefs:    (d)     => ipcRenderer.invoke('validate-flow-references', d),
  openFlowsFolder:     ()      => ipcRenderer.invoke('open-flows-folder'),
  openLogsFolder:      ()      => ipcRenderer.invoke('open-log-folder'),
  openFile:            (p)     => ipcRenderer.invoke('open-file', p),
  openExternal:        (url)   => ipcRenderer.invoke('open-external', url),
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
  poolSetScaling:      (d)     => ipcRenderer.invoke('pool-set-scaling', d), // R4 live sliders
  poolStopWorker:      (d)     => ipcRenderer.invoke('pool-stop-worker', d),
  poolLogoutSweep:     ()      => ipcRenderer.invoke('pool-logout-sweep'),
  poolGetStatus:       ()      => ipcRenderer.invoke('pool-get-status'),
  poolFindOrphans:     ()      => ipcRenderer.invoke('pool-find-orphans'),
  poolResume:          (d)     => ipcRenderer.invoke('pool-resume', d),
  poolDiscardOrphan:   (d)     => ipcRenderer.invoke('pool-discard-orphan', d),
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
  onPoolRowError:      (cb)    => ipcRenderer.on('pool-row-error', (_, d) => cb(d)), // R11 direct error feed

  // R16: scheduler surface.
  schedulesList:       ()      => ipcRenderer.invoke('schedules-list'),
  scheduleSave:        (s)     => ipcRenderer.invoke('schedule-save', s),
  scheduleDelete:      (d)     => ipcRenderer.invoke('schedule-delete', d),
  scheduleToggle:      (d)     => ipcRenderer.invoke('schedule-toggle', d),
  scheduleRunNow:      (d)     => ipcRenderer.invoke('schedule-run-now', d),
  scheduleSkipMissed:  (d)     => ipcRenderer.invoke('schedule-skip-missed', d),
  scheduleResult:      (d)     => ipcRenderer.send('schedule-result', d),
  onScheduleFire:      (cb)    => ipcRenderer.on('schedule-fire', (_, d) => cb(d)),
  onSchedulesMissed:   (cb)    => ipcRenderer.on('schedules-missed', (_, d) => cb(d)),
  onSchedulesChanged:  (cb)    => ipcRenderer.on('schedules-changed', (_, d) => cb(d)),
  // v2.2.3 Session 3A (A3): per-worker dialog events. Captures every dialog (alert/confirm/
  // prompt/beforeunload) along with its text and the row it fired during. Renderer can show
  // a "recent dialogs" pane or attach to a worker card.
  onPoolDialog:        (cb)    => ipcRenderer.on('pool-dialog', (_, d) => cb(d)),
});
