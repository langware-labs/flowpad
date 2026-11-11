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
  offerDesktopUpdate, offerPostponedRestartPrompt, backendWaitAborted, announceUpdateReady, updateReadyState, activateUpdate, downloadDesktopUpdateInBackground, installAndStartBackend, showStartupErrorPanel, reportStartupCrash, checkPackageUpdateInBackground, waitForBackend,
  setupElectronAutoUpdater, readyReminder, pendingEngineStore, restartApplier, getDesktopUpdateVersion, engineChangeAllowed,
  runScheduledUpdateCheck, startLaunchDesktopCheck, startOffer, prepareDeferredEngineUpdate, offerDesktopFoundAtLaunch, postBootUpdates,
  setLaunchDesktopLook: (p) => { launchDesktopLook = p; },
  setJournal: (j) => { journal = j; },
  getNewestLogFile, restorePreviousEngineAndStart,
  getFoundAtLaunch: () => desktopFoundAtLaunch, getFollowUpDesktop: () => followUpDesktop,
  primeLaunchCheck: () => { launchDesktopCheck = startLaunchDesktopCheck(); },
  fireAccountWatch: (f) => accountWatchEvent && accountWatchEvent(f),
  disarmAccountWatch: () => { accountWatcher = { close() {} }; },
  getDesktopStatus: () => desktopStatus,
  getState: () => ({ pendingDesktopVersion, offeredDesktopVersion, desktopDownloadedVersion, deferredDesktopVersion,
                     packageUpdateInFlight }),
  setMainWindow: (w) => { mainWindow = w; },
  setPackageUpdateInFlight: (v) => { packageUpdateInFlight = v; }, // "a package check runs": the blocker the offer waits behind
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
    ipcMain: { on() {}, handle(ch, fn) { ipc[ch] = fn; }, once() {} },
    shell: mk(), clipboard: mk(), Menu: mk(), nativeImage: mk(), session: mk(), screen: mk(), Tray: mk(), globalShortcut: mk(), powerMonitor: mk(), protocol: mk(), net: mk(), desktopCapturer: mk(), systemPreferences: mk(), Notification: mk(),
  };
  const logLines = [];
  const log = { info: (l) => logLines.push(String(l)), warn: (l) => logLines.push(String(l)), error: (l) => logLines.push(String(l)), transports: { file: {}, console: {} }, hooks: [] };

  const uv = { calls: [], deferred: [], undeferred: [], upgrades: [], checks: 0, checkOpts: [], prepares: [] };
  class FakeUv {
    constructor() { Object.assign(this, { _isInstalling: false }); uv.instance = this; }
    getInstalledFlowBin() { return opts.installed === false ? null : '/fake/bin/flow'; }
    hadInterruptedInstall() { return false; }
    getInstalledVersionSync() { return opts.engine || '0.2.168'; }
    installedPairIssue() { return opts.pairIssue || null; }
    async resolveCompatibleEngineVersion() { if (opts.compatThrows) throw new Error(opts.compatThrows); return opts.compatibleRelease || null; }
    async _assertCandidateCompatible(v) { uv.asserted = (uv.asserted || []).concat(v); if ((opts.incompatible || []).includes(v)) throw new Error(`flowpad ${v} needs a newer desktop`); }
    cancelBackgroundWork(why) { uv.cancelled = (uv.cancelled || []).concat(why); }
    hasUnconfirmedActivation() { return !!opts.activation; }
    async restorePreviousEngine(o) { uv.calls.push(`restore ${o && o.why}`); if (!opts.activation) return false; opts.activation = null; return true; }
    async _pypiUpdateStatus() { if (opts.holdStatus) await opts.holdStatus; return opts.engineStatus === undefined ? { currentVersion: '0.2.168', latestVersion: '0.2.180', required: true } : opts.engineStatus; }
    deferPackageVersion(v) { uv.deferred.push(v); }
    async upgrade(o) { uv.upgrades.push(o); if (opts.upgradeThrows) throw new Error(opts.upgradeThrows); }
    async _recoverRunningBackendAfterFailedUpgrade() { uv.recovered = (uv.recovered || 0) + 1; return !opts.recoverFails; }
    async _flowStop() { uv.flowStops = (uv.flowStops || 0) + 1; }
    async _killPort() {}
    deferredPackageVersion() { return opts.deferredEngine || null; }
    async prepareEngine(o) { uv.prepares.push(o); if (opts.prepareThrows) throw new Error(opts.prepareThrows); return { version: o.version }; }
    preparedEngine() { return uv.prepared || null; }
    async checkForUpdatesInBackground(_w, o) {
      uv.checks++; uv.checkOpts.push(o || {});
      if (opts.holdCheck && uv.checks === 1) await opts.holdCheck;
      if (opts.engineReady && o && o.onReady) { uv.prepared = { version: opts.engineReady }; o.onReady(opts.engineReady); } // prepared and checked
      return false;
    }
    async startWithBin() { if (opts.startThrows) throw new Error(opts.startThrows); }
    isBrokenInstallError(err) { return /flow_sdk/.test(String(err && err.message)); }
    async ensureUv() { uv.ensured = (uv.ensured || 0) + 1; }
    async probeManagedInterpreter() {}
    async installLatest() { uv.installs = (uv.installs || 0) + 1; }
    async reinstall() { uv.reinstalls = (uv.reinstalls || 0) + 1; }
    async start() { uv.started = (uv.started || 0) + 1; uv.calls.push('start'); }
    async stop() { uv.stopped = (uv.stopped || 0) + 1; uv.calls.push('stop'); }
    isInstalling() { return false; }
    setFailureSharer(fn) { this.sharer = fn; }
    backfillEngineOwnership() { uv.ownershipBackfills = (uv.ownershipBackfills || 0) + 1; uv.installsAtBackfill = uv.installs || 0; }
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

  const win = { isDestroyed: () => false, isMinimized: () => false, webContents: { send(ch, d) { win.sent.push([ch, d]); } }, sent: [], shown: [], loadFile: async (f) => { win.shown.push(`file:${require('path').basename(f)}`); }, loadURL(u) { win.shown.push(`url:${u}`); }, show() {}, hide() { win.shown.push('hidden'); }, focus() {} };
  t.setMainWindow(win);
  t.setUvManager(new FakeUv());
  t.setBackendReady(opts.backendReady !== false); // the app is up unless a test says it is still starting
  return { t, ipc, processHandlers, win, sent: win.sent, releaseDialog: () => releaseDialog(), autoUpdater, dialogCalls, intervals, uv, logLines, userData, statePath: path.join(userData, 'pending-engine.json'), readState: () => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'pending-engine.json'), 'utf8')); } catch { return null; } }, schedulePath: path.join(userData, 'update-schedule.json'), readSchedule: () => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'update-schedule.json'), 'utf8')); } catch { return null; } }, writeSchedule: (s) => fs.writeFileSync(path.join(userData, 'update-schedule.json'), JSON.stringify(s)) };
}

const REMINDER_MS = 90 * 60 * 1000;
/** What main sent the UI: each "Update Ready" toast, and each push of the ready state (the indicator). */
const toasts = (env) => env.sent.filter(([ch]) => ch === 'update-ready-toast').map(([, d]) => d);
/** The desktop offers made (each starts a background download), optionally for one version. */
const offers = (env, v = '') => env.logLines.filter((l) => new RegExp(`\\[update\\] desktop ${v.replace(/\./g, '\\.')}\\S* .*offered: downloading`).test(l));
const readyStates = (env) => env.sent.filter(([ch]) => ch === 'update-ready-state').map(([, d]) => d);
const reminderTimer = (env) => env.intervals.find((i) => i.ms === REMINDER_MS);
const schedule = require('./update-schedule');
const schedulerTick = (env) => env.intervals.find((i) => i.ms === schedule.SCHEDULER_TICK_MS);
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

