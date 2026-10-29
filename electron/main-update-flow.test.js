'use strict';

/*
 * Integration test for the update flow wired in main.js — the REAL main.js, loaded with stubs for Electron,
 * electron-updater, electron-log and UvManager (so nothing is installed, downloaded or shown). main.js has no exports,
 * so a few internals are exposed by APPENDING to its source at load time; production code is untouched.
 *
 * Covers: desktop + engine offered together (Update now / Later), the saved engine version, the 90 minute reminder,
 * engine dialogs held back while a desktop update is pending OR its status is unknown, desktop-first for first-time
 * setup and repair, the UI's upgrade IPC, desktop-only, and the next launch of the new desktop.
 * Run: `node electron/main-update-flow.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const MAIN = path.join(__dirname, 'main.js');
const EXPOSE = `
module.exports.__t = {
  offerDesktopUpdate, offerPostponedRestartPrompt, backendWaitAborted, showDesktopReadyPrompt, installAndStartBackend, showStartupErrorPanel, reportStartupCrash, checkPackageUpdateInBackground, waitForBackend,
  setupElectronAutoUpdater, readyReminder, pendingEngineStore, restartApplier, getDesktopUpdateVersion, engineChangeAllowed,
  runScheduledUpdateCheck, startLaunchDesktopCheck, startOffer,
  primeLaunchCheck: () => { launchDesktopCheck = startLaunchDesktopCheck(); },
  fireAccountWatch: (f) => accountWatchEvent && accountWatchEvent(f),
  disarmAccountWatch: () => { accountWatcher = { close() {} }; },
  getDesktopStatus: () => desktopStatus,
  getState: () => ({ pendingDesktopVersion, offeredDesktopVersion, desktopDownloadedVersion, deferredDesktopVersion,
                     desktopRestartPromptOpen, packageUpdateInFlight }),
  setMainWindow: (w) => { mainWindow = w; },
  setBackendReady: (v) => { backendReady = v; },
  setQuitting: (v) => { isQuitting = v; },
  setUvManager: (u) => { uvManager = u; },
  getUvManager: () => uvManager,
};`;

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const tick = () => new Promise((r) => setImmediate(r));

// A hung await drains the event loop and node exits 0 BEFORE the suite finishes — a silent false
// green (the summary line never prints). Normal completion exits via process.exit(0), which skips
// beforeExit; reaching here means the suite stalled.
process.on('beforeExit', () => {
  console.error(`main-update-flow.test.js: the event loop drained after ${passed} assertions — a hung await ended the suite early`);
  process.exit(1);
});

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mainflow-'));
// main.js derives ~/.flow (logs, instance dir) from os.homedir() at load: $HOME on POSIX,
// %USERPROFILE% on Windows. Set both so the planted config.json is the one main.js reads.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const INSTANCE_DIR = path.join(HOME, '.flow', 'instances', 'prod');
/** The hub-written login state the schedule follows; HOME is shared across loads, so every load() resets it.
 *  Written the way the backend writes it — an atomic RENAME (os.replace) — which is also what the
 *  directory watch in main.js sees; a plain in-place overwrite is invisible to it on macOS. */
function writeAccountEmail(email) {
  fs.mkdirSync(INSTANCE_DIR, { recursive: true });
  if (email) {
    const tmp = path.join(INSTANCE_DIR, 'config.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ user: { email } }));
    fs.renameSync(tmp, path.join(INSTANCE_DIR, 'config.json'));
  } else {
    fs.rmSync(path.join(INSTANCE_DIR, 'config.json'), { force: true });
  }
}

/** Load a fresh copy of main.js. `opts`: appVersion, dialogResponses (consumed in order), engineStatus, desktopFeed,
 *  engine, userDataDir (reuse across loads → "restart" tests), accountEmail (the logged-in user). */
function load(opts = {}) {
  const userData = opts.userDataDir || fs.mkdtempSync(path.join(HOME, 'userdata-'));
  writeAccountEmail(opts.accountEmail || null);
  const intervals = [];
  global.setInterval = (fn, ms) => { const h = { fn, ms, unref() {} }; intervals.push(h); return h; };

  const ipc = {};
  const once = {};
  const dialogCalls = [];
  const responses = [...(opts.dialogResponses || [])];
  let releaseDialog = () => {};
  const gate = opts.holdDialog ? new Promise((r) => { releaseDialog = r; }) : null;
  const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 'stub' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk(), set: () => true });
  const BW = function () {}; BW.getAllWindows = () => []; BW.getFocusedWindow = () => null;
  const autoUpdater = Object.assign(new EventEmitter(), {
    downloads: [], quits: [], checks: 0,
    checkForUpdates: async () => {
      autoUpdater.checks++;
      if (opts.desktopCheckThrows) throw new Error(opts.desktopCheckThrows);
      return { updateInfo: { version: opts.desktopFeed || opts.appVersion || '0.2.47' } };
    },
    downloadUpdate() { autoUpdater.downloads.push(1); return new Promise((r, j) => { autoUpdater.finishDownload = r; autoUpdater.failDownload = j; }); },
    quitAndInstall: (...a) => { autoUpdater.quits.push(a); },
  });
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, setAsDefaultProtocolClient() {}, getPath: () => userData, whenReady: () => new Promise(() => {}),
      on() {}, isPackaged: true, getVersion: () => opts.appVersion || '0.2.47', quit() {}, exit() {}, commandLine: { appendSwitch() {} }, setName() {}, setAppUserModelId() {},
    },
    BrowserWindow: BW,
    dialog: { showMessageBox: async (...a) => {
      const o = a[a.length - 1]; dialogCalls.push(o);
      // Like Electron: an aborted signal closes the dialog and resolves with the cancel answer.
      if (gate) {
        if (o && o.signal) await Promise.race([gate, new Promise((r) => o.signal.addEventListener('abort', r, { once: true }))]);
        else await gate;
      }
      if (o && o.signal && o.signal.aborted) return { response: o.cancelId !== undefined ? o.cancelId : 1 };
      return { response: responses.length ? responses.shift() : 1 };
    }, showErrorBox() {} },
    ipcMain: { on() {}, handle(ch, fn) { ipc[ch] = fn; }, once(ch, fn) { once[ch] = fn; } },
    shell: mk(), clipboard: mk(), Menu: mk(), nativeImage: mk(), session: mk(), screen: mk(), Tray: mk(), globalShortcut: mk(), powerMonitor: mk(), protocol: mk(), net: mk(), desktopCapturer: mk(), systemPreferences: mk(), Notification: mk(),
  };
  const logLines = [];
  const log = { info: (l) => logLines.push(String(l)), warn: (l) => logLines.push(String(l)), error: (l) => logLines.push(String(l)), transports: { file: {}, console: {} }, hooks: [] };

  const uv = { calls: [], deferred: [], undeferred: [], upgrades: [], checks: 0 };
  class FakeUv {
    constructor() { Object.assign(this, { _isInstalling: false }); uv.instance = this; }
    getInstalledFlowBin() { return opts.installed === false ? null : '/fake/bin/flow'; }
    hadInterruptedInstall() { return false; }
    getInstalledVersionSync() { return opts.engine || '0.2.168'; }
    installedPairIssue() { return opts.pairIssue || null; }
    async resolveCompatibleEngineVersion() { if (opts.resolveThrows) throw new Error(opts.resolveThrows); return opts.compatibleRelease || null; }
    async _readCandidateMinDesktop() { return { minDesktopVersion: opts.candidateFloor || null }; }
    async _flowStop() { uv.flowStops = (uv.flowStops || 0) + 1; }
    async _killPort() {}
    async recoverAfterFailedUpgrade() {
      uv.recovered = (uv.recovered || 0) + 1;
      const fails = opts.recoveryFails === true ? Infinity : (opts.recoveryFails || 0);
      return uv.recovered > fails;
    }
    async _pypiUpdateStatus() { return opts.engineStatus === undefined ? { currentVersion: '0.2.168', latestVersion: '0.2.180', required: true } : opts.engineStatus; }
    async engineUpdatePreflight() {
      return opts.preflight === undefined
        ? { installed: '0.2.168', latest: '0.2.180', updateAvailable: true, latestMinDesktop: null, latestCompatible: true, newestCompatible: null }
        : opts.preflight;
    }
    deferPackageVersion(v) { uv.deferred.push(v); }
    undeferPackageVersion(v) { uv.undeferred.push(v); }
    async upgrade(o) { uv.upgrades.push(o); if (opts.upgradeThrows) throw new Error(opts.upgradeThrows); }
    async checkForUpdatesInBackground() { uv.checks++; return false; }
    async startWithBin() { if (opts.startThrows) throw new Error(opts.startThrows); }
    isBrokenInstallError(err) { return /flow_sdk/.test(String(err && err.message)); }
    async ensureUv() { uv.ensured = (uv.ensured || 0) + 1; }
    async probeManagedInterpreter() {}
    async installLatest() { uv.installs = (uv.installs || 0) + 1; }
    async reinstall() { uv.reinstalls = (uv.reinstalls || 0) + 1; }
    async start() { uv.started = (uv.started || 0) + 1; }
    async stop() { uv.stopped = (uv.stopped || 0) + 1; }
    isInstalling() { return this._isInstalling; }
    setFailureSharer(fn) { this.sharer = fn; }
    openPackageDialogVersion() { return null; }
    async getLatestPypiVersion() { return null; }
    getInstalledFlowBinSync() { return '/fake/bin/flow'; }
    lastLaunch() { return null; }
    hasLaunchedBackend() { return false; }
  }

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return electron;
    if (request === 'electron-updater') return { autoUpdater, CancellationToken: function () { this.cancel = () => {}; } };
    if (request === 'electron-log/main' || request === 'electron-log') return log;
    if (request === 'electron-store') return mk();
    if (request === './uv-manager') { FakeUv.getPythonVersion = () => '3.11'; FakeUv.upgradeCommand = () => 'uv tool install flowpad@latest'; FakeUv.PYPI_PACKAGE = 'flowpad'; return FakeUv; }
    return origLoad.apply(this, arguments);
  };
  let t;
  const processHandlers = {};
  const realProcessOn = process.on;
  // main.js registers top-level crash handlers; capture them instead of installing them in the test process
  // (they would swallow the test's own failures).
  process.on = function (ev, fn) { if (ev === 'uncaughtException' || ev === 'unhandledRejection') { processHandlers[ev] = fn; return process; } return realProcessOn.call(process, ev, fn); };
  try {
    const m = new Module(MAIN, null);
    m.filename = MAIN; m.paths = Module._nodeModulePaths(path.dirname(MAIN));
    m._compile(fs.readFileSync(MAIN, 'utf8') + EXPOSE, MAIN);
    t = m.exports.__t;
  } finally { Module._load = origLoad; process.on = realProcessOn; } // global.setInterval stays captured: setupElectronAutoUpdater() arms its tick later

  const win = { isDestroyed: () => false, isMinimized: () => false, webContents: { send(ch, d) { win.sent.push([ch, d]); } }, sent: [], loadedFiles: [], loadFile: async (p) => { win.loadedFiles.push(p); }, loadURL() {}, show() {}, hide() {}, focus() {} };
  t.setMainWindow(win);
  t.setUvManager(new FakeUv());
  t.setBackendReady(opts.backendReady !== false); // the app is up unless a test says it is still starting
  return { t, ipc, once, processHandlers, sent: win.sent, loadedFiles: win.loadedFiles, releaseDialog: () => releaseDialog(), autoUpdater, dialogCalls, intervals, uv, logLines, userData, statePath: path.join(userData, 'pending-engine.json'), readState: () => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'pending-engine.json'), 'utf8')); } catch { return null; } }, schedulePath: path.join(userData, 'update-schedule.json'), readSchedule: () => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'update-schedule.json'), 'utf8')); } catch { return null; } }, writeSchedule: (s) => fs.writeFileSync(path.join(userData, 'update-schedule.json'), JSON.stringify(s)) };
}

