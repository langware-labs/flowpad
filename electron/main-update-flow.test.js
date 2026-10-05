'use strict';

/*
 * Integration test for the update flow wired in main.js — the REAL main.js, loaded with stubs for Electron,
 * electron-updater, electron-log and UvManager (so nothing is installed, downloaded or shown). main.js has no exports,
 * so a few internals are exposed by APPENDING to its source at load time; production code is untouched.
 *
 * Covers: desktop + engine offered together (Update now / Later), the saved engine version, the 90 minute reminder,
 * engine dialogs held back while a desktop update is pending, desktop-only, and the next launch of the new desktop.
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
  offerDesktopUpdate, offerPostponedRestartPrompt, backendWaitAborted, showDesktopReadyPrompt, installAndStartBackend, showStartupErrorPanel, reportStartupCrash, checkPackageUpdateInBackground,
  setupElectronAutoUpdater, readyReminder, pendingEngineStore, restartApplier,
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

  const dialogCalls = [];
  const responses = [...(opts.dialogResponses || [])];
  let releaseDialog = () => {};
  const gate = opts.holdDialog ? new Promise((r) => { releaseDialog = r; }) : null;
  const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 'stub' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk(), set: () => true });
  const BW = function () {}; BW.getAllWindows = () => []; BW.getFocusedWindow = () => null;
  const autoUpdater = Object.assign(new EventEmitter(), {
    downloads: [], quits: [],
    checkForUpdates: async () => ({ updateInfo: { version: opts.desktopFeed || opts.appVersion || '0.2.47' } }),
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
    ipcMain: { on() {}, handle() {}, once() {} },
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
    async startWithBin() {}
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
  return { t, processHandlers, sent: win.sent, releaseDialog: () => releaseDialog(), autoUpdater, dialogCalls, intervals, uv, logLines, userData, statePath: path.join(userData, 'pending-engine.json'), readState: () => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'pending-engine.json'), 'utf8')); } catch { return null; } } };
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
    ok(env.logLines.some((l) => /package check skipped: desktop 0\.2\.48 is pending/.test(l)), 'and it says why');
  }

  // ── nothing installed: no "update" ──────────────────────────────────────
  {
    const env = load({ installed: false });
    await env.t.checkPackageUpdateInBackground();
    eq(env.uv.checks, 0, 'flowpad is not installed (first-time setup failed): the periodic check offers no update');
    ok(env.logLines.some((l) => /package check skipped: flowpad is not installed/.test(l)), 'and it says why');
    const installed = load({});
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
    // No window to show the error panel in: the native dialog (with "Share with us") must be AWAITED, because the
    // caller quits the app as soon as this returns false — quitting first would close the only explanation.
    const env = load({ holdDialog: true });
    env.t.setMainWindow(null);
    let settled = null;
    const p = env.t.showStartupErrorPanel('boom', { retryable: true }).then((v) => { settled = v; });
    await tick(); await tick();
    eq(env.dialogCalls.length, 1, 'the native dialog is shown');
    ok(env.dialogCalls[0].buttons.includes('Share with us'), 'and it offers Share with us');
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
    ok(env.dialogCalls[0].buttons.includes('Share with us'), 'with Share with us');
  }

  console.log(`main-update-flow.test.js: ${passed} assertions passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
