// _p4-r11a-shimdeath.js — Phase 4 R11a: the v2.2.2 shim layer dies.
// The renderer consumes pool events directly: stats were ALREADY driven by pool-status
// (renderCoordStatus); the shim's only irreplaceable job was per-row error lines, which
// become a direct coordinator->renderer 'pool-row-error' feed (errors only — the D3
// lesson forbids per-row floods). Deleted: preload shim (~160 lines + 4 exports),
// handleRunEvent dispatcher, updateRunStats, legacy startRun body, retryFailedRows,
// single-runner stop paths. Start/Stop now have exactly ONE path each (pool).
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function repRx(s, rx, to, label) {
  if (!rx.test(s)) throw new Error('anchor missing: ' + label);
  return s.replace(rx, to);
}

// ── preload.js ──
const pp = path.join(root, 'src', 'preload.js');
let p = fs.readFileSync(pp, 'utf8');
if (p.includes('SHIM LAYER')) {
  const before = p.split('\n').length;
  p = repRx(p, /\r?\n\/\/ v2\.2\.2 Session 2G: SHIM LAYER\.[\s\S]*?\r?\ncontextBridge\.exposeInMainWorld\('api', \{/,
    "\n\n// R11: the v2.2.2 shim layer is GONE — the renderer consumes pool events directly.\n// One start path (pool-submit-job + pool-start), one stop path (pool-stop), and a\n// direct pool-row-error feed replace the synthesized automation-events.\n\ncontextBridge.exposeInMainWorld('api', {", 'shim cut');
  p = repRx(p, /  \/\/ v2\.2\.2 Session 2G shim layer \(see comment block at top of file\)\.\r?\n  startAutomation:[^\n]*\r?\n  stopAutomation:[^\n]*\r?\n  runControl:[^\n]*\r?\n  onAutomationEvent:[^\n]*\r?\n/, '', 'shim exports');
  p = repRx(p, /(  onPoolPause:[^\n]*\r?\n)/,
    "$1  onPoolRowError:      (cb)    => ipcRenderer.on('pool-row-error', (_, d) => cb(d)), // R11 direct error feed\n", 'row-error sub');
  fs.writeFileSync(pp, p, 'utf8');
  console.log('preload done (lines ' + before + ' -> ' + p.split('\n').length + ')');
} else console.log('preload already done');

// ── coordinator.js ──
const cp = path.join(root, 'src', 'pool', 'coordinator.js');
let c = fs.readFileSync(cp, 'utf8');
if (!c.includes('pool-row-error')) {
  c = repRx(c, /(        error: msg\.error, durationMs: msg\.durationMs,\r?\n      \}\);)/, [
    '$1',
    '      // R11: direct error feed to the renderer (errors only — the D3 lesson says no',
    '      // per-row event floods; OK rows are visible through the counters).',
    "      if(String(msg.status||'').indexOf('ok') !== 0 && ctx.mainWindow){",
    "        try { ctx.mainWindow.webContents.send('pool-row-error', { workerId: w.workerId, jobId: w.jobId, row: msg.row, error: msg.error || '', reason: msg.errorCategory || undefined }); } catch (e) {}",
    '      }'
  ].join('\n'), 'error feed');
  fs.writeFileSync(cp, c, 'utf8');
  console.log('coordinator done');
} else console.log('coordinator already done');

// ── index.html: dispatcher + legacy runner paths die ──
const hp = path.join(root, 'src', 'index.html');
let h = fs.readFileSync(hp, 'utf8');
if (h.includes('function handleRunEvent')) {
  const before = h.split('\n').length;
  h = repRx(h, /^\s*if \(API\.onAutomationEvent\) API\.onAutomationEvent\(handleRunEvent\);\r?\n/m, '', 'subscription');
  h = repRx(h, /async function startRun\(\)\{[\s\S]*?\r?\n(async function retryFailedRows\(\)\{)/, [
    '// R11: the single-runner start path is gone with the shim. ONE run path: stage the',
    '// current flow as a pool job and run it (fresh-read, validation, confirm — all in',
    '// poolRunClick/poolStageCurrent).',
    'async function startRun(){ return poolRunClick(); }',
    '',
    '$1'
  ].join('\n'), 'startRun stub');
  h = repRx(h, /async function retryFailedRows\(\)\{[\s\S]*?\r?\n(async function requestStop\(\)\{)/,
    '// R11: retryFailedRows died with the single-runner. Rerun-file + journal reconciliation\n// is the real retry workflow; the R12 error strip surfaces failures live.\n$1', 'retry cut');
  h = repRx(h, /async function requestStop\(\)\{[\s\S]*?\r?\n(async function stopRun\(\)\{)/, [
    '// R11: the single-runner stop path is gone. Stop = pool stop (step-boundary abandon +',
    '// 10s fuse + prompt logout sweep — all Phase 3 behavior).',
    'async function requestStop(){ return stopWorkerPool(); }',
    '',
    '$1'
  ].join('\n'), 'requestStop stub');
  h = repRx(h, /async function forceStopNow\(\)\{[\s\S]*?\r?\n(function runStopped\(\)\{)/, [
    "// R11: force-stop = pool stop; Phase 3's 10s fuse already makes it near-immediate.",
    'async function forceStopNow(){ return stopWorkerPool(); }',
    '',
    '$1'
  ].join('\n'), 'forceStop stub');
  h = repRx(h, /function handleRunEvent\(evt\)\{[\s\S]*?\r?\n(function showPause\(kind, evt\)\{)/, [
    '// R11: handleRunEvent (the automation-event dispatcher) is GONE with the shim.',
    '// Its jobs now live where the data actually is: stats + status line come from',
    '// renderCoordStatus (pool-status), completion from onPoolComplete, pauses from',
    '// onPoolPause, per-row errors from onPoolRowError, phase display from pool-status.',
    '$1'
  ].join('\n'), 'dispatcher cut');
  h = repRx(h, /function updateRunStats\(done,ok,err,skip\)\{[^\n]*\r?\n/, '', 'updateRunStats cut');
  h = repRx(h, /^.*id="retryFailedBtn".*\r?\n/m, '', 'retry button');
  h = repRx(h, /^let _failedRowIndexesThisRun = \[\];\r?\n/m, '', 'tracker decl');
  h = repRx(h, /^(if\(API\.onPoolComplete\) API\.onPoolComplete\(function\(d\)\{)/m, [
    '// R11: direct per-row ERROR feed (ok rows stay counter-only — the D3 flood lesson).',
    'if(API.onPoolRowError) API.onPoolRowError(function(d){',
    "  addLiveLog('\\u2717 Row '+d.row+' FAILED'+(d.reason?' ['+d.reason+']':'')+': '+(d.error||''),'err');",
    '});',
    '$1'
  ].join('\n'), 'error subscriber');
  fs.writeFileSync(hp, h, 'utf8');
  console.log('index done (lines ' + before + ' -> ' + h.split('\n').length + ')');
} else console.log('index already done');