const REMINDER_MS = 90 * 60 * 1000;
const reminderTimer = (env) => env.intervals.find((i) => i.ms === REMINDER_MS);
const schedule = require('./update-schedule');
const schedulerTick = (env) => env.intervals.find((i) => i.ms === schedule.SCHEDULER_TICK_MS);
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

(async () => {
  // ── desktop + engine, "Update now" ───────────────────────────────────────
  {
    const env = load({ dialogResponses: [0 /* Update now */, 0 /* Restart now */] });
    env.t.setupElectronAutoUpdater();
    eq(await env.t.offerDesktopUpdate('0.2.48'), 'both', 'desktop + engine → the combined screen');
    eq(env.dialogCalls.length, 1, 'one dialog');
    eq(env.dialogCalls[0].buttons, ['Update now', 'Later'], 'Update now / Later');
    ok(/0\.2\.47 → 0\.2\.48/.test(env.dialogCalls[0].detail) && /0\.2\.168 → 0\.2\.180/.test(env.dialogCalls[0].detail), 'it lists both version changes');
    ok(/engine is updated right after FlowPad restarts/.test(env.dialogCalls[0].detail), 'and says when the engine is updated');
    eq(env.readState(), Object.assign({}, env.readState(), { engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: false }), 'the engine version on offer is SAVED, not yet agreed');
    eq(env.uv.upgrades.length, 0, 'the OLD desktop does NOT touch the engine');
    eq(env.uv.deferred, ['0.2.180'], 'no separate engine dialog for that version');
    eq(env.autoUpdater.downloads.length, 1, 'the desktop download started');
    eq(reminderTimer(env), undefined, '"Update now": no reminder timer');
    // The download finishes → the ready prompt right away.
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    eq(env.dialogCalls.length, 2, 'the "update ready" prompt appears as soon as the download is done');
    eq(env.dialogCalls[1].buttons, ['Restart now', 'Later'], 'Restart now / Later');
    ok(/engine will be updated to 0\.2\.180 right after the restart/.test(env.dialogCalls[1].detail), 'and it mentions the engine version that will follow');
    await tick(); await tick();
    eq(env.readState().consented, true, '"Restart now" = agreement to install the saved engine version');
    eq(env.autoUpdater.quits, [[true, true]], 'quitAndInstall(silent, relaunch)');
    eq(env.uv.stopped, 1, 'the backend was stopped first');
  }

  // ── download finishes while FlowPad is still starting: no restart prompt until the app is up ──
  {
    const env = load({ backendReady: false, dialogResponses: [0 /* Update now */, 0 /* Restart now */] });
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    eq(env.dialogCalls.length, 1, 'still starting: the "Restart now" prompt is held back');
    eq(env.autoUpdater.quits, [], 'and nothing restarts');
    env.t.setBackendReady(true); env.t.offerPostponedRestartPrompt(); await tick(); await tick(); await tick();
    eq(env.dialogCalls.length, 2, 'once the app is up the prompt appears');
    eq(env.autoUpdater.quits, [[true, true]], 'and "Restart now" installs');
  }

  // ── a restart-to-update stops the backend mid-wait: that is not a startup failure (no error screen) ──
  {
    const env = load();
    eq(env.t.backendWaitAborted({ ready: false, reason: 'launcher-failed' }), false, 'a real launcher failure still reaches the error panel');
    env.t.setQuitting(true);
    eq(env.t.backendWaitAborted({ ready: false, reason: 'launcher-failed' }), true, 'while quitting for an update, launcher-failed is swallowed');
    eq(env.t.backendWaitAborted({ ready: false, reason: 'quitting' }), true, 'and so is the explicit quitting reason');
  }

  // ── desktop + engine, "Later" → reminders every 90 minutes ───────────────
  {
    const env = load({ dialogResponses: [1 /* Later */, 1 /* Later at the ready prompt */, 0 /* Restart now */] });
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48');
    eq(env.autoUpdater.downloads.length, 1, '"Later": the desktop still downloads in the background');
    ok(reminderTimer(env), '"Later" starts the 90-minute reminder');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    eq(env.dialogCalls.length, 1, 'download finished: NO prompt (the user said Later)');
    reminderTimer(env).fn(); await tick(); await tick();
    eq(env.dialogCalls.length, 2, 'after 90 minutes the ready prompt opens');
    eq(env.dialogCalls[1].buttons, ['Restart now', 'Later'], 'the same prompt as in the "Update now" path');
    eq(env.readState().consented, false, 'Later at the prompt: nothing agreed yet');
    eq(env.autoUpdater.quits.length, 0, 'and nothing restarts');
    reminderTimer(env).fn(); await tick(); await tick(); await tick();
    eq(env.dialogCalls.length, 3, 'another 90 minutes: asked again');
    eq(env.readState().consented, true, 'this time Restart now → agreed');
    eq(env.autoUpdater.quits.length, 1, 'and it restarts to install');
  }

  // ── "Later", and the reminder comes due while the download is unfinished ─
  {
    const env = load({ dialogResponses: [1, 0] });
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48');
    reminderTimer(env).fn(); await tick();
    eq(env.dialogCalls.length, 1, 'reminder fires, download not finished: nothing shown yet');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq(env.dialogCalls.length, 2, 'shown the moment the download finishes');
  }

  // ── engine dialogs are held back while a desktop update is pending ───────
  {
    const env = load({ dialogResponses: [1] });
    await env.t.offerDesktopUpdate('0.2.48');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'no separate engine dialog while the desktop update is pending');
    ok(env.logLines.some((l) => /engine change hold \(periodic package check\): desktop 0\.2\.48 is pending/.test(l)), 'and it says why');
  }

  // ── DESKTOP FIRST: the engine is changed only when the desktop status is known and current ──
  {
    // Running the latest desktop: the periodic engine check runs.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47' });
    await env.t.getDesktopUpdateVersion();
    eq(env.t.getDesktopStatus().state, 'current', 'status: current');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 1, 'desktop current → the engine check runs');
  }
  {
    // A newer desktop exists although NOTHING was offered this session (e.g. found by the check alone): hold.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    await env.t.getDesktopUpdateVersion();
    eq(env.t.getDesktopStatus().state, 'available', 'status: available');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'a newer desktop exists → no engine check, even with no pending offer');
  }
  {
    // The desktop check FAILED: "could not tell" is not "up to date".
    const env = load({ desktopCheckThrows: 'HTTP 500' });
    await env.t.getDesktopUpdateVersion();
    eq(env.t.getDesktopStatus().state, 'unknown', 'status: unknown after a failed check');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'unknown desktop status → the engine is held');
    ok(env.logLines.some((l) => /engine change hold .*status is unknown \(update check failed: HTTP 500\)/.test(l)), 'and the log names the cause');
  }
  {
    // Before any check has answered the status is unknown too (a check that timed out leaves it so).
    const env = load();
    eq(env.t.getDesktopStatus().state, 'unknown', 'initial status: unknown');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'an unanswered check holds the engine');
  }
  {
    // "Restart now" failed: the new desktop is downloaded but NOT installed and running, so the engine stays held —
    // the periodic check, the pre-start prompt's gate and the UI's upgrade IPC all keep refusing.
    const env = load({ engineStatus: null, dialogResponses: [0] });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    await env.t.offerDesktopUpdate('0.2.48');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'held while the desktop is pending');
    await env.t.restartApplier.apply();
    env.t.restartApplier.failed(new Error('could not restart'));
    eq(env.t.engineChangeAllowed('test'), 'hold', 'still held after "Restart now" failed: the new desktop is not running');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'after a failed restart: no engine check');
    const r = await env.ipc['upgrade-flowpad']();
    ok(r.success === false && r.desktopUpdatePending === true, 'after a failed restart: the UI upgrade is refused');
    eq(env.uv.upgrades.length, 0, 'after a failed restart: the engine was not touched');
    // The pre-start engine prompt (a start in the same session, e.g. macOS `activate`) is held too.
    await env.t.installAndStartBackend();
    eq(env.uv.checks, 0, 'after a failed restart: the pre-start engine prompt does not run');
    eq(env.uv.upgrades.length, 0, 'after a failed restart: the pre-start path did not touch the engine');
  }
  {
    // The desktop update is FULLY DOWNLOADED (update-downloaded emitted) and the user said Later at the ready prompt:
    // it installs on the next quit, but until the new desktop is installed and running the engine stays held.
    const env = load({ engineStatus: null, dialogResponses: [1 /* Later at the ready prompt */] });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    await env.t.offerDesktopUpdate('0.2.48');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq(env.t.getState().desktopDownloadedVersion, '0.2.48', 'the update is fully downloaded');
    eq(env.dialogCalls.length, 1, 'the ready prompt was shown and answered Later');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'downloaded + Later: the engine stays held');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'downloaded + Later: no engine check');
    const r = await env.ipc['upgrade-flowpad']();
    ok(r.success === false && r.desktopUpdatePending === true, 'downloaded + Later: the UI upgrade is refused');
  }
  {
    // Same on the combined screen: "Later" there downloads in the background without a prompt; once the download is
    // complete the engine is still held (it is installed by the new desktop after the restart, nothing earlier).
    const env = load({ dialogResponses: [1 /* Later on "Updates available" */] });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    eq(await env.t.offerDesktopUpdate('0.2.48'), 'both', 'desktop + engine → the combined screen');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq(env.t.getState().desktopDownloadedVersion, '0.2.48', 'combined screen: the update is fully downloaded');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'combined screen, downloaded + Later: the engine stays held');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'combined screen, downloaded + Later: no engine check');
    eq(env.uv.upgrades.length, 0, 'combined screen, downloaded + Later: the engine was not touched');
  }
  {
    // The UI's upgrade IPC is refused while a newer desktop exists, before the server or the window is touched.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    await env.t.getDesktopUpdateVersion();
    const r = await env.ipc['upgrade-flowpad']();
    eq(r.success, false, 'upgrade-flowpad: refused');
    eq(r.desktopUpdatePending, true, 'upgrade-flowpad: says a desktop update is pending');
    eq(env.uv.upgrades.length, 0, 'upgrade-flowpad: the engine was not touched');
    eq(env.sent.length, 0, 'upgrade-flowpad: the window was not touched');
  }

  // ── DESKTOP FIRST for the installs that cannot be skipped ───────────────
  {
    // First-time setup with a newer desktop: update the desktop, install the engine AFTER the relaunch.
    const env = load({ installed: false, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    const p = env.t.installAndStartBackend();
    await tick(); await tick();
    eq(env.autoUpdater.downloads.length, 1, 'first run: the desktop download started');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    env.autoUpdater.finishDownload(); 
    const r = await p;
    eq(r.ok, false, 'first run: this launch ends — the app is restarting into the update');
    eq(env.uv.installs || 0, 0, 'first run: the engine was NOT installed under the old desktop');
    eq(env.autoUpdater.quits, [[true, true]], 'first run: silent install + relaunch');
    eq(env.dialogCalls.length, 0, 'first run: no "Restart now?" dialog — nothing to lose yet');
  }
  {
    // First-time setup, desktop already current: install as before.
    const env = load({ installed: false, appVersion: '0.2.47', desktopFeed: '0.2.47' });
    await env.t.getDesktopUpdateVersion();
    const r = await env.t.installAndStartBackend();
    eq(r.ok, true, 'first run, desktop current: startup succeeds');
    eq(env.uv.installs, 1, 'first run, desktop current: the engine is installed');
    eq(env.autoUpdater.downloads.length, 0, 'first run, desktop current: no desktop download');
  }
  {
    // First-time setup and the desktop check failed: install anyway — a missing engine is worse than a version gap.
    const env = load({ installed: false, desktopCheckThrows: 'offline' });
    await env.t.getDesktopUpdateVersion();
    const r = await env.t.installAndStartBackend();
    eq(r.ok, true, 'first run, unknown desktop: startup succeeds');
    eq(env.uv.installs, 1, 'first run, unknown desktop: the engine is installed anyway');
  }
  {
    // First-time setup, the desktop update does not download: install the engine with this desktop.
    const env = load({ installed: false, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    const p = env.t.installAndStartBackend();
    await tick(); await tick();
    env.autoUpdater.finishDownload(); // finishes WITHOUT an update-downloaded event: the download failed
    const r = await p;
    eq(r.ok, true, 'failed desktop download: startup continues');
    eq(env.uv.installs, 1, 'failed desktop download: the engine is installed with this desktop');
    eq(env.autoUpdater.quits.length, 0, 'failed desktop download: no restart');
  }
  {
    // Repair of a broken install, newer desktop waiting: the same — desktop first, repair after the relaunch.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', startThrows: 'ModuleNotFoundError: No module named flow_sdk' });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    const p = env.t.installAndStartBackend();
    await tick(); await tick(); await tick();
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    env.autoUpdater.finishDownload();
    const r = await p;
    eq(r.ok, false, 'repair: this launch ends — the app is restarting into the update');
    eq(env.uv.reinstalls || 0, 0, 'repair: the engine was NOT reinstalled under the old desktop');
    eq(env.autoUpdater.quits, [[true, true]], 'repair: silent install + relaunch');
  }
  {
    // Repair, desktop current: repair as before.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', startThrows: 'ModuleNotFoundError: No module named flow_sdk' });
    await env.t.getDesktopUpdateVersion();
    await env.t.installAndStartBackend().catch(() => {});
    eq(env.uv.reinstalls, 1, 'repair, desktop current: the engine is reinstalled');
  }

  // ── nothing installed: no "update" ──────────────────────────────────────
  {
    const env = load({ installed: false });
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'flowpad is not installed (first-time setup failed): the periodic check offers no update');
    ok(env.logLines.some((l) => /package check skipped: flowpad is not installed/.test(l)), 'and it says why');
    const installed = load({});
    await installed.t.getDesktopUpdateVersion(); // the desktop check answered: nothing newer
    await installed.t.checkPackageUpdateInBackground();
    eq(installed.uv.checks, 1, 'an installed flowpad is still checked');
  }

  // ── desktop only ────────────────────────────────────────────────────────
  {
    const env = load({ engineStatus: null });
    env.t.setupElectronAutoUpdater();
    eq(await env.t.offerDesktopUpdate('0.2.48'), 'desktop', 'no engine update → desktop only');
    eq(env.dialogCalls.length, 0, 'no combined screen (as today)');
    eq(env.autoUpdater.downloads.length, 1, 'the download starts, the restart prompt follows when it is ready');
    eq(env.readState(), null, 'nothing saved for the engine');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    eq(env.dialogCalls.length, 1, 'the ready prompt');
    ok(!/engine/.test(env.dialogCalls[0].detail), 'without any engine line');
  }

  // ── the ready prompt's "Later" also starts the reminder (desktop only) ───
  {
    const env = load({ engineStatus: null, dialogResponses: [1] });
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    ok(reminderTimer(env), 'Later at the ready prompt starts the 90-minute reminder');
  }

  // ── a release offered once is not offered again by the periodic check ────
  {
    const env = load({ dialogResponses: [1] });
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48');
    ok(schedulerTick(env), 'the scheduler tick exists');
    env.autoUpdater.finishDownload && env.autoUpdater.finishDownload();
    await schedulerTick(env).fn(); await tick();
    eq(env.dialogCalls.length, 1, 'the periodic check does not show the combined screen a second time');
  }

  // ── FLOWPAD-2308: the periodic pass runs on the account's schedule, not on every tick ──
  {
    // Fresh state: the first tick checks (both channels), the next tick is not due for a day.
    const env = load();
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.checks, 1, 'first tick ever: the desktop check runs');
    eq(env.uv.checks, 1, 'and the engine check with it');
    eq(env.readSchedule().lastResult, { state: 'current', version: null }, 'the answer is persisted');
    await schedulerTick(env).fn(); await tick();
    eq([env.autoUpdater.checks, env.uv.checks], [1, 1], 'the next tick is not due: NEITHER channel is checked');
  }
  {
    // @langware.ai checks hourly; everyone else daily — same two-hour-old state, different verdicts.
    const staleByTwoHours = { lastSuccessAt: agoIso(2 * HOUR), lastAttemptAt: agoIso(2 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 };
    const internal = load({ accountEmail: 'dev@langware.ai' });
    internal.writeSchedule(staleByTwoHours);
    internal.t.setupElectronAutoUpdater();
    await schedulerTick(internal).fn(); await tick();
    eq(internal.autoUpdater.checks, 1, 'internal account, last check 2h ago: due (hourly)');
    const regular = load({ accountEmail: 'user@example.com' });
    regular.writeSchedule(staleByTwoHours);
    regular.t.setupElectronAutoUpdater();
    await schedulerTick(regular).fn(); await tick();
    eq(regular.autoUpdater.checks, 0, 'regular account, same state: not due (daily)');
    // An account switch re-reads the email on the next pass: the overdue check fires at once.
    writeAccountEmail('dev@langware.ai');
    await regular.t.runScheduledUpdateCheck(); await tick();
    eq(regular.autoUpdater.checks, 1, 'switching to an internal account makes the stale check due');
  }
  {
    // RESTART: the persisted answer is reused — no check, and the engine is NOT held by it.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const first = load({ userDataDir });
    eq(await first.t.startLaunchDesktopCheck(), null, 'first launch: the real check runs (nothing newer)');
    eq(first.autoUpdater.checks, 1, 'first launch: it hit the feed');
    const second = load({ userDataDir });
    eq(await second.t.startLaunchDesktopCheck(), null, 'relaunch inside the interval: skipped');
    eq(second.autoUpdater.checks, 0, 'a restart does not reset the interval — the feed is not touched');
    eq(second.t.getDesktopStatus().state, 'current', 'the status is seeded from the persisted answer');
    await second.t.checkPackageUpdateInBackground();
    eq(second.uv.checks, 1, 'so the engine check is not held by the skipped check');
  }
  {
    // RESTART with the announced version still the latest: no second screen — deferred silently.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.writeSchedule({ lastSuccessAt: agoIso(HOUR), lastAttemptAt: agoIso(HOUR), lastResult: { state: 'available', version: '0.2.48' }, failureCount: 0, lastOfferedDesktopVersion: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck();
    const p = env.t.installAndStartBackend();
    await tick(); await tick();
    env.autoUpdater.finishDownload(); // nothing waits on the deferred download
    const r = await p;
    eq(r.ok, true, 'restart, same version: startup proceeds');
    eq(env.autoUpdater.checks, 1, 'a pending update is re-checked at launch (never trusted stale)');
    eq(env.dialogCalls.length, 0, 'but the same version is NOT announced again');
    eq(env.autoUpdater.downloads.length, 1, 'it downloads silently instead (installs on the next quit)');
    ok(reminderTimer(env), 'and the 90-minute reminder will offer the restart');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'the engine still waits for the pending desktop');
  }
  {
    // ...a NEWER version than the announced one is a new announcement.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.49', dialogResponses: [1] });
    env.writeSchedule({ lastSuccessAt: agoIso(HOUR), lastAttemptAt: agoIso(HOUR), lastResult: { state: 'available', version: '0.2.48' }, failureCount: 0, lastOfferedDesktopVersion: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck();
    const p = env.t.installAndStartBackend();
    await tick(); await tick();
    env.autoUpdater.finishDownload();
    await p;
    eq(env.dialogCalls.length, 1, 'a strictly newer version is announced');
    eq(env.readSchedule().lastOfferedDesktopVersion, '0.2.49', 'and recorded as the one offered');
  }
  {
    // ...and the periodic tick after a restart re-arms the download without re-announcing.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'available', version: '0.2.48' }, failureCount: 0, lastOfferedDesktopVersion: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.checks, 1, 'overdue after a restart: the tick checks');
    eq(env.dialogCalls.length, 0, 'the version announced before the restart is not announced again');
    eq(env.autoUpdater.downloads.length, 1, 'its download is re-armed from the feed cache');
  }
  {
    // Failures back off instead of hammering, and a success resets the streak.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const env = load({ userDataDir, desktopCheckThrows: 'HTTP 500' });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq([env.autoUpdater.checks, env.readSchedule().failureCount], [1, 1], 'the failed check is counted');
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.checks, 1, 'inside the backoff window: the feed is left alone');
    env.writeSchedule({ ...env.readSchedule(), lastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    eq([env.autoUpdater.checks, env.readSchedule().failureCount], [2, 2], 'after the backoff it retries, and the streak grows');
    const recovered = load({ userDataDir });
    recovered.writeSchedule({ ...recovered.readSchedule(), lastAttemptAt: agoIso(schedule.BACKOFF_MAX_MS) });
    recovered.t.setupElectronAutoUpdater();
    await schedulerTick(recovered).fn(); await tick();
    eq([recovered.autoUpdater.checks, recovered.readSchedule().failureCount], [1, 0], 'a success ends the backoff');
  }
  {
    // Concurrency: a tick that lands while a pass is still running does nothing.
    const env = load();
    env.t.setupElectronAutoUpdater();
    let release;
    env.autoUpdater.checkForUpdates = () => { env.autoUpdater.checks++; return new Promise((r) => { release = r; }); };
    const first = schedulerTick(env).fn();
    await tick();
    await schedulerTick(env).fn();
    eq(env.autoUpdater.checks, 1, 'two ticks, one in-flight pass: one check');
    release({ updateInfo: { version: '0.2.47' } });
    await first;
  }
  {
    // A login observed through the instance dir flips the cadence without waiting for a tick.
    // The watch callback is driven directly (the OS's fs.watch delivery cannot be awaited
    // deterministically) and FLOWPAD_UPDATE_TEST=1 zeroes the debounce — no wall-clock waits.
    process.env.FLOWPAD_UPDATE_TEST = '1';
    try {
      const env = load({ accountEmail: 'user@example.com' });
      env.writeSchedule({ lastSuccessAt: agoIso(2 * HOUR), lastAttemptAt: agoIso(2 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
      env.t.disarmAccountWatch(); // only the direct calls below fire events — never the real OS watcher
      env.t.setupElectronAutoUpdater();
      writeAccountEmail('dev@langware.ai');
      env.t.fireAccountWatch('something-else.json');
      await new Promise((r) => setTimeout(r, 0)); await tick();
      eq(env.autoUpdater.checks, 0, 'an event for another file in the instance dir is filtered out');
      env.t.fireAccountWatch('config.json');
      await new Promise((r) => setTimeout(r, 0)); await tick(); await tick();
      eq(env.autoUpdater.checks, 1, 'logging in as @langware.ai makes the 2h-old check due at once');
    } finally { delete process.env.FLOWPAD_UPDATE_TEST; }
  }
  {
    // A transient ENGINE (PyPI) failure starts the ENGINE channel's own backoff: it retries without
    // dragging the desktop feed back to the network, and a later success clears only its streak.
    const env = load();
    env.t.setupElectronAutoUpdater();
    env.t.getUvManager().checkForUpdatesInBackground = async () => { throw new Error('pypi down'); };
    await schedulerTick(env).fn(); await tick();
    eq([env.readSchedule().engineFailureCount, env.readSchedule().failureCount], [1, 0], 'the engine failure is recorded on ITS channel; the feed streak stays clean');
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.checks, 1, 'inside the engine backoff: nothing re-checks');
    env.t.getUvManager().checkForUpdatesInBackground = async () => { env.uv.checks++; return false; };
    env.writeSchedule({ ...env.readSchedule(), engineLastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    eq([env.readSchedule().engineFailureCount, env.uv.checks], [0, 1], 'the engine retry runs and clears its streak');
    eq(env.autoUpdater.checks, 1, 'without a second desktop feed hit — the engine retry is engine-only');
  }
  {
    // "Update now" whose download was lost: the next due tick RESUMES the download — no new screen,
    // no deferral, no reminder, nothing adopted. The user already said yes.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', engineStatus: null, dialogResponses: [] });
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48'); // desktop-only: committed, download starts
    eq(env.autoUpdater.downloads.length, 1, 'the accepted download started');
    env.autoUpdater.finishDownload(); await tick(); // the download dies without update-downloaded
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.downloads.length, 2, 'the due tick resumes the download');
    eq(env.dialogCalls.length, 0, 'no screen the user did not ask for');
    eq(reminderTimer(env), undefined, 'no reminder — nothing was deferred');
    eq((env.readSchedule() || {}).lastAdoptedDesktopVersion, undefined, 'and nothing was adopted');
    env.autoUpdater.finishDownload(); await tick();
    eq(env.readSchedule().lastOfferedDesktopVersion, '0.2.48', 'the landed resume spends the watermark, like the original announcement');
  }
  {
    // A RELAUNCH inside a failure backoff retries for real (ticks still pace the backoff in-session).
    const env = load();
    env.writeSchedule({ lastSuccessAt: agoIso(HOUR), lastAttemptAt: agoIso(60 * 1000), lastResult: { state: 'current', version: null }, failureCount: 2 });
    eq(await env.t.startLaunchDesktopCheck(), null, 'launch retry: the check ran (nothing newer)');
    eq(env.autoUpdater.checks, 1, 'a relaunch inside the backoff hits the feed for real');
  }
  {
    // An engine-status throw mid-offer degrades to the DESKTOP-ONLY offer instead of losing the
    // update (and the desktop-only path commits its watermark at the point it commits to deliver).
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    env.t.getUvManager()._pypiUpdateStatus = async () => { throw new Error('pypi down'); };
    eq(await env.t.offerDesktopUpdate('0.2.48'), 'desktop', 'engine status down: the offer degrades to desktop-only');
    eq(env.dialogCalls.length, 0, 'no combined screen');
    eq(env.autoUpdater.downloads.length, 1, 'the desktop download still starts');
    eq((env.readSchedule() || {}).lastOfferedDesktopVersion, undefined, 'nothing is spent before the download lands');
    env.autoUpdater.finishDownload(); await tick();
    eq(env.readSchedule().lastOfferedDesktopVersion, '0.2.48', 'the landed download commits the delivery');
  }
  {
    // Desktop-only announcement: a FAILED download leaves the version announceable — the next due
    // tick announces (downloads) it again instead of silently adopting it.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', engineStatus: null });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.downloads.length, 1, 'the due tick starts the desktop-only download');
    env.autoUpdater.failDownload(new Error('feed died mid-download')); await tick();
    eq((env.readSchedule() || {}).lastOfferedDesktopVersion, undefined, 'a dead download spends nothing');
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick(); await tick();
    eq(env.autoUpdater.downloads.length, 2, 'the next due tick announces it again');
    env.autoUpdater.finishDownload(); await tick();
    eq(env.readSchedule().lastOfferedDesktopVersion, '0.2.48', 'and the landed retry commits it');
  }
  {
    // The version already ON SCREEN is not a follow-up debt: ticks under the open dialog leave the
    // debt clear, so an engine retry that comes due gets its turn instead of being starved.
    const env = load({ holdDialog: true, appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.dialogCalls.length, 1, 'the offer for 0.2.48 is up');
    await schedulerTick(env).fn(); await tick();
    await schedulerTick(env).fn(); await tick();
    eq(env.logLines.filter((l) => /package check/.test(l)).length, 0,
      'ticks under the dialog are QUIET — the same-version announce owes nothing and nothing spins');
    eq(env.dialogCalls.length, 1, 'still one window');
    eq(env.autoUpdater.checks, 1, 'and no feed re-hits from a same-version follow-up loop');
    env.releaseDialog(); await tick(); await tick();
    await schedulerTick(env).fn(); await tick();
    ok(env.logLines.some((l) => /package check skipped: the desktop is updated first/.test(l)),
      'closing the dialog arms the engine debt once, and the next tick serves it');
  }
  {
    // A pass due only to the FEED's backoff retries the feed alone — the engine keeps its own cadence.
    const env = load({ desktopCheckThrows: 'HTTP 500' });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick(); // first-run pass: both halves (feed fails, engine held/attempted)
    const enginePassesBefore = env.logLines.filter((l) => /\[uv\] periodic package check/.test(l)).length;
    env.writeSchedule({ ...env.readSchedule(), lastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.checks, 2, 'the feed-backoff pass retries the feed');
    eq(env.logLines.filter((l) => /\[uv\] periodic package check/.test(l)).length, enginePassesBefore,
      'without touching the engine half — it is not what failed');
  }
  {
    // The account-change path honors the harness bypass: a stale schedule from a previous run must
    // not swallow the recalculation pass.
    process.env.FLOWPAD_UPDATE_TEST = '1';
    process.env.FLOWPAD_UPDATE_TEST_CHECK_INTERVAL_MS = '1234';
    try {
      const env = load({ accountEmail: 'user@example.com' });
      env.writeSchedule({ lastSuccessAt: agoIso(1000), lastAttemptAt: agoIso(1000), lastResult: { state: 'current', version: null }, failureCount: 0 });
      env.t.disarmAccountWatch();
      env.t.setupElectronAutoUpdater();
      writeAccountEmail('dev@langware.ai');
      env.t.fireAccountWatch('config.json');
      await new Promise((r) => setTimeout(r, 0)); await tick(); await tick();
      eq(env.autoUpdater.checks, 1, 'under the harness, the account change checks even though the schedule says not-due');
    } finally {
      delete process.env.FLOWPAD_UPDATE_TEST;
      delete process.env.FLOWPAD_UPDATE_TEST_CHECK_INTERVAL_MS;
    }
  }
  {
    // D1: a SCHEDULED pass landing on the version already on screen leaves NO desktop debt —
    // the engine retry is not starved by phantom follow-ups.
    const env = load({ holdDialog: true, appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.dialogCalls.length, 1, 'the offer is up');
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick(); // a due pass finds the same version under the open dialog
    eq(env.dialogCalls.length, 1, 'same version: no second window');
    env.writeSchedule({ ...env.readSchedule(), engineFailureCount: 1, engineLastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    ok(env.logLines.some((l) => /engine check retry due/.test(l)),
      'the engine retry gets the next pass — the on-screen version owed nothing');
    env.releaseDialog(); await tick(); await tick();
  }
  {
    // D2: a pass that THROWS gives back the debt it was carrying.
    const env = load({ holdDialog: true, engineStatus: null, dialogResponses: [] });
    env.t.setupElectronAutoUpdater();
    const prompt = env.t.showDesktopReadyPrompt('0.2.50'); await tick(); // an open prompt blocks the engine half
    await schedulerTick(env).fn(); await tick();
    const uvm = env.t.getUvManager();
    uvm.getInstalledFlowBin = () => { throw new Error('boom'); }; // the follow-up pass will throw mid-flight
    await schedulerTick(env).fn(); await tick();
    delete uvm.getInstalledFlowBin;
    env.releaseDialog(); await prompt;
    await schedulerTick(env).fn(); await tick();
    eq(env.uv.checks, 1, 'the debt survived the throwing pass and was paid once unblocked');
  }
  {
    // D3: an unanswered PyPI is not a withdrawal — the desktop-only fallback keeps an agreed engine.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.46', consented: true }));
    env.t.getUvManager()._pypiUpdateStatus = async () => { throw new Error('pypi down'); };
    await env.t.offerDesktopUpdate('0.2.48');
    eq(env.readState() && env.readState().engineVersion, '0.2.180', 'engine status threw: the agreed engine is kept');
    const swallowed = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    swallowed.t.setupElectronAutoUpdater();
    fs.writeFileSync(swallowed.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.46', consented: true }));
    const uvm2 = swallowed.t.getUvManager();
    uvm2._pypiUpdateStatus = async () => { uvm2.pypiLookupFailures = (uvm2.pypiLookupFailures || 0) + 1; return null; };
    await swallowed.t.offerDesktopUpdate('0.2.48');
    eq(swallowed.readState() && swallowed.readState().engineVersion, '0.2.180', 'a swallowed PyPI outage keeps it too');
    const clean = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', engineStatus: null });
    clean.t.setupElectronAutoUpdater();
    fs.writeFileSync(clean.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.46', consented: true }));
    await clean.t.offerDesktopUpdate('0.2.48');
    eq(clean.readState(), null, 'a clean "no engine update" answer withdraws the stale agreement');
  }
  {
    // Orphaned atomic-write tmp files (a crash between write and rename) are swept at setup.
    const env = load();
    const orphan = path.join(env.userData, 'update-schedule.json.999.111.tmp');
    const fresh = path.join(env.userData, 'update-schedule.json.998.111.tmp');
    const own = path.join(env.userData, `update-schedule.json.${process.pid}.111.tmp`);
    const real = path.join(env.userData, 'update-schedule.json');
    fs.writeFileSync(orphan, '{}');
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(orphan, hourAgo, hourAgo);
    fs.writeFileSync(fresh, '{}');
    fs.writeFileSync(own, '{}');
    fs.writeFileSync(real, JSON.stringify({ failureCount: 0 }));
    env.t.setupElectronAutoUpdater();
    eq(fs.existsSync(orphan), false, 'an OLD orphan of another process is swept');
    eq(fs.existsSync(fresh), true, "a fresh tmp of another process is left alone — it may be mid-write");
    eq(fs.existsSync(own), true, "the CURRENT process's tmp is never touched");
    eq(fs.existsSync(real), true, 'the real state file stays');
    fs.rmSync(fresh, { force: true }); fs.rmSync(own, { force: true });
  }
  {
    // F1a: a tick landing inside a launch offer's engine-status await (before packageUpdateInFlight
    // turns on) does not launch a second offer — startOffer's flag is synchronous for every path.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    const uvm = env.t.getUvManager();
    let statusCalls = 0; let release;
    uvm._pypiUpdateStatus = () => { statusCalls++; return new Promise((r) => { release = () => r(null); }); };
    const p = env.t.startOffer('0.2.48'); // the launch-path offer, parked inside the status await
    await schedulerTick(env).fn(); await tick();
    eq(statusCalls, 1, 'a tick inside that window does not start a second offer');
    release(); await p; await tick();
    eq(env.autoUpdater.downloads.length, 1, 'one offer, one download');
  }
  {
    // F1b: ticks under the LAUNCH offer's dialog owe nothing, exactly like tick-launched offers.
    const env = load({ holdDialog: true, appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    const p = env.t.startOffer('0.2.48'); await tick();
    eq(env.dialogCalls.length, 1, 'the launch offer is up');
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick();
    eq(env.dialogCalls.length, 1, 'a due tick on the same version adds no window');
    env.writeSchedule({ ...env.readSchedule(), engineFailureCount: 1, engineLastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    ok(env.logLines.some((l) => /engine check retry due/.test(l)), 'and no phantom desktop debt starves the engine retry');
    env.releaseDialog(); await p; await tick();
  }
  {
    // G1: a follow-up works from the CACHE — a stale 'available' naming the version the app already
    // runs must not produce an offer or a download.
    const env = load({ holdDialog: true, appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [] });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    const prompt = env.t.showDesktopReadyPrompt('0.2.50'); await tick(); // blocks the announce → desktop debt
    await schedulerTick(env).fn(); await tick();
    eq(env.dialogCalls.length, 1, 'the offer is blocked behind the prompt (debt armed)');
    env.writeSchedule({ ...env.readSchedule(), lastResult: { state: 'available', version: '0.2.47' } }); // stale: the running version
    env.releaseDialog(); await prompt;
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.downloads.length, 0, 'a cached answer no newer than the running app moves nothing');
    eq(env.dialogCalls.length, 1, 'and announces nothing');
  }
  {
    // F3: a version that already downloaded is not re-downloaded by 'resume' — the postponed ready
    // prompt and the 90-minute reminder own it from here.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', engineStatus: null, backendReady: false });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await env.t.startOffer('0.2.48'); // desktop-only: the download starts
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    env.autoUpdater.finishDownload(); await tick();
    eq(env.dialogCalls.length, 0, 'backend still starting: the ready prompt is postponed');
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.downloads.length, 1, 'the landed version is not downloaded again by resume');
  }
  {
    // A deterministically failing offer re-arms its debt at most MAX_FOLLOW_UP_RETRIES times per
    // interval — never an every-5-minutes loop forever — and recovers on the next interval.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    const uvm = env.t.getUvManager();
    let attempts = 0;
    uvm.deferPackageVersion = () => { attempts++; throw new Error('boom'); };
    for (let i = 0; i < 7; i++) { await schedulerTick(env).fn(); await tick(); await tick(); }
    eq(attempts, 4, 'one scheduled attempt + three capped retries, then silence');
    eq(env.autoUpdater.checks, 1, 'the retries worked from the cache — one feed hit');
    ok(env.logLines.some((l) => /follow-up gave up after 3 failed passes/.test(l)), 'and the give-up is logged');
    // The next interval starts a fresh streak; with the fault gone the offer completes.
    delete uvm.deferPackageVersion;
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick(); await tick();
    eq(env.dialogCalls.length, 1, 'a fresh interval retries and the recovered offer reaches its screen');
  }
  {
    // uv-manager swallows PyPI outages into null answers, so checkForUpdatesInBackground returns
    // normally — the lookup flag is what must arm the ENGINE backoff.
    const env = load();
    env.t.setupElectronAutoUpdater();
    const uvm = env.t.getUvManager();
    uvm.pypiLookupFailures = 7; // failures from BEFORE this window must not count...
    uvm.checkForUpdatesInBackground = async () => { uvm.pypiLookupFailures++; return false; };
    await schedulerTick(env).fn(); await tick();
    eq(env.readSchedule().engineFailureCount, 1, 'a swallowed PyPI outage still starts the engine backoff');
    uvm.checkForUpdatesInBackground = async () => { env.uv.checks++; return false; };
    env.writeSchedule({ ...env.readSchedule(), engineLastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    eq([env.readSchedule().engineFailureCount, env.uv.checks], [0, 1], 'a clean lookup clears it');
  }
  {
    // An engine-retry pass must not erase the DESKTOP's follow-up debt: a blocked offer survives it
    // and fires on the next tick.
    const env = load({ holdDialog: true, appVersion: '0.2.47', desktopFeed: '0.2.49', dialogResponses: [1, 1] });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0, lastOfferedDesktopVersion: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    // A held restart prompt for a NEWER version than the feed: a blocker no supersede removes.
    const prompt = env.t.showDesktopReadyPrompt('0.2.50');
    await tick();
    const blockedTick = schedulerTick(env).fn(); // due: finds 0.2.49, offer blocked by the open prompt
    await tick(); await tick();
    eq(env.dialogCalls.length, 1, 'the offer is blocked behind the open restart prompt');
    // An engine backoff comes due while the prompt is still open: other passes run...
    env.writeSchedule({ ...env.readSchedule(), engineFailureCount: 1, engineLastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    const retryTick = schedulerTick(env).fn();
    await tick(); await tick();
    eq(env.dialogCalls.length, 1, 'still one window while the prompt is open');
    env.releaseDialog();
    await prompt; await blockedTick; await retryTick;
    await schedulerTick(env).fn(); await tick(); await tick();
    eq(env.dialogCalls.length, 2, '...and the blocked desktop offer still fires on the next tick');
    eq(env.autoUpdater.checks, 1, 'from the cache — the feed was hit once in all of this');
  }
  {
    // A version adopted silently is RESUMED (not re-adopted) on the next launch, and the announce
    // watermark stays at the higher pulled release.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const first = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    first.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'available', version: '0.2.49' }, failureCount: 0, lastOfferedDesktopVersion: '0.2.49' });
    first.t.setupElectronAutoUpdater();
    await schedulerTick(first).fn(); await tick();
    eq(first.readSchedule().lastAdoptedDesktopVersion, '0.2.48', 'the regression adoption is persisted');
    const second = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    second.t.setupElectronAutoUpdater();
    second.t.primeLaunchCheck();
    const p = second.t.installAndStartBackend();
    await tick(); await tick();
    second.autoUpdater.finishDownload();
    const r = await p;
    eq(r.ok, true, 'resume: startup proceeds');
    eq(second.dialogCalls.length, 0, 'resume: still silent');
    eq(second.autoUpdater.downloads.length, 1, 'resume: the cached download is restarted');
    eq(second.readSchedule().lastOfferedDesktopVersion, '0.2.49', 'the announce watermark never dropped');
  }
  {
    // FEED REGRESSION at launch (a pulled release): older than the last announced version but newer
    // than the running build — adopted silently, so the held engine always has a way forward.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.writeSchedule({ lastSuccessAt: agoIso(HOUR), lastAttemptAt: agoIso(HOUR), lastResult: { state: 'available', version: '0.2.49' }, failureCount: 0, lastOfferedDesktopVersion: '0.2.49' });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck();
    const p = env.t.installAndStartBackend();
    await tick(); await tick();
    env.autoUpdater.finishDownload();
    const r = await p;
    eq(r.ok, true, 'feed regression: startup proceeds');
    eq(env.dialogCalls.length, 0, 'feed regression: no announcement for an older release');
    eq(env.autoUpdater.downloads.length, 1, 'feed regression: it still downloads (installs on the next quit)');
    ok(reminderTimer(env), 'feed regression: the reminder will offer the restart — the engine hold is not a dead end');
  }
  {
    // ...and the same regression found by the periodic tick.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'available', version: '0.2.49' }, failureCount: 0, lastOfferedDesktopVersion: '0.2.49' });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.dialogCalls.length, 0, 'tick regression: no announcement');
    eq(env.autoUpdater.downloads.length, 1, 'tick regression: adopted silently');
    ok(reminderTimer(env), 'tick regression: reminder armed');
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.downloads.length, 1, 'a later tick does not restart the adopted download');
  }
  {
    // An engine check blocked by the open restart prompt is retried on a NEAR tick (session
    // follow-up), not a whole interval later — and the retry does not hit the desktop feed again.
    const env = load({ holdDialog: true, engineStatus: null });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq([env.autoUpdater.checks, env.uv.checks], [1, 1], 'first tick: both channels ran');
    const prompt = env.t.showDesktopReadyPrompt('0.2.48'); // held open by holdDialog
    await tick();
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.checks, 2, 'due tick: the desktop check ran');
    eq(env.uv.checks, 1, 'but the engine check was blocked by the open prompt');
    env.releaseDialog();
    await prompt;
    await schedulerTick(env).fn(); await tick();
    eq(env.uv.checks, 2, 'the blocked engine half is finished on the next tick');
    eq(env.autoUpdater.checks, 2, 'without a second desktop feed hit inside the interval');
  }
  // (A tick that finds a NEWER version while an offer dialog is open now SUPERSEDES that dialog
  //  instead of waiting — covered by the "superseded" test below; the blocked-offer follow-up is
  //  covered by the restart-prompt and offer-throws tests.)
  {
    // ONE update window, and the scheduler keeps breathing under it: ticks while the offer dialog
    // waits for the user do not stack windows and still run the engine half afterwards.
    const env = load({ holdDialog: true, appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.dialogCalls.length, 1, 'the due tick launches the offer');
    await schedulerTick(env).fn(); await tick();
    await schedulerTick(env).fn(); await tick();
    eq(env.dialogCalls.length, 1, 'more ticks while it waits: still ONE window');
    env.releaseDialog();
    await tick(); await tick();
    eq(env.readSchedule().lastOfferedDesktopVersion, '0.2.48', 'the answered offer is recorded');
    await schedulerTick(env).fn(); await tick();
    ok(env.logLines.some((l) => /package check skipped: the desktop is updated first/.test(l)),
      'the engine debt armed by the closing dialog is served on the next tick (and held: desktop first, by design)');
  }
  {
    // A newer release while the offer waits: the open window is superseded — closed and replaced by
    // exactly one window for the newest version, whose answer is the one that counts.
    const env = load({ holdDialog: true, appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.dialogCalls.length, 1, 'the offer for 0.2.48 is up');
    env.autoUpdater.checkForUpdates = async () => { env.autoUpdater.checks++; return { updateInfo: { version: '0.2.49' } }; };
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick(); await tick();
    eq(env.dialogCalls.length, 2, 'the old window is closed and ONE window for 0.2.49 replaces it');
    ok(/0\.2\.49/.test(env.dialogCalls[1].detail), 'the new window names the newest version');
    env.releaseDialog();
    await tick(); await tick();
    eq(env.readSchedule().lastOfferedDesktopVersion, '0.2.49', 'only the answered window is recorded');
    ok(env.uv.undeferred.includes('0.2.180'), "the superseded offer's engine deferral is withdrawn");
    eq(env.readState() && env.readState().desktopVersion, '0.2.49', 'pending-engine.json belongs to the NEW offer only');
  }
  {
    // An engine RETRY that lands on the desktop-first hold is paced forward by the backoff — it
    // does not come back every tick — and the streak is not grown by it.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', engineStatus: null, dialogResponses: [] });
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48'); // desktop pending from here on: the engine is held
    env.writeSchedule({ ...(env.readSchedule() || {}), lastSuccessAt: agoIso(HOUR), lastAttemptAt: agoIso(HOUR), lastResult: { state: 'available', version: '0.2.48' }, failureCount: 0, engineFailureCount: 1, engineLastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    ok(env.logLines.some((l) => /engine check retry due/.test(l)), 'the engine retry pass ran once');
    eq(env.readSchedule().engineFailureCount, 1, 'a held retry does not grow the streak');
    const retriesBefore = env.logLines.filter((l) => /engine check retry due/.test(l)).length;
    await schedulerTick(env).fn(); await tick();
    eq(env.logLines.filter((l) => /engine check retry due/.test(l)).length, retriesBefore,
      'and it is paced by the backoff — not due again on the very next tick');
  }
  {
    // An offer that throws arms the desktop debt: the next tick retries from the cache.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    const uvm = env.t.getUvManager();
    const defer = uvm.deferPackageVersion.bind(uvm);
    uvm.deferPackageVersion = () => { throw new Error('boom'); };
    await schedulerTick(env).fn(); await tick(); await tick();
    eq(env.dialogCalls.length, 0, 'the offer died before its screen');
    uvm.deferPackageVersion = defer;
    await schedulerTick(env).fn(); await tick(); await tick();
    eq(env.dialogCalls.length, 1, 'the next tick retries the offer from the cache');
    eq(env.autoUpdater.checks, 1, 'without a second feed hit');
  }
  {
    // The update-cycle harness drives the cadence itself: its interval bypasses the schedule.
    process.env.FLOWPAD_UPDATE_TEST = '1';
    process.env.FLOWPAD_UPDATE_TEST_CHECK_INTERVAL_MS = '1234';
    try {
      const env = load();
      env.writeSchedule({ lastSuccessAt: agoIso(1000), lastAttemptAt: agoIso(1000), lastResult: { state: 'current', version: null }, failureCount: 0 });
      env.t.setupElectronAutoUpdater();
      const harnessTick = env.intervals.find((i) => i.ms === 1234);
      ok(harnessTick, 'the harness interval is the tick');
      await harnessTick.fn(); await tick();
      eq(env.autoUpdater.checks, 1, 'and it checks unconditionally, schedule or not');
    } finally {
      delete process.env.FLOWPAD_UPDATE_TEST;
      delete process.env.FLOWPAD_UPDATE_TEST_CHECK_INTERVAL_MS;
    }
  }

  // ── an installed desktop/engine pair the contract forbids (engine-compat.js): repaired with a DIRECTION ──
  {
    const engineOld = { message: 'm', reasons: ['FlowPad Desktop 0.2.47 requires Backend 0.2.60 or newer (backend: 0.2.40)'], engineVersion: '0.2.40', minDesktopVersion: null, desktopTooOld: false };
    const desktopOld = { message: 'm', reasons: ['FlowPad Backend 0.2.70 requires Desktop 0.2.60 or newer (installed Desktop: 0.2.47)'], engineVersion: '0.2.70', minDesktopVersion: '0.2.60', desktopTooOld: true };
    const compatible = { version: '0.2.65', minDesktopVersion: null };
    const upgradedTo = (env) => env.uv.upgrades.map((u) => u.version);

    {
      // The ENGINE is the old side: upgrading it is the safe direction -- done without a question.
      const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', pairIssue: engineOld, compatibleRelease: compatible });
      await env.t.getDesktopUpdateVersion();
      const r = await env.t.installAndStartBackend();
      eq(r.ok, true, 'engine too old: startup succeeds');
      eq(upgradedTo(env), ['0.2.65'], 'engine too old: the compatible engine is installed');
      eq(env.dialogCalls.length, 0, 'engine too old: no question (an upgrade cannot lose data)');
      eq(r.backendJustUpgraded, true, 'engine too old: the start waits the longer post-upgrade window');
    }
    {
      // The DESKTOP is the old side and the feed says "current": the repair is a downgrade -> ask, and honour "switch".
      const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', pairIssue: desktopOld, compatibleRelease: compatible, dialogResponses: [0] });
      await env.t.getDesktopUpdateVersion();
      const r = await env.t.installAndStartBackend();
      eq(env.dialogCalls.length, 1, 'desktop too old: the user is asked first');
      ok(env.dialogCalls[0].buttons.includes('Switch to engine 0.2.65') && env.dialogCalls[0].buttons.includes('Keep the current engine'), 'the question names the engine it would install');
      ok(/needs a newer FlowPad Desktop/.test(env.dialogCalls[0].message) && /downgrade/.test(env.dialogCalls[0].detail), 'and says it is a downgrade');
      eq(env.dialogCalls[0].defaultId, 1, '"Keep" is the default (Enter does not downgrade)');
      eq(upgradedTo(env), ['0.2.65'], 'desktop too old, user switches: the compatible engine is installed');
      eq(r.ok, true, 'and startup succeeds');
    }
    {
      // ...and honour "keep": nothing is changed, the app still starts.
      const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', pairIssue: desktopOld, compatibleRelease: compatible, dialogResponses: [1] });
      await env.t.getDesktopUpdateVersion();
      const r = await env.t.installAndStartBackend();
      eq(r.ok, true, 'desktop too old, user keeps: startup still succeeds');
      eq(upgradedTo(env), [], 'the engine is NOT downgraded behind the user\'s back');
      ok(env.logLines.some((l) => /the user kept engine 0\.2\.70/.test(l)), 'and the log says the user chose it');
    }
    {
      // A newer desktop is known: the engine is held (update-plan.js), the desktop offer is the fix -- no question, no change.
      const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', pairIssue: desktopOld, compatibleRelease: compatible });
      await env.t.getDesktopUpdateVersion();
      await env.t.installAndStartBackend();
      eq(upgradedTo(env), [], 'newer desktop pending: the engine is held');
      ok(!env.dialogCalls.some((d) => /needs a newer FlowPad Desktop/.test(d.message || '')), 'and the downgrade question is not asked');
    }
    {
      // Nothing compatible to move to (or it is what is installed already): nothing happens, nothing is asked.
      for (const release of [null, { version: '0.2.70', minDesktopVersion: null }]) {
        const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', pairIssue: desktopOld, compatibleRelease: release });
        await env.t.getDesktopUpdateVersion();
        const r = await env.t.installAndStartBackend();
        eq([r.ok, upgradedTo(env), env.dialogCalls.length], [true, [], 0], `no usable target (${release ? 'same as installed' : 'none'}): startup proceeds untouched`);
      }
    }
    {
      // Fix: the ENGINE is the old side and the FEED CHECK FAILED ('unknown' → engine changes held):
      // the repair still runs — it installs a release chosen for the RUNNING desktop, so the hold
      // (which protects a PENDING newer desktop) is irrelevant in this direction. Holding it left
      // an incompatible pair running with only a log line.
      const env = load({ appVersion: '0.2.47', desktopCheckThrows: 'feed offline', pairIssue: engineOld, compatibleRelease: compatible });
      await env.t.getDesktopUpdateVersion();
      eq(env.t.engineChangeAllowed('test'), 'hold', 'the failed feed check holds ordinary engine changes');
      const r = await env.t.installAndStartBackend();
      eq([r.ok, upgradedTo(env)], [true, ['0.2.65']], 'engine too old: repaired despite the hold');
    }
    {
      // A repair that FAILS must not break startup either.
      const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', pairIssue: engineOld, compatibleRelease: compatible, upgradeThrows: 'uv failed' });
      await env.t.getDesktopUpdateVersion();
      const r = await env.t.installAndStartBackend();
      eq(r.ok, true, 'a failing repair: startup continues with the installed engine');
      ok(env.logLines.some((l) => /could not repair the incompatible pair/.test(l)), 'and the log says why');
    }
  }

  // ── next launch of the NEW desktop: install exactly the agreed version ───
  {
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', dialogResponses: [] });
    fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: true }));
    const r = await env.t.installAndStartBackend();
    eq(r.ok, true, 'startup succeeds');
    eq(env.uv.upgrades, [Object.assign({ version: '0.2.180' }, { onProgress: env.uv.upgrades[0] && env.uv.upgrades[0].onProgress })], 'installs flowpad==0.2.180 — the version that was agreed, not "latest"');
    eq(env.readState(), null, 'the saved version is spent');
    eq(env.dialogCalls.length, 0, 'no dialog: the user already agreed');
    eq(r.backendJustUpgraded, true, 'the start waits the longer post-upgrade window');
  }
  {
    // The new desktop was installed on quit after "Later" (nothing agreed): today's engine dialog, never a silent install.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48' });
    await env.t.getDesktopUpdateVersion(); // the launch-time check answered: running the latest desktop
    fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: false }));
    await env.t.installAndStartBackend();
    eq(env.uv.upgrades.length, 0, 'no silent install without agreement');
    eq(env.uv.checks, 1, 'the regular engine prompt runs instead');
    eq(env.readState(), null, 'and the saved version is cleared');
  }
  {
    // Still the old desktop (the update was not applied): keep the saved version, offer the desktop again.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: true }));
    await env.t.installAndStartBackend();
    eq(env.uv.upgrades.length, 0, 'the old desktop never installs the saved engine version');
  }
  {
    // A failing agreed install must not break startup.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', upgradeThrows: 'uv failed' });
    fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: true }));
    const r = await env.t.installAndStartBackend();
    eq(r.ok, true, 'startup still succeeds with the current engine');
    ok(env.logLines.some((l) => /installing the agreed engine 0\.2\.180 failed/.test(l)), 'and the failure is logged');
  }

  {
    // No window to show the error panel in: the native dialog (with "Send Report") must be AWAITED, because the
    // caller quits the app as soon as this returns false — quitting first would close the only explanation.
    const env = load({ holdDialog: true });
    env.t.setMainWindow(null);
    let settled = null;
    const p = env.t.showStartupErrorPanel('boom', { retryable: true }).then((v) => { settled = v; });
    await tick(); await tick();
    eq(env.dialogCalls.length, 1, 'the native dialog is shown');
    ok(env.dialogCalls[0].buttons.includes('Send Report'), 'and it offers Send Report');
    eq(settled, null, 'the call does not return while the dialog is still open');
    env.releaseDialog();
    await p;
    eq(settled, false, 'it returns false (no window) once the user has answered');
  }

  {
    // A crash that escapes to the top level reaches the user with the in-app panel (which has Share), once.
    const env = load();
    await env.t.reportStartupCrash(new Error('kaboom at startApp'), 'startApp');
    const panel = env.sent.filter(([ch]) => ch === 'startup-error');
    eq(panel.length, 1, 'the error panel is shown for an escaped startApp failure');
    ok(/kaboom at startApp/.test(panel[0][1].detail), 'with the cause');
    eq(panel[0][1].retryable, false, 'not retryable (there is no startup loop to resume)');
    await env.t.reportStartupCrash(new Error('second'), 'uncaught exception');
    eq(env.sent.filter(([ch]) => ch === 'startup-error').length, 1, 'a second crash does not stack panels');
  }
  {
    const env = load();
    ok(typeof env.processHandlers.uncaughtException === 'function', 'an uncaughtException handler is installed');
    env.processHandlers.uncaughtException(new Error('late boom'));
    await tick(); await tick();
    ok(env.sent.some(([ch, d]) => ch === 'startup-error' && /late boom/.test(d.detail)), 'an uncaught exception reaches the panel');
    // Unhandled rejections are logged, never a dialog.
    const env2 = load();
    env2.processHandlers.unhandledRejection(new Error('benign'));
    await tick();
    eq(env2.sent.length, 0, 'an unhandled rejection shows nothing');
    ok(env2.logLines.some((l) => /unhandled rejection/.test(l) && /benign/.test(l)), 'but it is logged');
  }
  {
    // No window: the native dialog with Share, awaited (same as the startup path).
    const env = load({ dialogResponses: [0] });
    env.t.setMainWindow(null);
    await env.t.reportStartupCrash(new Error('no window'), 'startApp');
    eq(env.dialogCalls.length, 1, 'no window → native dialog');
    ok(env.dialogCalls[0].buttons.includes('Send Report'), 'with Send Report');
  }

    // ── a policy block in the LAUNCHER's output (flow start → pydantic → _pydantic_core, Rich-wrapped) ──
  {
    const env = load();
    global.fetch = async () => { throw new Error('ECONNREFUSED'); }; // nothing answers on the port
    const launch = {
      startedAt: Date.now(), lines: 1, lastLine: '', exit: { code: 1, signal: null },
      stdout: '2026-10-10T16:13:26.236Z [boot] t=14.1s phase=import modules=247 last=pydantic_core\n',
      stderr: '└──────┘\nImportError: DLL load failed while importing _pydantic_core: An Application \nControl policy has blocked this file.\n',
      tail: () => 'tail',
    };
    const w = await env.t.waitForBackend({ maxChecks: 2, launch });
    eq([w.ready, w.reason, w.policyBlock && w.policyBlock.module], [false, 'policy-blocked', '_pydantic_core'], 'a launcher exit with the policy signature is policy-blocked, not launcher-failed');
    ok(/launcher/.test(w.policyBlock.path), 'attributed to the launcher output');
    const plain = { ...launch, stderr: 'Traceback …\nModuleNotFoundError: No module named flow_sdk\n' };
    eq((await env.t.waitForBackend({ maxChecks: 2, launch: plain })).reason, 'launcher-failed', 'any other launcher failure stays launcher-failed');
    delete global.fetch;
  }

  // ── the version panel's update IPC (FLOWPAD-2310) ────────────────────────
  const pushes = (env) => env.sent.filter(([ch]) => ch === 'desktop-update-state').map(([, d]) => d);
  {
    // update:get-info — the one snapshot the panel renders from.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', preflight: { installed: '0.2.168', latest: '0.2.180', updateAvailable: true, latestMinDesktop: '0.2.48', latestCompatible: false, newestCompatible: '0.2.175' } });
    const info = await env.ipc['update:get-info']();
    eq(info.desktop, { installed: '0.2.47', state: 'available', available: '0.2.48', downloadState: 'idle', meetsEngineFloor: true }, 'get-info: a newer desktop on the feed is reported (and it satisfies the engine floor), nothing downloading yet');
    eq(info.engine && info.engine.latestCompatible, false, "get-info: the engine pre-flight is the shell's verdict, passed through");
    eq(info.busy, false, 'get-info: idle');
    eq(await env.ipc['update:take-resumed'](), null, 'nothing resumed');
  }
  {
    // update:download-desktop — one download, no dialog, engine held; Update Now applies it.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    const r = await env.ipc['update:download-desktop']();
    eq(r, { started: true, version: '0.2.48' }, 'download-desktop: starts and names the version');
    eq(env.autoUpdater.downloads.length, 1, 'download-desktop: exactly one download');
    eq(env.dialogCalls.length, 0, 'download-desktop: NO native dialog — the panel is the surface');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'download-desktop: engine changes hold for the whole window');
    eq(await env.ipc['update:download-desktop'](), { started: true, version: '0.2.48' }, 'a second click: no second download');
    eq(env.autoUpdater.downloads.length, 1, 'still one download');

    env.autoUpdater.emit('download-progress', { percent: 42, transferred: 42, total: 100 }); await tick();
    ok(pushes(env).some((d) => d.state === 'downloading' && d.percent === 42), 'progress reaches the panel');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq(env.dialogCalls.length, 0, 'downloaded: still no native prompt (panel flow)');
    ok(pushes(env).some((d) => d.state === 'ready' && d.version === '0.2.48'), 'the panel hears the download is ready');
    eq((await env.ipc['update:get-info']()).desktop.downloadState, 'ready', 'get-info now says ready');

    const applied = await env.ipc['update:apply-desktop']();
    eq(applied, { started: true, version: '0.2.48' }, 'apply-desktop: Update Now installs');
    eq(env.autoUpdater.quits, [[true, true]], 'quitAndInstall(silent, relaunch)');
    eq(env.uv.stopped, 1, 'the backend was stopped first');
    ok(pushes(env).some((d) => d.state === 'installing'), 'and the panel hears it is installing');
  }
  {
    // update:apply-desktop refusals — nothing downloaded, or another update running.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    eq(await env.ipc['update:apply-desktop'](), { started: false, reason: 'not-downloaded' }, 'apply-desktop: nothing downloaded → refused');
    env.uv.instance._isInstalling = true;
    eq((await env.ipc['update:download-desktop']()).reason, 'busy', 'download-desktop: refused while an engine install runs');
    eq((await env.ipc['update:apply-desktop']()).reason, 'busy', 'apply-desktop: refused while an engine install runs');
    env.uv.instance._isInstalling = false;
    eq(env.autoUpdater.downloads.length, 0, 'nothing was downloaded by the refused calls');
  }
  {
    // update:download-desktop with no newer desktop.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48' });
    eq(await env.ipc['update:download-desktop'](), { started: false, reason: 'no-update' }, 'download-desktop: running the latest → no-update');
  }
  {
    // update:both — the popup's consent is saved BEFORE the download, so quitting early still finishes both.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    eq(await env.ipc['update:both'](null, 'not a version'), { started: false, reason: 'invalid-version' }, 'update:both: a malformed version never becomes an install argument');
    const r = await env.ipc['update:both'](null, '0.2.180');
    eq(r, { started: true, version: '0.2.48' }, 'update:both: starts the desktop download');
    eq(env.readState(), Object.assign({}, env.readState(), { engineVersion: '0.2.180', desktopVersion: '0.2.48', source: 'panel', consented: true }), 'the engine version is saved, marked panel-initiated, and ALREADY consented (the popup click was the consent)');
    eq(env.uv.deferred, ['0.2.180'], 'no separate engine dialog for that version');
    eq(env.dialogCalls.length, 0, 'no native dialog anywhere in the panel flow');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'the engine holds until the new desktop runs');

    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq(env.dialogCalls.length, 0, 'downloaded: still no native prompt');
    // The scheduled pass must not re-offer or prompt over the panel flow.
    await env.t.runScheduledUpdateCheck({ bypassSchedule: true }); await tick();
    eq(env.dialogCalls.length, 0, 'the periodic check stays quiet while the panel flow is pending');
    const applied = await env.ipc['update:apply-desktop']();
    eq([applied.started, env.autoUpdater.quits.length], [true, 1], 'Update Now restarts into the new desktop');
    eq(env.readState().consented, true, 'the pending engine rides along, consented');
  }
  {
    // A background download the user postponed with the native "Later" surfaces in the panel as ready.
    const env = load({ engineStatus: null, dialogResponses: [1 /* Later at the ready prompt */] });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    await env.t.offerDesktopUpdate('0.2.48');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    const info = await env.ipc['update:get-info']();
    eq(info.desktop.downloadState, 'ready', 'a "Later"-deferred download reads as ready in the panel');
    eq(info.desktop.available, '0.2.48', 'and names the version');
    const applied = await env.ipc['update:apply-desktop']();
    eq([applied.started, env.autoUpdater.quits.length], [true, 1], 'Update Now installs the postponed update without waiting for a restart');
  }
  {
    // Next launch after a panel-initiated coordinated update: the agreed engine installs and the panel is told, once.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48' });
    fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.48', source: 'panel', consented: true }));
    const r = await env.t.installAndStartBackend();
    eq([r.ok, env.uv.upgrades.map((u) => u.version)], [true, ['0.2.180']], 'the agreed engine version is installed by the new desktop');
    eq(env.readState(), null, 'the record is spent only once the install LANDED');
    eq(await env.ipc['update:take-resumed'](), { success: true, engineVersion: '0.2.180', desktopVersion: '0.2.48' }, 'take-resumed reports the resumed outcome');
    eq(await env.ipc['update:take-resumed'](), null, '…exactly once');
  }
  {
    // Same, but the resumed engine install fails: the panel is told that too, and the engine is preserved.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', upgradeThrows: 'uv failed' });
    fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.48', source: 'panel', consented: true }));
    const r = await env.t.installAndStartBackend();
    eq(r.ok, true, 'startup still succeeds with the current engine');
    eq(await env.ipc['update:take-resumed'](), { success: false, engineVersion: '0.2.180', desktopVersion: '0.2.48', error: 'uv failed' }, 'the failure reaches the panel');
    eq(env.readState() && env.readState().consented, false, "the intent survives as a QUESTION for the next launch ('FlowPad will offer it again' is now true)");
  }
  {
    // A native-dialog coordinated update (no source) resumes silently — nothing pushed at the panel.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48' });
    fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: true }));
    await env.t.installAndStartBackend();
    eq(await env.ipc['update:take-resumed'](), null, 'a dialog-initiated resume stays out of the panel');
  }
  {
    // A failed download surfaces in the panel from the download's OWN catch (the Retry re-invokes
    // download-desktop); stray 'error' events on the shared emitter never touch the row.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.ipc['update:download-desktop']();
    env.autoUpdater.emit('error', new Error('emitter noise')); await tick();
    eq(pushes(env).filter((d) => d.state === 'error').length, 0, 'emitter noise is not a download error');
    env.autoUpdater.failDownload(new Error('download failed: network dropped')); await tick(); await tick();
    ok(pushes(env).some((d) => d.state === 'error' && /network dropped/.test(d.error)), "the download's own failure reaches the panel");
  }
  {
    // After a FAILED panel download the periodic tick retries it WITHOUT a native prompt: the panel
    // still owns that version's flow (it shows Ready/Update Now; the native "Restart now" never pops).
    const env = load({ engineStatus: null, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.ipc['update:download-desktop']();
    env.autoUpdater.emit('error', new Error('network dropped'));
    env.autoUpdater.finishDownload(); await tick(); await tick(); // the failed download settles; the in-flight flags reset
    await env.t.runScheduledUpdateCheck({ bypassSchedule: true }); await tick();
    eq(env.autoUpdater.downloads.length, 2, 'the scheduled pass re-downloads the panel-owned version');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq(env.dialogCalls.length, 0, 'no native prompt: the panel owns this version');
    ok(pushes(env).some((d) => d.state === 'ready' && d.version === '0.2.48'), 'the panel hears it is ready instead');
  }
  {
    // The panel ADOPTS a download the background flow already started WITH a prompt: Update Both over
    // an in-flight download turns the native "Restart now" off — the panel's own flow wins.
    const env = load({ engineStatus: null, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    await env.t.offerDesktopUpdate('0.2.48'); // desktop-only: downloads in the background, prompt on ready
    eq(env.autoUpdater.downloads.length, 1, 'the background download is running');
    const r = await env.ipc['update:both'](null, '0.2.180');
    eq([r.started, env.autoUpdater.downloads.length], [true, 1], 'adopted: started, and no second download');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq(env.dialogCalls.length, 0, 'no native "Restart now" over the adopted panel flow');
    eq(env.readState().consented, true, 'the engine rides along, consented');
  }
  {
    // The pinned engine does not fit even the TARGET desktop: Update Both SUBSTITUTES the newest
    // engine that desktop accepts — a doomed pin never rides, and the update is never refused.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', candidateFloor: '0.3.0', compatibleRelease: { version: '0.2.200', minDesktopVersion: null } });
    env.t.setupElectronAutoUpdater();
    const r = await env.ipc['update:both'](null, '0.2.240');
    eq([r.started, r.version], [true, '0.2.48'], 'started — with a substitute, not a refusal');
    eq([env.readState().engineVersion, env.readState().consented], ['0.2.200', true], 'the pending engine is the newest the target desktop accepts');
  }
  {
    // ...and when no compatible engine is newer than the installed one, the desktop goes ALONE
    // (the installed engine was selected for a desktop this one supersedes; the startup pair
    // repair has the last word) — never a refusal, never a doomed pin.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', candidateFloor: '0.3.0', compatibleRelease: { version: '0.2.100', minDesktopVersion: null } });
    env.t.setupElectronAutoUpdater();
    const r = await env.ipc['update:both'](null, '0.2.240');
    eq(r.started, true, 'started as a desktop-only update');
    eq(env.readState(), null, 'no pending engine was saved');
    eq(env.autoUpdater.downloads.length, 1, 'the desktop download runs');
  }
  {
    // Fix א (mid-session): the installed engine is below the RUNNING desktop's own floor and the
    // feed check failed ('unknown' → hold): the engine check proceeds anyway — the repair targets
    // THIS desktop, so the hold is irrelevant, and an incompatible pair must not run until relaunch.
    const env = load({ appVersion: '0.2.48', desktopCheckThrows: 'feed offline', engineStatus: null,
      pairIssue: { message: 'pair broken', reasons: ['engine below floor'], engineVersion: '0.2.100', minDesktopVersion: null, desktopTooOld: false } });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion(); // 'unknown' → engine changes held
    eq(env.t.engineChangeAllowed('test'), 'hold', 'the feed failure holds engine changes');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 1, 'the engine-old-side repair passes the hold (the pair must not wait for a relaunch)');
  }
  {
    // Fix א (surface): a pair that runs incompatible anyway is SHOWN by update:get-info.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48',
      pairIssue: { message: 'FlowPad Desktop 0.2.47 is not compatible with FlowPad Backend 0.2.100.', reasons: ['x'], engineVersion: '0.2.100', minDesktopVersion: null, desktopTooOld: false } });
    const info = await env.ipc['update:get-info']();
    ok(/not compatible/.test(info.pairWarning), 'the panel hears about the incompatible running pair');
  }
  {
    // "Later" at the native ready prompt starts the 90-minute reminder; ADOPTING the update from the
    // panel stops it, and the native ready prompt never pops over the panel's Ready state again.
    const env = load({ engineStatus: null, dialogResponses: [1 /* Later */] });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    await env.t.offerDesktopUpdate('0.2.48');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq([env.dialogCalls.length, env.t.readyReminder.running], [1, true], 'Later at the prompt: the reminder is armed');
    const r = await env.ipc['update:download-desktop']();
    eq([r.started, r.ready], [true, true], 'the panel adopts the already-downloaded update');
    eq(env.t.readyReminder.running, false, 'adoption stops the 90-minute reminder');
    await env.t.showDesktopReadyPrompt('0.2.48');
    eq(env.dialogCalls.length, 1, 'the native ready prompt stays away from a panel-owned version');
  }
  {
    // Once the download LANDED, a late stray error (a periodic feed check failing) does not replace
    // the panel's Ready state with a dead "Retry the download".
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.ipc['update:download-desktop']();
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    env.autoUpdater.finishDownload(); await tick(); // the download promise settles with the event
    env.sent.length = 0;
    env.autoUpdater.emit('error', new Error('periodic feed check failed')); await tick();
    eq(pushes(env).length, 0, 'ready is not replaced by a stray error after the download landed');
  }
  {
    // The panel's silencing is scoped to ITS version: a DIFFERENT release downloaded natively later
    // still gets the native ready prompt — panel ownership of 0.2.48 must not mute updates for ever.
    const env = load({ engineStatus: null, appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.t.setupElectronAutoUpdater();
    await env.ipc['update:download-desktop'](); // the panel owns 0.2.48
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    env.autoUpdater.finishDownload(); await tick();
    eq(env.dialogCalls.length, 0, 'panel-owned 0.2.48: no native prompt');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.49' }); await tick(); await tick();
    eq(env.dialogCalls.length, 1, 'a different, natively-downloaded release still prompts');
    eq(pushes(env).filter((d) => d.state === 'ready' && d.version === '0.2.49').length, 0,
      'the native prompt IS the ready surface — no duplicate "ready" row in the panel');
  }
  {
    // 'update:get-info' asks the feed at most once a minute: the popover open and the Upgrade click
    // right after it share one answer (the 20-minute tick calls the check directly, unthrottled).
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    let checks = 0;
    const orig = env.autoUpdater.checkForUpdates;
    env.autoUpdater.checkForUpdates = async (...a) => { checks += 1; return orig(...a); };
    await env.ipc['update:get-info']();
    await env.ipc['update:get-info']();
    eq(checks, 1, 'two get-info calls within the TTL: one feed check');
  }
  {
    // A FAILED feed check is not stamped into the TTL: "Check again" right after a failure really
    // asks again; only an ANSWERED check starts the quiet minute.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    let checks = 0; let failCheck = true;
    const orig = env.autoUpdater.checkForUpdates;
    env.autoUpdater.checkForUpdates = async (...a) => { checks += 1; if (failCheck) throw new Error('offline'); return orig(...a); };
    await env.ipc['update:get-info']();
    failCheck = false;
    await env.ipc['update:get-info']();
    eq(checks, 2, 'the failed check did not start the TTL — Check again really checked');
    await env.ipc['update:get-info']();
    eq(checks, 2, 'the ANSWERED check did: a third call within the minute is served from the snapshot');
  }
  {
    // An UNPARSEABLE floor is not positive knowledge: the pin stays held and nothing is stopped.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', candidateFloor: '1.0' });
    await env.t.getDesktopUpdateVersion();
    const r = await env.ipc['upgrade-flowpad'](null, { version: '0.2.240' });
    eq([r.desktopUpdatePending, env.uv.upgrades.length, env.uv.flowStops || 0], [true, 0, 0],
      'an unparseable floor: held, server untouched');
  }
  {
    // A release published WHILE the panel downloads: the panel keeps ownership of the superseding
    // version — its row restarts at 0% and no native dialog pops over it.
    const env = load({ engineStatus: null, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.ipc['update:download-desktop'](); // the panel downloads 0.2.48
    env.autoUpdater.checkForUpdates = async () => ({ updateInfo: { version: '0.2.49' } });
    const run = env.t.runScheduledUpdateCheck({ bypassSchedule: true });
    await tick(); env.autoUpdater.finishDownload(); // the cancelled 0.2.48 download settles
    await run; await tick();
    eq(env.dialogCalls.length, 0, 'no native dialog for the superseding release');
    eq(env.autoUpdater.downloads.length, 2, 'the superseding download started');
    ok(pushes(env).some((d) => d.state === 'downloading' && d.version === '0.2.49'), "the panel's row restarts for 0.2.49");
  }
  {
    // The panel owns a READY update and a newer release appears: ownership carries over — no native
    // dialog, and the consented panel record follows the new desktop instead of being overwritten.
    const env = load({ engineStatus: null, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.ipc['update:both'](null, '0.2.180');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    env.autoUpdater.finishDownload(); await tick();
    env.autoUpdater.checkForUpdates = async () => ({ updateInfo: { version: '0.2.49' } });
    await env.t.runScheduledUpdateCheck({ bypassSchedule: true }); await tick();
    eq(env.dialogCalls.length, 0, 'no native dialog over the panel-owned READY update');
    eq([env.readState().desktopVersion, env.readState().consented, env.readState().source], ['0.2.49', true, 'panel'],
      'the consented record follows the superseding desktop');
    ok(pushes(env).some((d) => d.state === 'downloading' && d.version === '0.2.49'), 'the panel row restarts for 0.2.49');
    eq(env.autoUpdater.downloads.length, 2, 'the superseding download started');
  }
  {
    // A transient FEED-CHECK failure during a live panel download must not flip the row to "Retry":
    // the feed check's 'error' lands on the same emitter as download errors.
    const env = load({ engineStatus: null, appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.ipc['update:download-desktop']();
    env.autoUpdater.checkForUpdates = async () => { env.autoUpdater.emit('error', new Error('feed offline')); throw new Error('feed offline'); };
    await env.t.getDesktopUpdateVersion(); await tick();
    eq(pushes(env).filter((d) => d.state === 'error').length, 0, 'a feed-check error does not touch the live download row');
    env.autoUpdater.failDownload(new Error('download broke')); await tick(); await tick();
    ok(pushes(env).some((d) => d.state === 'error' && /download broke/.test(d.error)), 'a real download error still lands');
  }
  {
    // The popup's "works with this desktop" fallback: a pinned release whose floor the RUNNING
    // desktop meets passes the desktop-first hold; an unmet floor is still refused.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', candidateFloor: '0.2.40', upgradeThrows: 'stub stops the flow here' });
    await env.t.getDesktopUpdateVersion(); // a newer desktop is pending → engine changes hold
    const refused = await env.ipc['upgrade-flowpad']();
    eq([refused.desktopUpdatePending, env.uv.upgrades.length], [true, 0], 'a plain upgrade is still held');
    const r = await env.ipc['upgrade-flowpad'](null, { version: '0.2.180' });
    eq(r.desktopUpdatePending, undefined, 'the floor-compatible pin passes the hold');
    eq(env.uv.upgrades.map((u) => u.version), ['0.2.180'], 'and targets exactly the promised release');
  }
  {
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', candidateFloor: '0.3.0' });
    await env.t.getDesktopUpdateVersion();
    const r = await env.ipc['upgrade-flowpad'](null, { version: '0.2.240' });
    eq([r.desktopUpdatePending, env.uv.upgrades.length], [true, 0], 'a pin whose floor the desktop does NOT meet stays held');
  }

  // ── the panel's engine upgrade never strands the user (the "stuck update" incident) ──
  {
    // A failed upgrade (e.g. "no version of flowpad==0.2.238") restores the old engine — the window is
    // never left on the loading splash over a dead backend.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', compatibleRelease: { version: '0.2.238', minDesktopVersion: null }, upgradeThrows: 'there is no version of flowpad==0.2.238' });
    await env.t.getDesktopUpdateVersion(); // desktop current → engine changes allowed
    const r = await env.ipc['upgrade-flowpad']();
    eq([r.success, r.error], [false, 'there is no version of flowpad==0.2.238'], 'the failure reaches the caller (the popover shows it)');
    eq(env.uv.recovered, 1, 'the old engine was restored, not a frozen splash');
    eq(env.uv.upgrades.map((u) => u.version), ['0.2.238'], 'the upgrade targeted the pre-resolved compatible release');
  }
  {
    // Even recovery failing is surfaced: the startup error panel names the cause — WITH a Retry.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', upgradeThrows: 'uv exploded', recoveryFails: true });
    await env.t.getDesktopUpdateVersion();
    const r = await env.ipc['upgrade-flowpad']();
    eq(r.success, false, 'the failure is returned');
    await tick(); await tick(); // the panel comes from the DETACHED retry loop
    ok(env.sent.some(([ch, d]) => ch === 'startup-error' && /uv exploded/.test(d.detail) && d.retryable === true),
      'the error panel names it and offers Retry (Quit-only was a dead end)');
  }
  {
    // ...and the Retry actually re-runs the recovery until it lands.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', upgradeThrows: 'uv exploded', recoveryFails: 1 });
    await env.t.getDesktopUpdateVersion();
    await env.ipc['upgrade-flowpad']();
    await tick(); await tick();
    eq(env.uv.recovered, 1, 'the first recovery failed; the panel is up');
    env.once['retry-startup'](); await tick(); await tick();
    eq(env.uv.recovered, 2, "the panel's Retry re-ran the recovery (and it landed)");
  }
  {
    // Resolution is checked while the backend still RUNS: a definitive refusal returns before the
    // server is stopped or the window leaves the app.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', resolveThrows: 'No compatible FlowPad engine release found for Desktop 0.2.48' });
    await env.t.getDesktopUpdateVersion();
    const r = await env.ipc['upgrade-flowpad']();
    eq([r.success, /No compatible/.test(r.error)], [false, true], "refused with the resolver's own words");
    eq(env.uv.flowStops || 0, 0, 'the backend was not stopped');
    eq(env.uv.upgrades.length, 0, 'nothing was installed');
    eq(env.loadedFiles.length, 0, 'the window never left the app');
    eq(env.uv.recovered || 0, 0, 'and there was nothing to recover');
  }

console.log(`main-update-flow.test.js: ${passed} assertions passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