(async () => {
  // ── desktop + engine: downloaded in the background, then ONE "Update Ready" toast for the set ──
  {
    const env = load();
    env.t.setupElectronAutoUpdater();
    eq(await env.t.offerDesktopUpdate('0.2.48'), 'both', 'desktop + engine → one offer');
    eq(env.dialogCalls.length, 0, 'nothing is asked before it is ready');
    eq(env.readState(), Object.assign({}, env.readState(), { engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: false }), 'the engine version that rides it is SAVED, not yet agreed');
    eq(env.uv.upgrades.length, 0, 'the OLD desktop does NOT touch the engine');
    eq(env.uv.deferred, ['0.2.180'], 'no separate engine offer for that version');
    eq(env.autoUpdater.downloads.length, 1, 'the desktop download started without a question');
    eq(env.uv.prepares, [{ version: '0.2.180', desktopVersion: '0.2.48' }], 'with it, the engine is prepared for the NEW desktop');
    eq(toasts(env).length, 0, 'nothing is shown while it downloads');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    eq(toasts(env), [{ ready: true, restart: true, desktop: { from: '0.2.47', to: '0.2.48' }, engine: { from: '0.2.168', to: '0.2.180' } }], 'downloaded: ONE "Update Ready" toast, for desktop + the engine that follows it');
    eq(env.dialogCalls.length, 0, 'and no dialog');
    eq(readyStates(env).at(-1).ready, true, 'the top bar indicator is told');
    ok(reminderTimer(env), 'the 90-minute reminder runs while it is pending');
    {
      // A newer build starts downloading over it: electron-updater deletes the 0.2.48 installer — not offered anymore.
      const env2 = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
      env2.t.setupElectronAutoUpdater();
      env2.t.downloadDesktopUpdateInBackground({ version: '0.2.48' });
      env2.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); env2.autoUpdater.finishDownload(); await tick(); await tick();
      eq(env2.t.updateReadyState().desktop, { from: '0.2.47', to: '0.2.48' }, 'downloaded: ready');
      env2.t.downloadDesktopUpdateInBackground({ version: '0.2.49' });
      eq([env2.t.updateReadyState().ready, readyStates(env2).at(-1).ready], [false, false], 'a newer download starts: the old one is no longer ready, and the indicator is told');
      eq(await env2.ipc['update-activate'](), { started: false, reason: 'not-ready' }, 'so Restart cannot try to apply a deleted installer');
    }
    const [first, second] = await Promise.all([env.t.activateUpdate('test'), env.t.activateUpdate('test')]);
    eq([first.started, second], [true, { started: false, reason: 'busy' }], '"Restart" applies it once — a second click is refused');
    eq(env.readState().consented, true, '"Restart" = agreement to install the saved engine version');
    eq(env.autoUpdater.quits, [[true, true]], 'quitAndInstall(silent, relaunch)');
    eq(env.uv.stopped, 1, 'the backend was stopped first');
    ok(!env.win.shown.includes('hidden') && env.win.shown.includes('file:loading.html'), 'the window stays up, on the loading screen');
    ok(env.win.sent.some(([ch, d]) => ch === 'startup-status' && /Installing the update/.test(d)), 'and says the update is installing');
    // The installer did not start after all: the app comes back (its backend was stopped for the install).
    env.autoUpdater.emit('error', new Error('no installer')); await tick(); await tick();
    eq(env.uv.recovered, 1, 'a failed install starts the backend again and reloads the app');
  }

  // ── download finishes while FlowPad is still starting: no toast until the app is up ──
  {
    const env = load({ backendReady: false });
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    eq(toasts(env).length, 0, 'still starting: "Update Ready" is held back');
    env.t.setBackendReady(true); env.t.offerPostponedRestartPrompt(); await tick();
    eq(toasts(env).length, 1, 'once the app is up it is shown');
    eq(env.autoUpdater.quits, [], 'and nothing restarts until the user asks');
  }

  // ── a restart-to-update stops the backend mid-wait: that is not a startup failure (no error screen) ──
  {
    const env = load();
    eq(env.t.backendWaitAborted({ ready: false, reason: 'launcher-failed' }), false, 'a real launcher failure still reaches the error panel');
    env.t.setQuitting(true);
    eq(env.t.backendWaitAborted({ ready: false, reason: 'launcher-failed' }), true, 'while quitting for an update, launcher-failed is swallowed');
    eq(env.t.backendWaitAborted({ ready: false, reason: 'quitting' }), true, 'and so is the explicit quitting reason');
  }

  // ── Later / X / the 30 s timeout: the update stays ready, and is offered again every 90 minutes ──
  {
    const env = load();
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    eq(toasts(env).length, 1, 'shown once when it is ready');
    env.t.announceUpdateReady(); await tick();
    eq(toasts(env).length, 1, 'a later check finding the same ready set does not toast again');
    reminderTimer(env).fn(); await tick();
    eq(toasts(env).length, 2, '90 minutes later, still pending: shown again');
    eq([env.readState().consented, env.autoUpdater.quits.length], [false, 0], 'dismissing it agrees to nothing and restarts nothing');
    reminderTimer(env).fn(); await tick();
    eq(toasts(env).length, 3, 'and again 90 minutes after that');
    eq(env.dialogCalls.length, 0, 'never a dialog');
  }

  // ── an adopted update (offered before a restart): no toast when it lands, the reminder offers it ──
  {
    const env = load({ desktopFeed: '0.2.48' });
    env.writeSchedule({ lastOfferedDesktopVersion: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    await env.t.runScheduledUpdateCheck({ bypassSchedule: true }); await tick();
    eq(env.autoUpdater.downloads.length, 1, 'offered before: downloaded without a word');
    reminderTimer(env).fn(); await tick();
    eq(toasts(env).length, 0, 'a reminder due while it downloads shows nothing yet');
    env.autoUpdater.finishDownload();
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    eq(toasts(env).length, 1, 'shown the moment the download finishes');
  }

  // ── engine dialogs are held back while a desktop update is pending ───────
  {
    const env = load({ dialogResponses: [1] });
    await env.t.offerDesktopUpdate('0.2.48');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'no separate engine dialog while the desktop update is pending');
    ok(env.logLines.some((l) => /engine change hold \(periodic package check\): desktop 0\.2\.48 is pending/.test(l)), 'and it says why');
  }

  // ── "Later" to the engine at launch: it is prepared once the app is up (not while a desktop is pending) ──
  {
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', deferredEngine: '0.2.180' });
    await env.t.getDesktopUpdateVersion();
    env.t.prepareDeferredEngineUpdate(); await tick();
    eq(env.uv.prepares, [undefined], 'a postponed engine update is prepared (the newest compatible release)');
    const none = load({ appVersion: '0.2.47', desktopFeed: '0.2.47' });
    await none.t.getDesktopUpdateVersion();
    none.t.prepareDeferredEngineUpdate(); await tick();
    eq(none.uv.prepares, [], 'nothing postponed → nothing prepared');
    const held = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', deferredEngine: '0.2.180' });
    await held.t.getDesktopUpdateVersion();
    held.t.prepareDeferredEngineUpdate(); await tick();
    eq(held.uv.prepares, [], 'a newer desktop is pending → its own engine is prepared with its download, not this one');
    const failing = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', deferredEngine: '0.2.180', prepareThrows: 'offline' });
    await failing.t.getDesktopUpdateVersion();
    failing.t.prepareDeferredEngineUpdate(); await tick(); await tick();
    ok(failing.logLines.some((l) => /postponed engine update was not prepared/.test(l)), 'a failed prepare is only logged');
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
    // The desktop check FAILED: "could not tell" is not "up to date" — but with no newer desktop KNOWN, the feed's
    // outage does not hold the engine: after one more look, the engine check runs (its own compatibility checks).
    const env = load({ desktopCheckThrows: 'HTTP 500' });
    await env.t.getDesktopUpdateVersion();
    eq(env.t.getDesktopStatus().state, 'unknown', 'status: unknown after a failed check');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 1, 'unknown, no newer desktop known → the compatibility-checked engine check runs (fallback)');
    // ...but a newer desktop found BEFORE the outage keeps desktop-first, from the answer kept on disk.
    const known = load({ desktopCheckThrows: 'HTTP 500' });
    known.writeSchedule({ lastResult: { state: 'available', version: '0.2.48' }, lastSuccessAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(), failureCount: 1 });
    await known.t.getDesktopUpdateVersion();
    await known.t.checkPackageUpdateInBackground();
    eq(known.uv.checks, 0, 'unknown, desktop 0.2.48 known from before → the engine is held');
    ok(env.logLines.some((l) => /engine change hold .*status is unknown \(update check failed: HTTP 500\)/.test(l)), 'and the log names the cause');
  }
  {
    // Before any check has answered the status is unknown too (a check that timed out leaves it so).
    const env = load();
    eq(env.t.getDesktopStatus().state, 'unknown', 'initial status: unknown');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'an unanswered check holds the engine');
  }
  {
    // "Restart" failed: the new desktop is downloaded but NOT installed and running, so the engine stays held —
    // the periodic check, the pre-start prompt's gate and the UI's upgrade IPC all keep refusing.
    const env = load({ engineStatus: null });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    await env.t.offerDesktopUpdate('0.2.48');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'held while the desktop is pending');
    await env.t.restartApplier.apply();
    env.t.restartApplier.failed(new Error('could not restart'));
    eq(env.t.engineChangeAllowed('test'), 'hold', 'still held after "Restart" failed: the new desktop is not running');
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
    // The desktop update is FULLY DOWNLOADED (update-downloaded emitted) and "Update Ready" was dismissed:
    // it installs on the next quit, but until the new desktop is installed and running the engine stays held.
    const env = load({ engineStatus: null });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    await env.t.offerDesktopUpdate('0.2.48');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq(env.t.getState().desktopDownloadedVersion, '0.2.48', 'the update is fully downloaded');
    eq(toasts(env).length, 1, '"Update Ready" was shown (and left unanswered)');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'downloaded + Later: the engine stays held');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'downloaded + Later: no engine check');
    const r = await env.ipc['upgrade-flowpad']();
    ok(r.success === false && r.desktopUpdatePending === true, 'downloaded + Later: the UI upgrade is refused');
  }
  {
    // Same with an engine riding the desktop: once the download is complete the engine is still held (it is
    // installed by the new desktop after the restart, nothing earlier).
    const env = load();
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    eq(await env.t.offerDesktopUpdate('0.2.48'), 'both', 'desktop + engine → one offer');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq(env.t.getState().desktopDownloadedVersion, '0.2.48', 'desktop + engine: the update is fully downloaded');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'desktop + engine, downloaded and not applied: the engine stays held');
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'desktop + engine, downloaded and not applied: no engine check');
    eq(env.uv.upgrades.length, 0, 'desktop + engine, downloaded and not applied: the engine was not touched');
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
    eq(env.uv.ownershipBackfills, 1, 'the engine ownership backfill runs once per launch');
    eq(env.uv.installsAtBackfill, 0, '…before the first install, which would otherwise record an existing engine as adopted');
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
    eq(env.autoUpdater.downloads.length, 1, 'the download starts without a question');
    eq(env.readState(), null, 'nothing saved for the engine');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    eq(toasts(env), [{ ready: true, restart: true, desktop: { from: '0.2.47', to: '0.2.48' }, engine: null }], '"Update Ready" for the desktop alone');
  }

  // ── a release offered once is not offered again by the periodic check ────
  {
    const env = load();
    env.t.setupElectronAutoUpdater();
    await env.t.offerDesktopUpdate('0.2.48');
    ok(schedulerTick(env), 'the scheduler tick exists');
    env.autoUpdater.finishDownload && env.autoUpdater.finishDownload();
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.downloads.length, 1, 'the periodic check does not offer (or download) it a second time');
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
    // 20 minutes later the desktop feed is looked at again — only the desktop: the engine keeps its day.
    env.writeSchedule({ ...env.readSchedule(), lastAttemptAt: agoIso(20 * 60000 + 60000) });
    await schedulerTick(env).fn(); await tick();
    eq([env.autoUpdater.checks, env.uv.checks], [2, 1], 'every 20 minutes: the desktop feed is checked, the engine is not');
    ok(env.readSchedule().lastDesktopCheckAt && env.readSchedule().lastSuccessAt === env.readSchedule().lastSuccessAt, 'the desktop-only check is paced on its own field');
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.checks, 2, 'and not again for another 20 minutes');
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
    eq(regular.autoUpdater.checks, 1, 'regular account, same state: the desktop feed is checked anyway (every 20 minutes, every account)');
    eq(regular.uv.checks, 0, 'but the engine keeps the daily cadence');
    // An account switch re-reads the email on the next pass: the overdue check fires at once.
    writeAccountEmail('dev@langware.ai');
    await regular.t.runScheduledUpdateCheck(); await tick();
    eq([regular.autoUpdater.checks, regular.uv.checks], [2, 1], 'switching to an internal account makes the stale (two-channel) check due');
  }
  {
    // An engine update waits (the user said Later): the 20-minute pass looks for a newer one and quietly swaps it in.
    const recent = { lastSuccessAt: agoIso(25 * 60 * 1000), lastAttemptAt: agoIso(25 * 60 * 1000), lastResult: { state: 'current', version: null }, failureCount: 0 };
    const idle = load({ accountEmail: 'user@example.com', engineReady: '0.2.181' });
    idle.writeSchedule(recent);
    idle.t.setupElectronAutoUpdater();
    await schedulerTick(idle).fn(); await tick();
    eq(idle.uv.checks, 0, 'nothing waiting: the 20-minute pass leaves the engine to its daily cadence');
    const env = load({ accountEmail: 'user@example.com', engineReady: '0.2.181' });
    env.writeSchedule(recent);
    env.uv.prepared = { version: '0.2.180' };
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.uv.checks, 1, '0.2.180 waits: the 20-minute pass looks for a newer engine');
    eq([toasts(env).length, readyStates(env).at(-1).engine.to], [0, '0.2.181'], '0.2.181 replaces it quietly: no toast, the indicator and popover name the new one');
    eq(env.readSchedule().engineLastAttemptAt, undefined, 'and the engine cadence is not touched');
  }
  {
    // The desktop feed fails for hours (ERR_NETWORK_CHANGED): its backoff retries the feed, and the engine keeps its
    // own interval anyway — before, it was never checked while the feed failed.
    const failing = { lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(5 * 60 * 1000), lastResult: { state: 'current', version: null }, failureCount: 13 };
    const env = load({ accountEmail: 'user@example.com' });
    env.writeSchedule(failing);
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(env.uv.checks, 1, 'feed in backoff, a day since the last answer: the engine is checked on its own clock');
    ok(env.readSchedule().engineLastCheckAt, 'and stamped');
    await schedulerTick(env).fn(); await tick();
    eq(env.uv.checks, 1, 'the next tick does not check it again: its interval starts over');
  }
  {
    // RESTART: the persisted answer is reused — no check, and the engine is NOT held by it.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const first = load({ userDataDir });
    eq(await first.t.startLaunchDesktopCheck(), null, 'first launch: the real check runs (nothing newer)');
    eq(first.autoUpdater.checks, 1, 'first launch: it hit the feed');
    const second = load({ userDataDir });
    const anchor = second.readSchedule().lastSuccessAt;
    eq(await second.t.startLaunchDesktopCheck(), null, 'relaunch inside the interval: nothing newer');
    await tick(); await tick();
    eq(second.autoUpdater.checks, 1, 'every launch looks at the desktop feed (in the background)');
    eq(second.readSchedule().lastSuccessAt, anchor, 'without resetting the shared interval');
    eq(second.t.getDesktopStatus().state, 'current', 'the status is the fresh answer');
    await second.t.checkPackageUpdateInBackground();
    eq(second.uv.checks, 1, 'so the engine check is not held by the skipped check');
  }
  {
    // A launch inside the interval never waits for the feed: the start goes on from the persisted answer at
    // once, and a newer desktop the background look finds goes down the periodic look's road (the offer).
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const first = load({ userDataDir });
    await first.t.startLaunchDesktopCheck();
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.t.setupElectronAutoUpdater();
    let release;
    env.autoUpdater.checkForUpdates = () => { env.autoUpdater.checks++; return new Promise((r) => { release = () => r({ updateInfo: { version: '0.2.48' } }); }); };
    eq(await env.t.startLaunchDesktopCheck(), null, 'the launch is not held by the feed');
    eq(env.t.getDesktopStatus().state, 'current', 'it starts from the persisted answer');
    release(); for (let i = 0; i < 8; i++) await tick();
    eq(env.t.getDesktopStatus().state, 'available', 'the background look found the newer desktop');
    eq(offers(env, '0.2.48').length, 1, 'and offered it (its download started), like the periodic look');
    eq(env.readSchedule().lastResult, { state: 'available', version: '0.2.48' }, 'its answer is kept for a follow-up and the next launch');
  }
  {
    // Found by the launch's background look BEFORE the app is up: nothing mid-start — it is offered by the
    // post-boot hook (which calls offerDesktopFoundAtLaunch with what was kept).
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    await load({ userDataDir }).t.startLaunchDesktopCheck();
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48', backendReady: false });
    env.t.setupElectronAutoUpdater();
    await env.t.startLaunchDesktopCheck(); for (let i = 0; i < 8; i++) await tick();
    eq(offers(env).length, 0, 'still starting: no offer in the middle of the start');
    eq(env.t.getFoundAtLaunch(), '0.2.48', 'the version is kept for the post-boot hook');
    eq(env.t.getDesktopStatus().state, 'available', 'and the engine is held behind it meanwhile');
    env.t.setBackendReady(true);
    await env.t.offerDesktopFoundAtLaunch(env.t.getFoundAtLaunch()); for (let i = 0; i < 6; i++) await tick();
    eq(offers(env, '0.2.48').length, 1, 'up: the post-boot hook offers it');
    eq(env.t.getFoundAtLaunch(), null, 'and it is spent');
  }
  {
    // Not due, a newer desktop AND a newer engine: no engine question in the start (it would come before the
    // desktop feed answers); once up, ONE offer carries both — the desktop goes first, the engine follows it.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    await load({ userDataDir }).t.startLaunchDesktopCheck();
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48', backendReady: false });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck();
    const r = await env.t.installAndStartBackend(); for (let i = 0; i < 8; i++) await tick();
    eq(r.ok, true, 'the start goes on');
    eq([env.uv.checks, offers(env).length, env.dialogCalls.length], [0, 0, 0], 'no engine check, no offer and no dialog during the start');
    ok(env.logLines.some((l) => /engine is offered once FlowPad is up/.test(l)), 'it says why');
    env.t.setBackendReady(true);
    await env.t.postBootUpdates(); for (let i = 0; i < 6; i++) await tick();
    eq(offers(env, '0.2.48').length, 1, 'up: one offer for the desktop');
    ok(/engine 0\.2\.180/.test(offers(env, '0.2.48')[0]), 'with the engine riding it');
    eq(env.uv.checks, 0, 'and no separate engine check');
  }
  {
    // Not due, the feed says current: once up, the engine is offered — with the pre-start's PyPI comparison.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    await load({ userDataDir }).t.startLaunchDesktopCheck();
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.47', backendReady: false });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck();
    await env.t.installAndStartBackend();
    eq(env.uv.checks, 0, 'nothing asked during the start');
    env.t.setBackendReady(true);
    await env.t.postBootUpdates();
    eq(env.uv.checkOpts.map((o) => [o.beforeBackendStart || false, o.compareWithPypi]), [[false, true]], 'up: the engine check, comparing with PyPI');
  }
  {
    // Not due, the feed never answers (bounded): the engine check still comes, after the bound.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47' });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion(); // the persisted answer the launch seeds: current
    env.t.setLaunchDesktopLook(Promise.resolve(null)); // what the bounded look resolves to when it gives up
    await env.t.postBootUpdates();
    eq(env.uv.checks, 1, 'the engine check goes on');
    ok(env.logLines.some((l) => /did not answer in time/.test(l)), 'and says the feed did not answer');
  }
  {
    // Not due, the feed answers only after the app is up — while the post-boot step waits for it: one offer,
    // from the look itself; the engine is held behind it, never a second offer.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    await load({ userDataDir }).t.startLaunchDesktopCheck();
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.48', dialogResponses: [1] });
    env.t.setupElectronAutoUpdater();
    let release;
    env.autoUpdater.checkForUpdates = () => { env.autoUpdater.checks++; return new Promise((r) => { release = () => r({ updateInfo: { version: '0.2.48' } }); }); };
    env.t.primeLaunchCheck();
    const post = env.t.postBootUpdates(); await tick();
    eq(offers(env).length, 0, 'waiting for the feed: nothing offered yet');
    release(); await post; for (let i = 0; i < 8; i++) await tick();
    eq(offers(env, '0.2.48').length, 1, 'one offer');
    eq(env.uv.checks, 0, 'the engine waits for the desktop');
  }
  {
    // After a FAILED start the engine question is asked pre-start again — an engine that does not boot never
    // reaches postBootUpdates, and a fix on PyPI is its way out: the panel's Retry in this session...
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    await load({ userDataDir }).t.startLaunchDesktopCheck();
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.47', backendReady: false });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck(); for (let i = 0; i < 4; i++) await tick();
    await env.t.installAndStartBackend();
    eq(env.uv.checks, 0, 'a start after a healthy one: asked once FlowPad is up');
    void env.t.showStartupErrorPanel('the backend did not start', { retryable: true }); await tick();
    await env.t.installAndStartBackend();
    eq(env.uv.checkOpts.map((o) => o.beforeBackendStart), [true], 'Retry after a failed start: asked pre-start, as before');
    // ...and the next launch, when the previous run never got FlowPad up.
    for (const [history, expect, why] of [
      [['electron-initialized', 'backend-start', 'startup-failed', 'clean-exit'], 1, 'the previous run never got up: asked pre-start'],
      [['electron-initialized', 'backend-start', 'backend-healthy', 'clean-exit'], 0, 'the previous run got up: asked once up'],
    ]) {
      const next = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.47', backendReady: false });
      next.t.setupElectronAutoUpdater();
      next.t.setJournal({ previous: () => ({ phase: 'clean-exit', history: history.map((phase) => ({ phase })) }), mark() {}, phase: () => null });
      next.t.primeLaunchCheck(); for (let i = 0; i < 4; i++) await tick();
      await next.t.installAndStartBackend();
      eq(next.uv.checks, expect, why);
    }
  }
  {
    // "Restart now" failed and the app could not be brought back: the error panel — never "restoring" forever.
    for (const [recoverFails, panel, why] of [[true, true, 'not brought back: the error panel'], [false, false, 'brought back: no panel']]) {
      const env = load({ recoverFails });
      env.t.setBackendReady(true);
      await env.t.restartApplier.apply();
      env.t.restartApplier.failed(new Error('could not restart'));
      for (let i = 0; i < 8; i++) await tick();
      eq(env.sent.some(([ch]) => ch === 'startup-error'), panel, why);
    }
  }
  {
    // The popover's "Upgrade to vX" installs exactly X (a prepared older release is not used instead);
    // anything that is not a version string is ignored (the newest compatible).
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47' });
    await env.t.getDesktopUpdateVersion();
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    try {
      await env.ipc['upgrade-flowpad']({}, '0.2.181');
      await env.ipc['upgrade-flowpad']({}, '0.2.181; rm -rf ~');
    } finally { global.fetch = realFetch; }
    eq(env.uv.upgrades.map((o) => o.version), ['0.2.181', null], 'the named release exactly; a non-version is ignored');
  }
  {
    // The desktop check failed (GitHub 504): no newer desktop is known, only no answer. "Upgrade" looks at the feed
    // again — seen on a 0.2.59 desktop, the newest, refused with "a newer desktop must be installed first". When the
    // feed still does not answer, the click goes on against THIS desktop's compatibility contract (the fallback).
    const env = load({ appVersion: '0.2.59', desktopFeed: '0.2.59' });
    let failing = true;
    const answer = env.autoUpdater.checkForUpdates;
    env.autoUpdater.checkForUpdates = async () => { if (failing) { env.autoUpdater.checks++; throw new Error('HttpError: 504 Gateway Time-out'); } return answer(); };
    await env.t.getDesktopUpdateVersion();
    eq(env.t.getDesktopStatus().state, 'unknown', 'a failed check leaves the status unknown');
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    try {
      const checksBefore = env.autoUpdater.checks;
      const r = await env.ipc['upgrade-flowpad']({}, '0.2.181');
      eq(env.autoUpdater.checks, checksBefore + 1, 'the click looks at the feed again first');
      eq(r.desktopUpdatePending, undefined, 'still no answer, no newer desktop known: not refused');
      eq(env.uv.asserted, ['0.2.181'], 'the release is checked against this desktop (fail closed) before anything is touched');
      eq(env.uv.upgrades.map((o) => o.version), ['0.2.181'], 'and installed');
      // the fallback never skips the compatibility check: a release this desktop cannot run is still refused
      const bad = load({ appVersion: '0.2.59', desktopFeed: '0.2.59', desktopCheckThrows: 'HttpError: 504', incompatible: ['0.2.190'] });
      await bad.t.getDesktopUpdateVersion();
      const refused = await bad.ipc['upgrade-flowpad']({}, '0.2.190');
      eq([refused.success, /newer desktop/.test(refused.error), bad.uv.flowStops || 0, bad.uv.upgrades.length], [false, true, 0, 0],
        'fallback + an incompatible candidate: refused before the server is touched');
    } finally { global.fetch = realFetch; }
  }
  {
    // The automatic engine paths: a hold that rests only on a failed desktop check looks at the feed again, and when the
    // feed still does not answer and no newer desktop is known, the (compatibility-checked) engine check runs anyway.
    const failingThenOk = (env) => {
      const answer = env.autoUpdater.checkForUpdates;
      env.failing = true;
      env.autoUpdater.checkForUpdates = async () => { if (env.failing) { env.autoUpdater.checks++; throw new Error('net::ERR_NETWORK_CHANGED'); } return answer(); };
    };
    // post-boot / periodic engine check: the feed answers now → the engine check runs
    const up = load({ appVersion: '0.2.59', desktopFeed: '0.2.59' });
    failingThenOk(up);
    await up.t.getDesktopUpdateVersion();
    up.failing = false;
    const before = up.autoUpdater.checks;
    eq(await up.t.checkPackageUpdateInBackground({ label: 'post-boot' }), 'ran', 'post-boot: the feed answers current now — the engine check runs');
    eq([up.autoUpdater.checks - before, up.uv.checks], [1, 1], 'after one more look at the feed');
    // still failing, nothing newer known → the engine check runs, after exactly one more look
    const down = load({ appVersion: '0.2.59', desktopFeed: '0.2.59' });
    failingThenOk(down);
    await down.t.getDesktopUpdateVersion();
    const b2 = down.autoUpdater.checks;
    eq(await down.t.checkPackageUpdateInBackground({ label: 'post-boot' }), 'ran', 'still no answer, nothing newer known: the fallback runs the engine check');
    eq([down.autoUpdater.checks - b2, down.uv.checks], [1, 1], 'one more look, then the engine check');
    // a scheduled pass that has just looked at the feed (and failed) does not look twice — and falls back the same way
    const pass = load({ appVersion: '0.2.59', desktopFeed: '0.2.59' });
    pass.t.setupElectronAutoUpdater();
    failingThenOk(pass);
    const b3 = pass.autoUpdater.checks;
    await pass.t.runScheduledUpdateCheck({ bypassSchedule: true });
    eq([pass.autoUpdater.checks - b3, pass.uv.checks], [1, 1], 'scheduled pass: one look at the feed, none for the engine half, which falls back');
    // the postponed prepare ("Later" at launch) looks again too
    const later = load({ appVersion: '0.2.59', desktopFeed: '0.2.59', deferredEngine: '0.2.180' });
    failingThenOk(later);
    await later.t.getDesktopUpdateVersion();
    later.failing = false;
    await later.t.prepareDeferredEngineUpdate();
    eq(later.uv.prepares.length, 1, 'the postponed update is prepared once the feed answers');
  }
  {
    // Failed activation at launch / from the popover: the engine just installed did not come up — stop it, put back
    // the one it replaced, start THAT and wait for it. Nothing to put back → null (the caller's failure path runs).
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    try {
      const env = load({ activation: true });
      const w = await env.t.restorePreviousEngineAndStart('timeout');
      eq([w && w.ready, env.uv.calls], [true, ['stop', 'restore did not start (timeout)', 'start']], 'stopped, restored, started, healthy');
      const none = load({ activation: false });
      eq([await none.t.restorePreviousEngineAndStart('timeout'), none.uv.calls.includes('start')], [null, false], 'nothing to put back: null, nothing started');
    } finally { global.fetch = realFetch; }
  }
  {
    // Preserve the last known desktop: a newer desktop found before the feed failed keeps desktop-first.
    // 1. in memory: a failed check does not overwrite it
    const mem = load({ appVersion: '0.2.59', desktopFeed: '0.2.60' });
    await mem.t.getDesktopUpdateVersion();
    mem.autoUpdater.checkForUpdates = async () => { mem.autoUpdater.checks++; throw new Error('HttpError: 504'); };
    await mem.t.getDesktopUpdateVersion();
    eq([mem.t.getDesktopStatus().state, mem.t.getDesktopStatus().version], ['available', '0.2.60'], 'a failed check keeps the known desktop 0.2.60');
    eq(mem.readSchedule().lastResult, { state: 'available', version: '0.2.60' }, 'and so does the file (recordFailure keeps lastResult)');
    eq(await mem.t.checkPackageUpdateInBackground({ label: 'post-boot' }), 'held', 'the engine waits for it');
    const r = await mem.ipc['upgrade-flowpad']({}, '0.2.181');
    eq([r.desktopUpdatePending, mem.uv.upgrades.length], [true, 0], 'and the click names it: a newer desktop first');
    // 2. from disk only (a new session, the feed down from the start)
    const disk = load({ appVersion: '0.2.59', desktopCheckThrows: 'HttpError: 504' });
    disk.writeSchedule({ lastResult: { state: 'available', version: '0.2.60' }, failureCount: 2 });
    await disk.t.getDesktopUpdateVersion();
    eq(disk.t.getDesktopStatus().state, 'unknown', 'this session never got an answer');
    eq(await disk.t.checkPackageUpdateInBackground({ label: 'post-boot' }), 'held', 'the known desktop on disk still holds the engine');
    // 3. a STALE known desktop (already installed) holds nothing
    const stale = load({ appVersion: '0.2.60', desktopCheckThrows: 'HttpError: 504' });
    stale.writeSchedule({ lastResult: { state: 'available', version: '0.2.60' }, failureCount: 2 });
    await stale.t.getDesktopUpdateVersion();
    eq(await stale.t.checkPackageUpdateInBackground({ label: 'post-boot' }), 'ran', 'the kept "0.2.60 available" is this desktop: no hold, the fallback runs');
  }
  {
    // A newer desktop IS known: refused as before, without asking the feed again.
    const env = load({ appVersion: '0.2.59', desktopFeed: '0.2.60' });
    await env.t.getDesktopUpdateVersion();
    const checksBefore = env.autoUpdater.checks;
    const r = await env.ipc['upgrade-flowpad']({}, '0.2.181');
    eq([r.success, r.desktopUpdatePending, /newer FlowPad desktop must be installed first/.test(r.error)], [false, true, true], 'a newer desktop: that message');
    eq(env.autoUpdater.checks, checksBefore, 'no extra look at the feed');
  }
  {
    // A named release this desktop cannot run is refused BEFORE the server is touched: the app stays as it was.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', incompatible: ['0.2.190'] });
    await env.t.getDesktopUpdateVersion();
    const r = await env.ipc['upgrade-flowpad']({}, '0.2.190');
    eq([r.success, /newer desktop/.test(r.error)], [false, true], 'refused, with why');
    eq([env.uv.flowStops || 0, env.uv.upgrades.length], [0, 0], 'the server was not stopped and nothing was installed');
    eq(env.win.shown.includes('file:loading.html'), false, 'and the app was never replaced by the loading screen');
  }
  {
    // The upgrade fails after the server was stopped: the running version is brought back — and when even that
    // fails, the error panel, never the loading screen with no backend.
    for (const [recoverFails, panel, why] of [[false, false, 'brought back: no panel'], [true, true, 'not brought back: the error panel']]) {
      const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', upgradeThrows: 'uv tool install failed', recoverFails });
      await env.t.getDesktopUpdateVersion();
      const r = await env.ipc['upgrade-flowpad']({}, '0.2.181');
      for (let i = 0; i < 6; i++) await tick();
      eq(r.success, false, `${why}: the result says it failed`);
      eq(env.uv.recovered, 1, `${why}: the running version was restarted`);
      eq(env.sent.some(([ch]) => ch === 'startup-error'), panel, why);
    }
  }
  {
    // What the popover offers on the desktop: the newest release THIS desktop runs, not PyPI's newest.
    const ask = async (o) => load({ appVersion: '0.2.47', engine: '0.2.168', ...o }).ipc['engine-upgrade-target']();
    eq(await ask({ compatibleRelease: { version: '0.2.181' } }), '0.2.181', 'a newer compatible release: offered');
    eq(await ask({ compatibleRelease: { version: '0.2.168' } }), false, 'the installed one is the newest this desktop runs: nothing offered');
    eq(await ask({ compatThrows: 'no flowpad release on PyPI is compatible with desktop 0.2.47' }), false, 'nothing compatible: nothing offered');
    eq(await ask({ compatibleRelease: null }), null, 'undecided (PyPI silent): the popover falls back, and the click is checked');
  }

  // ── the version popover's desktop button: the updater's own download, "Update Ready" and restart ──
  {
    const env = load({ desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    const pushed = () => env.sent.filter(([ch]) => ch === 'desktop-update-state').map(([, d]) => d);
    eq(await env.ipc['desktop-update-info'](), { supported: true, version: null, state: 'idle', percent: null, error: null, busy: false }, 'nothing checked yet: nothing to offer');
    eq(await env.ipc['desktop-update-install'](), { started: false, reason: 'not-downloaded' }, 'nothing downloaded: nothing to install');
    eq(await env.ipc['desktop-update-download'](), { started: true, version: '0.2.48' }, '"Update desktop": the feed is asked and the download starts');
    eq([env.autoUpdater.checks, env.autoUpdater.downloads.length], [1, 1], 'one look at the feed, one download');
    eq(await env.ipc['desktop-update-download'](), { started: true, version: '0.2.48' }, 'a second click joins the running download');
    eq(env.autoUpdater.downloads.length, 1, 'and does not start another');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'desktop first: the engine waits for it');
    env.autoUpdater.emit('download-progress', { percent: 44.6, transferred: 1, total: 2 });
    eq([pushed().at(-1).state, pushed().at(-1).percent], ['downloading', 45], 'its progress is pushed to the popover');
    env.autoUpdater.finishDownload();
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick(); await tick();
    eq([toasts(env).length, env.dialogCalls.length], [1, 0], 'when it lands, the usual "Update Ready" toast — no dialog');
    eq(pushed().at(-1).state, 'ready', 'the popover is told it is ready');
    eq(env.autoUpdater.quits, [], 'left unanswered: nothing restarts');
    eq(env.readSchedule().lastOfferedDesktopVersion, '0.2.48', 'the version counts as offered (no second announcement)');
    eq(await env.ipc['desktop-update-install'](), { started: true }, 'the postponed update: "Restart to update" installs it now');
    eq(env.autoUpdater.quits, [[true, true]], 'quitAndInstall(silent, relaunch), the backend stopped first');
    eq(env.uv.stopped, 1, 'the backend was stopped first');
  }
  {
    const current = load({ desktopFeed: '0.2.47' });
    eq(await current.ipc['desktop-update-download'](), { started: false, reason: 'no-update' }, 'the newest desktop already: said so');
    const offline = load({ desktopCheckThrows: 'net::ERR_INTERNET_DISCONNECTED' });
    eq(await offline.ipc['desktop-update-download'](), { started: false, reason: 'check-failed' }, 'the feed does not answer: said so');
    const failing = load({ desktopFeed: '0.2.48' });
    await failing.ipc['desktop-update-download']();
    failing.autoUpdater.failDownload(new Error('sha512 checksum mismatch')); await tick(); await tick();
    eq([(await failing.ipc['desktop-update-info']()).state, (await failing.ipc['desktop-update-info']()).error], ['idle', 'sha512 checksum mismatch'], 'a failed download: the button is back, with the reason');
    // An offer still asking PyPI which engine rides it: the button waits (no second download with other terms).
    let answer;
    const busy = load({ desktopFeed: '0.2.48', holdStatus: new Promise((r) => { answer = r; }) });
    const offer = busy.t.startOffer('0.2.48'); await tick();
    eq((await busy.ipc['desktop-update-info']()).busy, true, 'an offer is running: busy');
    eq(await busy.ipc['desktop-update-download'](), { started: false, reason: 'busy' }, 'and the button does not start a download of its own');
    answer(); await offer;
    eq(busy.autoUpdater.downloads.length, 1, 'the offer\'s own download is the only one');
  }
  // ── an engine-only update: prepared in the background, ONE "Update Ready", applied without restarting Electron ──
  {
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47', engineReady: '0.2.181' });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    eq(env.t.updateReadyState().ready, false, 'nothing prepared yet: nothing is ready (no indicator, no toast)');
    await env.t.checkPackageUpdateInBackground();
    eq(toasts(env), [{ ready: true, restart: false, desktop: null, engine: { from: '0.2.168', to: '0.2.181' } }], 'prepared and checked: ONE "Update Ready" for the engine');
    eq(env.dialogCalls.length, 0, 'and no dialog');
    await env.t.checkPackageUpdateInBackground();
    eq(toasts(env).length, 1, 'the next check finds the same prepared release: no second toast');
    ok(reminderTimer(env), 'the 90-minute reminder runs while it is pending');
    // The UI may still be mounting when the toast is sent: it takes it then — once.
    eq((await env.ipc['update-ready-take-toast']()).engine.to, '0.2.181', 'the UI takes the toast it may have missed');
    eq(await env.ipc['update-ready-take-toast'](), null, 'once: a remount does not show it again');
    // A background check or prepare still running could replace the prepared engine: Restart waits for it.
    env.t.setPackageUpdateInFlight(true);
    eq(await env.ipc['update-activate'](), { started: false, reason: 'busy' }, 'engine Restart during a background check: busy');
    eq(env.uv.upgrades.length, 0, 'and nothing is installed');
    env.t.setPackageUpdateInFlight(false);
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    let result;
    try { result = await env.ipc['update-activate'](); } finally { global.fetch = realFetch; }
    eq(env.uv.upgrades.map((o) => o.version), ['0.2.181'], '"Restart": exactly the prepared engine is installed');
    eq([result.started, env.autoUpdater.quits], [true, []], 'by the engine upgrade — the desktop is not restarted');
    ok(env.win.shown.includes('file:loading.html') && env.win.shown.some((u) => /^url:/.test(u)), 'the window shows the upgrade and is reloaded');
  }
  {
    // The desktop feed does not answer and no newer desktop is known: the engine prepared through the
    // compatibility-checked fallback is ready too — "Update Ready" is not held hostage to the feed.
    const env = load({ appVersion: '0.2.47', desktopCheckThrows: 'net::ERR_NAME_NOT_RESOLVED', engineReady: '0.2.181' });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    eq(env.t.getDesktopStatus().state, 'unknown', 'the feed did not answer');
    await env.t.checkPackageUpdateInBackground();
    eq(toasts(env).map((t) => t.engine && t.engine.to), ['0.2.181'], 'the engine prepared through the fallback is offered as ready');
  }
  {
    // A prepared engine is not "ready" while a newer desktop goes first: the desktop's own engine follows it.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    await env.t.getDesktopUpdateVersion();
    env.uv.prepared = { version: '0.2.181' };
    eq(env.t.updateReadyState().ready, false, 'a newer desktop is pending: the prepared engine is not offered');
    eq(await env.ipc['update-activate'](), { started: false, reason: 'not-ready' }, '"Restart" with nothing ready does nothing');
  }

  {
    // A log the backend prunes between the listing and its stat (launch.py cleans old logs as it starts, while
    // waitForBackend lists the same dir) is skipped — a throw there ended the wait (seen on the VM: ENOENT).
    const env = load();
    const dir = fs.mkdtempSync(path.join(HOME, 'logs-'));
    for (const [name, ageS] of [['old.log', 300], ['new.log', 1]]) {
      fs.writeFileSync(path.join(dir, name), 'x');
      const t = Date.now() / 1000 - ageS; fs.utimesSync(path.join(dir, name), t, t);
    }
    const realStat = fs.statSync;
    fs.statSync = (p, ...a) => { if (String(p).endsWith('old.log')) { const e = new Error(`ENOENT: no such file or directory, stat '${p}'`); e.code = 'ENOENT'; throw e; } return realStat(p, ...a); };
    let newest;
    try { newest = env.t.getNewestLogFile(dir); } finally { fs.statSync = realStat; }
    eq(newest && newest.name, 'new.log', 'a log gone since the listing is skipped, not thrown');
  }
  {
    // "Restart now" through main.js's applier: the background prepare and bytecode compile are stopped — the
    // restart's quit skips before-quit's close().
    const env = load();
    env.t.setBackendReady(true);
    await env.t.restartApplier.apply();
    eq(env.uv.cancelled, ['restart to install the update'], 'the background work is stopped before the restart');
  }
  {
    // Found while a pass is already running (autoCheckInFlight): owed as a follow-up, from the kept answer.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.47' });
    env.t.setupElectronAutoUpdater();
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    let release;
    env.autoUpdater.checkForUpdates = () => new Promise((r) => { release = () => r({ updateInfo: { version: '0.2.47' } }); });
    const running = env.t.runScheduledUpdateCheck(); await tick();
    await env.t.offerDesktopFoundAtLaunch('0.2.48');
    eq(env.t.getFollowUpDesktop(), true, 'a pass is in flight: the found desktop is owed to the next tick');
    release(); await running;
  }
  {
    // "Restart now" before the app is up (the recovery panel, the desktop-first install): the window is
    // hidden as before — never left on "Installing" with nothing to bring its own screen back.
    const env = load({ backendReady: false });
    await env.t.restartApplier.apply();
    ok(env.win.shown.includes('hidden') && !env.win.shown.includes('file:loading.html'), 'pre-start: hidden, its screen untouched');
  }
  {
    // RESTART with the announced version still the latest: not offered again — deferred silently.
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
    eq([offers(env).length, toasts(env).length], [0, 0], 'but the same version is NOT announced again');
    eq(env.autoUpdater.downloads.length, 1, 'it downloads silently instead (installs on the next quit)');
    ok(reminderTimer(env), 'and the 90-minute reminder will offer the restart');
    eq(env.t.engineChangeAllowed('test'), 'hold', 'the engine still waits for the pending desktop');
  }
  {
    // ...a NEWER version than the announced one is a new announcement.
    const userDataDir = fs.mkdtempSync(path.join(HOME, 'userdata-'));
    const env = load({ userDataDir, appVersion: '0.2.47', desktopFeed: '0.2.49' });
    env.writeSchedule({ lastSuccessAt: agoIso(HOUR), lastAttemptAt: agoIso(HOUR), lastResult: { state: 'available', version: '0.2.48' }, failureCount: 0, lastOfferedDesktopVersion: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck();
    const p = env.t.installAndStartBackend();
    await tick(); await tick();
    env.autoUpdater.finishDownload();
    await p;
    eq(offers(env, '0.2.49').length, 1, 'a strictly newer version is offered');
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
    eq(offers(env).length, 0, 'the version announced before the restart is not announced again');
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
    // The version already BEING OFFERED is not a follow-up debt: ticks under the running offer leave the
    // debt clear, so an engine retry that comes due gets its turn instead of being starved.
    let answer;
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', holdStatus: new Promise((r) => { answer = r; }) });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    await schedulerTick(env).fn(); await tick();
    await schedulerTick(env).fn(); await tick();
    eq(env.logLines.filter((l) => /package check/.test(l)).length, 0,
      'ticks under the running offer are QUIET — the same-version announce owes nothing and nothing spins');
    eq(env.autoUpdater.checks, 1, 'and no feed re-hits from a same-version follow-up loop');
    answer(); await tick(); await tick();
    eq(offers(env, '0.2.48').length, 1, 'one offer');
    await schedulerTick(env).fn(); await tick();
    ok(env.logLines.some((l) => /package check skipped: the desktop is updated first/.test(l)),
      'the settled offer arms the engine debt once, and the next tick serves it');
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
    // D1: a SCHEDULED pass landing on the version already being offered leaves NO desktop debt —
    // the engine retry is not starved by phantom follow-ups.
    let answer;
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', holdStatus: new Promise((r) => { answer = r; }) });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick(); // a due pass finds the same version under the running offer
    env.writeSchedule({ ...env.readSchedule(), engineFailureCount: 1, engineLastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    ok(env.logLines.some((l) => /engine check retry due/.test(l)),
      'the engine retry gets the next pass — the version being offered owed nothing');
    answer(); await tick(); await tick();
    eq(offers(env, '0.2.48').length, 1, 'same version: one offer');
  }
  {
    // D2: a pass that THROWS gives back the debt it was carrying.
    let finish;
    const env = load({ engineStatus: null, holdCheck: new Promise((r) => { finish = r; }) });
    env.t.setupElectronAutoUpdater();
    await env.t.getDesktopUpdateVersion();
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR) }); // the next tick is due
    const running = env.t.checkPackageUpdateInBackground({ label: 'running' }); await tick(); // a check in flight blocks the engine half
    await schedulerTick(env).fn(); await tick();
    const uvm = env.t.getUvManager();
    uvm.getInstalledFlowBin = () => { throw new Error('boom'); }; // the follow-up pass will throw mid-flight
    await schedulerTick(env).fn(); await tick();
    delete uvm.getInstalledFlowBin;
    finish(); await running;
    await schedulerTick(env).fn(); await tick();
    eq(env.uv.checks, 2, 'the debt survived the throwing pass and was paid once unblocked');
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
    // F1b: ticks under the LAUNCH offer owe nothing, exactly like tick-launched offers.
    let answer;
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', holdStatus: new Promise((r) => { answer = r; }) });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    const p = env.t.startOffer('0.2.48'); await tick();
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick();
    env.writeSchedule({ ...env.readSchedule(), engineFailureCount: 1, engineLastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    ok(env.logLines.some((l) => /engine check retry due/.test(l)), 'no phantom desktop debt starves the engine retry');
    answer(); await p; await tick();
    eq(offers(env, '0.2.48').length, 1, 'a due tick on the same version adds no second offer');
  }
  {
    // G1: a follow-up works from the CACHE — a stale 'available' naming the version the app already
    // runs must not produce an offer or a download.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    env.t.setPackageUpdateInFlight(true); // blocks the announce → desktop debt
    await schedulerTick(env).fn(); await tick();
    eq(offers(env).length, 0, 'the offer is blocked behind the running package check (debt armed)');
    env.writeSchedule({ ...env.readSchedule(), lastResult: { state: 'available', version: '0.2.47' } }); // stale: the running version
    env.t.setPackageUpdateInFlight(false);
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.downloads.length, 0, 'a cached answer no newer than the running app moves nothing');
    eq(offers(env).length, 0, 'and offers nothing');
  }
  {
    // F3: a version that already downloaded is not re-downloaded by 'resume' — the postponed "Update Ready"
    // and the 90-minute reminder own it from here.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48', engineStatus: null, backendReady: false });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await env.t.startOffer('0.2.48'); // desktop-only: the download starts
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' }); await tick();
    env.autoUpdater.finishDownload(); await tick();
    eq(toasts(env).length, 0, 'backend still starting: "Update Ready" is postponed');
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.downloads.length, 1, 'the landed version is not downloaded again by resume');
  }
  {
    // A deterministically failing offer re-arms its debt at most MAX_FOLLOW_UP_RETRIES times per
    // interval — never an every-5-minutes loop forever — and recovers on the next interval.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
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
    eq(offers(env, '0.2.48').length, 1, 'a fresh interval retries and the recovered offer goes through');
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
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.49' });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0, lastOfferedDesktopVersion: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    env.t.setPackageUpdateInFlight(true); // a running package check: a blocker no supersede removes
    await schedulerTick(env).fn(); await tick(); // due: finds 0.2.49, offer blocked
    eq(offers(env).length, 0, 'the offer is blocked behind the running package check');
    // An engine backoff comes due while it still runs: other passes run...
    env.writeSchedule({ ...env.readSchedule(), engineFailureCount: 1, engineLastAttemptAt: agoIso(schedule.BACKOFF_BASE_MS + 1000) });
    await schedulerTick(env).fn(); await tick();
    eq(offers(env).length, 0, 'still blocked while it runs');
    env.t.setPackageUpdateInFlight(false);
    await schedulerTick(env).fn(); await tick(); await tick();
    eq(offers(env, '0.2.49').length, 1, '...and the blocked desktop offer still fires on the next tick');
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
    // An engine check blocked by a running one is retried on a NEAR tick (session follow-up), not a
    // whole interval later — and the retry does not hit the desktop feed again.
    const env = load({ engineStatus: null });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq([env.autoUpdater.checks, env.uv.checks], [1, 1], 'first tick: both channels ran');
    env.t.setPackageUpdateInFlight(true);
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    await schedulerTick(env).fn(); await tick();
    eq(env.autoUpdater.checks, 2, 'due tick: the desktop check ran');
    eq(env.uv.checks, 1, 'but the engine check was blocked by the running one');
    env.t.setPackageUpdateInFlight(false);
    await schedulerTick(env).fn(); await tick();
    eq(env.uv.checks, 2, 'the blocked engine half is finished on the next tick');
    eq(env.autoUpdater.checks, 2, 'without a second desktop feed hit inside the interval');
  }
  {
    // A newer release while the previous one downloads: that download is cancelled and the newest is offered
    // instead — ONE offer, and the engine saved for it belongs to the newest only.
    const env = load({ appVersion: '0.2.47', desktopFeed: '0.2.48' });
    env.writeSchedule({ lastSuccessAt: agoIso(25 * HOUR), lastAttemptAt: agoIso(25 * HOUR), lastResult: { state: 'current', version: null }, failureCount: 0 });
    env.t.setupElectronAutoUpdater();
    await schedulerTick(env).fn(); await tick();
    eq(offers(env, '0.2.48').length, 1, 'the due tick offers 0.2.48 (its download runs)');
    env.autoUpdater.checkForUpdates = async () => { env.autoUpdater.checks++; return { updateInfo: { version: '0.2.49' } }; };
    env.writeSchedule({ ...env.readSchedule(), lastSuccessAt: agoIso(25 * HOUR) });
    const pass = schedulerTick(env).fn(); await tick(); await tick();
    env.autoUpdater.failDownload(new Error('cancelled')); await pass; await tick();
    ok(env.logLines.some((l) => /0\.2\.49 supersedes the download of 0\.2\.48/.test(l)), 'the older download is cancelled');
    eq(offers(env, '0.2.49').length, 1, 'and ONE offer for the newest replaces it');
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
    eq(offers(env).length, 0, 'the offer died before its download');
    uvm.deferPackageVersion = defer;
    await schedulerTick(env).fn(); await tick(); await tick();
    eq(offers(env, '0.2.48').length, 1, 'the next tick retries the offer from the cache');
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
    // The desktop leads: installed on quit after "Later" (nothing agreed), the new desktop still installs the newest
    // engine it accepts — no question. Offline (nothing resolvable): the version saved with the update.
    for (const [compatibleRelease, expect, why] of [[{ version: '0.2.181' }, '0.2.181', 'the newest compatible engine'], [null, '0.2.180', 'PyPI silent → the saved version']]) {
      const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', compatibleRelease });
      fs.writeFileSync(path.join(env.userData, 'desktop-version.json'), JSON.stringify({ version: '0.2.47' }));
      await env.t.getDesktopUpdateVersion();
      fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: false }));
      await env.t.installAndStartBackend();
      eq(env.uv.upgrades.map((o) => o.version), [expect], `desktop updated after "Later": ${why} is installed, unasked`);
      eq(env.dialogCalls.length, 0, 'no engine dialog');
    }
    // No record at all (a desktop-only update): the engine still follows the new desktop.
    const bare = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', compatibleRelease: { version: '0.2.181' } });
    fs.writeFileSync(path.join(bare.userData, 'desktop-version.json'), JSON.stringify({ version: '0.2.47' }));
    await bare.t.getDesktopUpdateVersion();
    await bare.t.installAndStartBackend();
    eq(bare.uv.upgrades.map((o) => o.version), ['0.2.181'], 'a desktop-only update: the newest compatible engine follows it');
    // Already on it: nothing to do.
    const same = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', compatibleRelease: { version: '0.2.168' } });
    fs.writeFileSync(path.join(same.userData, 'desktop-version.json'), JSON.stringify({ version: '0.2.47' }));
    await same.t.installAndStartBackend();
    eq(same.uv.upgrades.length, 0, 'the installed engine is already the newest compatible: nothing installed');
    // A DOWNGRADE (an older installer run by hand) is no update: the engine is not changed by itself.
    const down = load({ appVersion: '0.2.48', desktopFeed: '0.2.49', compatibleRelease: { version: '0.2.181' }, dialogResponses: [1] });
    fs.writeFileSync(path.join(down.userData, 'desktop-version.json'), JSON.stringify({ version: '0.2.49' }));
    await down.t.getDesktopUpdateVersion();
    await down.t.installAndStartBackend();
    eq(down.uv.upgrades.length, 0, 'a downgrade installs no engine');
    ok(down.logLines.some((l) => /desktop downgraded 0\.2\.49 → 0\.2\.48/.test(l)), 'it is logged as a downgrade');
    // ...and an engine the older desktop cannot run goes through the pair check, which asks first.
    const tooNew = load({ appVersion: '0.2.48', desktopFeed: '0.2.48', compatibleRelease: { version: '0.2.170' }, dialogResponses: [1 /* Keep */],
      pairIssue: { reasons: ['engine 0.2.181 needs desktop >= 0.2.49'], engineVersion: '0.2.181', desktopTooOld: true } });
    fs.writeFileSync(path.join(tooNew.userData, 'desktop-version.json'), JSON.stringify({ version: '0.2.49' }));
    await tooNew.t.getDesktopUpdateVersion();
    await tooNew.t.installAndStartBackend();
    eq(tooNew.uv.upgrades.length, 0, 'downgrade + an engine too new for it: nothing moved unasked');
    ok(tooNew.dialogCalls.length >= 1, 'the user is asked about moving the engine back');
  }
  {
    // Same desktop as last run (not an update) and nothing agreed: never a silent install — and no question in the
    // start either: the engine is checked (prepared, then "Update Ready") once FlowPad is up.
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48' });
    await env.t.getDesktopUpdateVersion(); // the launch-time check answered: running the latest desktop
    fs.writeFileSync(env.statePath, JSON.stringify({ engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: false }));
    await env.t.installAndStartBackend();
    eq(env.uv.upgrades.length, 0, 'no silent install without agreement');
    eq(env.uv.checks, 0, 'no engine question holds the start');
    ok(env.logLines.some((l) => /engine is checked once FlowPad is up/.test(l)), 'it is checked once FlowPad is up');
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
    ok(env.logLines.some((l) => /installing engine 0\.2\.180 after the desktop update failed/.test(l)), 'and the failure is logged');
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
