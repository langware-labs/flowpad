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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mainflow-'));
process.env.HOME = HOME; // main.js creates ~/.flow/logs at load

/** Load a fresh copy of main.js. `opts`: appVersion, dialogResponses (consumed in order), engineStatus, desktopFeed, engine. */
function load(opts = {}) {
  const userData = fs.mkdtempSync(path.join(HOME, 'userdata-'));
  const intervals = [];
  global.setInterval = (fn, ms) => { const h = { fn, ms, unref() {} }; intervals.push(h); return h; };

  const ipc = {};
  const dialogCalls = [];
  const responses = [...(opts.dialogResponses || [])];
  let releaseDialog = () => {};
  const gate = opts.holdDialog ? new Promise((r) => { releaseDialog = r; }) : null;
  const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 'stub' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk(), set: () => true });
  const BW = function () {}; BW.getAllWindows = () => []; BW.getFocusedWindow = () => null;
  const autoUpdater = Object.assign(new EventEmitter(), {
    downloads: [], quits: [],
    checkForUpdates: async () => {
      if (opts.desktopCheckThrows) throw new Error(opts.desktopCheckThrows);
      return { updateInfo: { version: opts.desktopFeed || opts.appVersion || '0.2.47' } };
    },
    downloadUpdate() { autoUpdater.downloads.push(1); return new Promise((r) => { autoUpdater.finishDownload = r; }); },
    quitAndInstall: (...a) => { autoUpdater.quits.push(a); },
  });
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, setAsDefaultProtocolClient() {}, getPath: () => userData, whenReady: () => new Promise(() => {}),
      on() {}, isPackaged: true, getVersion: () => opts.appVersion || '0.2.47', quit() {}, exit() {}, commandLine: { appendSwitch() {} }, setName() {}, setAppUserModelId() {},
    },
    BrowserWindow: BW,
    dialog: { showMessageBox: async (...a) => { const o = a[a.length - 1]; dialogCalls.push(o); if (gate) await gate; return { response: responses.length ? responses.shift() : 1 }; }, showErrorBox() {} },
    ipcMain: { on() {}, handle(ch, fn) { ipc[ch] = fn; }, once() {} },
    shell: mk(), clipboard: mk(), Menu: mk(), nativeImage: mk(), session: mk(), screen: mk(), Tray: mk(), globalShortcut: mk(), powerMonitor: mk(), protocol: mk(), net: mk(), desktopCapturer: mk(), systemPreferences: mk(), Notification: mk(),
  };
  const logLines = [];
  const log = { info: (l) => logLines.push(String(l)), warn: (l) => logLines.push(String(l)), error: (l) => logLines.push(String(l)), transports: { file: {}, console: {} }, hooks: [] };

  const uv = { calls: [], deferred: [], upgrades: [], checks: 0 };
  class FakeUv {
    constructor() { Object.assign(this, { _isInstalling: false }); uv.instance = this; }
    getInstalledFlowBin() { return opts.installed === false ? null : '/fake/bin/flow'; }
    hadInterruptedInstall() { return false; }
    getInstalledVersionSync() { return opts.engine || '0.2.168'; }
    async _pypiUpdateStatus() { return opts.engineStatus === undefined ? { currentVersion: '0.2.168', latestVersion: '0.2.180', required: true } : opts.engineStatus; }
    deferPackageVersion(v) { uv.deferred.push(v); }
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
    isInstalling() { return false; }
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

  const win = { isDestroyed: () => false, isMinimized: () => false, webContents: { send(ch, d) { win.sent.push([ch, d]); } }, sent: [], loadFile: async () => {}, loadURL() {}, show() {}, hide() {}, focus() {} };
  t.setMainWindow(win);
  t.setUvManager(new FakeUv());
  t.setBackendReady(opts.backendReady !== false); // the app is up unless a test says it is still starting
  return { t, ipc, processHandlers, sent: win.sent, releaseDialog: () => releaseDialog(), autoUpdater, dialogCalls, intervals, uv, logLines, userData, statePath: path.join(userData, 'pending-engine.json'), readState: () => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'pending-engine.json'), 'utf8')); } catch { return null; } } };
}

const REMINDER_MS = 90 * 60 * 1000;
const reminderTimer = (env) => env.intervals.find((i) => i.ms === REMINDER_MS);

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
    const tickFn = env.intervals.find((i) => i.ms === 20 * 60 * 1000);
    ok(tickFn, 'the 20-minute check exists');
    env.autoUpdater.finishDownload && env.autoUpdater.finishDownload();
    await tickFn.fn(); await tick();
    eq(env.dialogCalls.length, 1, 'the periodic check does not show the combined screen a second time');
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

console.log(`main-update-flow.test.js: ${passed} assertions passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
