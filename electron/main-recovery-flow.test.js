'use strict';

/*
 * Integration test for the FLOWPAD-2231 recovery flow wired in main.js — the REAL main.js, loaded with stubs
 * for Electron, electron-updater, electron-log and UvManager (nothing is installed, downloaded or shown), the
 * same way main-update-flow.test.js does it.
 *
 * Covers (numbers = the regression list in the task):
 *   1  a fatal record for the unchanged runtime → the backend is NOT started again (zero retries);
 *   6  the backend failed, the desktop updater still works from the failure panel;
 *   7  update available → the verified update flow runs ONCE (download → verify → quitAndInstall);
 *   8  no update → the recovery panel stays usable (Retry anyway / Export logs);
 *   9  offline / hanging feed → the panel does not wait on the update check;
 *   11 the installed update did not help → not offered again (recovery mode);
 *   12 a failed download → diagnostics remain accessible, nothing is installed;
 *   13 interrupted download/relaunch → the persisted attempt is handled on the next launch;
 *   15 the monitor's record and Electron's log probe → one reason.
 * Run: `node electron/main-recovery-flow.test.js` (exits non-zero on failure).
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
  handleFatalFailure, runRecoveryUpdate, showRecoveryEntry, installAndStartBackend, waitForBackend, exportDiagnostics,
  setupElectronAutoUpdater, readRecoveryState,
  primeLaunchCheck: () => { launchDesktopCheck = updateRecovery.boundedCheck(() => getDesktopUpdateVersion(), { log }); },
  setLaunchDesktopCheck: (p) => { launchDesktopCheck = p; },
  setMainWindow: (w) => { mainWindow = w; },
  setQuitting: (v) => { isQuitting = v; },
  setUvManager: (u) => { uvManager = u; },
  instanceDir: INSTANCE_DIR,
};`;

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'server-failure.sample.json'), 'utf8'));

/** Load a fresh copy of main.js under its own HOME. `opts`: appVersion, desktopFeed, feedFails, feedHangs, downloadFails, engine. */
function load(opts = {}) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mainrec-'));
  // main.js derives ~/.flow (logs, instance dir) from os.homedir() at load: $HOME on POSIX, %USERPROFILE% on
  // Windows. Both, so the test never reads or writes the real profile on either (on a machine with a real
  // FlowPad install the export test passed by accident off the real logs).
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  const userData = fs.mkdtempSync(path.join(HOME, 'userdata-'));
  global.setInterval = (fn, ms) => ({ fn, ms, unref() {} });

  const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 'stub' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk(), set: () => true });
  const BW = function () {}; BW.getAllWindows = () => []; BW.getFocusedWindow = () => null;
  const autoUpdater = Object.assign(new EventEmitter(), {
    downloads: [], quits: [],
    checkForUpdates: async () => {
      if (opts.feedHangs) return new Promise(() => {});
      if (opts.feedFails) throw new Error('net::ERR_INTERNET_DISCONNECTED');
      return { updateInfo: { version: opts.desktopFeed || opts.appVersion || '0.2.47' } };
    },
    downloadUpdate() {
      autoUpdater.downloads.push(1);
      if (opts.downloadFails) return Promise.reject(new Error('sha512 checksum mismatch'));
      return new Promise((r) => { autoUpdater.finishDownload = r; });
    },
    quitAndInstall: (...a) => { autoUpdater.quits.push(a); },
  });
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const saveDialogs = [];
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, setAsDefaultProtocolClient() {}, getPath: (k) => (k === 'desktop' ? HOME : userData), whenReady: () => new Promise(() => {}),
      on() {}, isPackaged: true, getVersion: () => opts.appVersion || '0.2.47', quit() { electron.quits = (electron.quits || 0) + 1; }, exit() {}, commandLine: { appendSwitch() {} }, setName() {}, setAppUserModelId() {},
    },
    BrowserWindow: BW,
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showErrorBox() {},
      showSaveDialog: async (_w, o) => { saveDialogs.push(o); return opts.cancelSave ? { canceled: true } : { canceled: false, filePath: path.join(HOME, 'exported.zip') }; },
    },
    ipcMain,
    shell: mk(), clipboard: mk(), Menu: mk(), nativeImage: mk(), session: mk(), screen: mk(), Tray: mk(), globalShortcut: mk(), powerMonitor: mk(), protocol: mk(), net: mk(), desktopCapturer: mk(), systemPreferences: mk(), Notification: mk(),
  };
  const logLines = [];
  const log = { info: (l) => logLines.push(String(l)), warn: (l) => logLines.push(String(l)), error: (l) => logLines.push(String(l)), transports: { file: {}, console: {} }, hooks: [] };

  const uv = { starts: 0, stops: 0, repairs: 0 };
  const venv = path.join(HOME, 'uv', 'tools', 'flowpad');
  class FakeUv {
    constructor() { uv.instance = this; }
    getInstalledFlowBin() { return opts.noEngine ? null : '/fake/bin/flow'; }
    async ensureUv() {}
    async probeManagedInterpreter() { uv.probes = (uv.probes || 0) + 1; if (opts.preflightBlocked) throw Object.assign(new Error('preflight'), { stderr: 'error: Failed to query Python interpreter at `C:\\u\\python.exe`\n  cause: An Application Control policy has blocked this file. (os error 4551)', code: 2 }); return { ok: true }; }
    async installLatest() { uv.installs = (uv.installs || 0) + 1; if (opts.installFails) throw opts.installFails(uv.installs); this._flowBin = '/fake/bin/flow'; }
    hadInterruptedInstall() { return false; }
    getInstalledVersionSync() { return opts.engine || '0.2.203'; }
    _toolVenvDir() { return venv; }
    async _pypiUpdateStatus() { return null; }
    deferPackageVersion() {}
    async upgrade() {}
    async checkForUpdatesInBackground() { return false; }
    async startWithBin(bin) { if (opts.startFails) throw opts.startFails(); this._flowBin = bin; uv.starts++; }
    useFlowBin(bin) { this._flowBin = bin; }
    async start() { if (!this._flowBin) throw new Error('flow binary not set — call startWithBin() or installLatest() first'); uv.starts++; }
    stop() { uv.stops++; return Promise.resolve(); }
    async codeIntegrityEvents() { return opts.ciEvents || ''; }
    async repairRuntime(args) { uv.repairs++; uv.lastRepair = args; if (opts.repairOk) return { ok: true, python: 'C:\\r\\python.exe' }; throw Object.assign(new Error('not in this test'), { step: 'download' }); }
    isInstalling() { return false; }
    setFailureSharer() {}
    openPackageDialogVersion() { return null; }
    async getLatestPypiVersion() { return null; }
    lastLaunch() { return null; }
    hasLaunchedBackend() { return uv.starts > 0; }
    repairedRuntimePython() { return null; }
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
  const realProcessOn = process.on;
  process.on = function (ev, fn) { if (ev === 'uncaughtException' || ev === 'unhandledRejection') return process; return realProcessOn.call(process, ev, fn); };
  try {
    const m = new Module(MAIN, null);
    m.filename = MAIN; m.paths = Module._nodeModulePaths(path.dirname(MAIN));
    m._compile(fs.readFileSync(MAIN, 'utf8') + EXPOSE, MAIN);
    t = m.exports.__t;
  } finally { Module._load = origLoad; process.on = realProcessOn; }

  const win = { isDestroyed: () => false, isMinimized: () => false, webContents: { send(ch, d) { win.sent.push([ch, d]); }, isLoading: () => false, once() {} }, sent: [], loadFile: async () => {}, loadURL() {}, show() {}, hide() {}, focus() {} };
  t.setMainWindow(win);
  t.setUvManager(new FakeUv());
  // Tests that drive the panel directly stand in for a fast path that already resolved the flow binary
  // (installAndStartBackend → startWithBin / useFlowBin); test 1 runs installAndStartBackend itself.
  if (opts.binReady !== false) uv.instance.useFlowBin('/fake/bin/flow');
  fs.mkdirSync(t.instanceDir, { recursive: true });
  const python = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  /** A fatal record for THIS runtime, written `agoMs` ago. */
  const writeRecord = (over = {}, agoMs = 0) => {
    const record = { ...SAMPLE, at: new Date(Date.now() - agoMs).toISOString(), fingerprint: { python, engine_version: opts.engine || '0.2.203', platform: 'test' }, ...over };
    fs.writeFileSync(path.join(t.instanceDir, 'server-failure.json'), JSON.stringify(record));
    return record;
  };
  const panels = () => win.sent.filter(([ch]) => ch === 'startup-error').map(([, d]) => d);
  const statuses = () => win.sent.filter(([ch]) => ch === 'startup-status').map(([, d]) => d);
  return { t, win, autoUpdater, ipcMain, electron, uv, logLines, HOME, userData, saveDialogs, writeRecord, panels, statuses, python,
    recordExists: () => fs.existsSync(path.join(t.instanceDir, 'server-failure.json')) };
}

(async () => {
  // ── 1: a fatal record for the unchanged runtime → no start at all ────────
  {
    const env = load({ binReady: false });
    const record = env.writeRecord({}, 60 * 1000); // from the previous run
    const r = await env.t.installAndStartBackend();
    eq([r.ok, !!r.fatalRecord, r.fatalRecord && r.fatalRecord.kind], [false, true, 'policy-blocked'], 'the record stops the start before anything runs');
    eq(env.uv.starts, 0, 'zero backend starts');
    ok(env.recordExists(), 'the record stays until the user retries or the runtime changes');
    eq(env.uv.instance._flowBin, '/fake/bin/flow', 'the flow binary is remembered so the panel\'s Retry anyway can start it');
    ok(env.logLines.some((l) => /not starting it again/.test(l)), 'and says why');
    // The same record for ANOTHER runtime (the repair installed a different interpreter): stale → cleared, start proceeds.
    env.writeRecord({ fingerprint: { python: 'C:/repaired/python.exe', engine_version: record.engine_version, platform: 'test' } }, 60 * 1000);
    const r2 = await env.t.installAndStartBackend();
    eq([r2.ok, env.uv.starts], [true, 1], 'a record for a different runtime does not block the start');
    ok(!env.recordExists(), 'and is cleared as stale');
  }

  // ── 6 + 7: backend failed, the updater still works from the panel; the verified flow runs once ──
  {
    const env = load({ desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck();
    const record = env.writeRecord();
    const match = require('./fatal-failure').policyMatchFromRecord(record);
    const done = env.t.handleFatalFailure({ match, record });
    await settle(10);
    const [panel] = env.panels();
    ok(panel, 'the failure panel is shown');
    eq([panel.policyBlocked, panel.retryable, panel.retryLabel, panel.exportable, panel.updateVersion], [true, true, 'Retry anyway', true, '0.2.48'], 'policy text, Retry anyway, Export logs, Update to 0.2.48');
    ok(/_multiprocessing/.test(panel.detail) && /Traceback/.test(panel.detail), 'the traceback from the monitor\'s record');
    ok(/supervisor stopped restarting it after 3 attempts/.test(panel.detail), 'the monitor\'s attempt count');
    ok(/0\.2\.48 is available/.test(panel.detail) && /not the Python runtime Windows blocked/.test(panel.detail) && /Repair FlowPad/.test(panel.detail), 'the update is offered without claiming it fixes the blocked runtime');
    ok(/Retrying without changing anything is unlikely to help/.test(panel.retryWarning), 'the retry warning');
    eq(env.uv.stops, 1, 'the backend was stopped under the panel');
    // The user clicks "Update FlowPad to 0.2.48".
    env.ipcMain.emit('update-desktop-recovery');
    await settle(10);
    eq(env.autoUpdater.downloads.length, 1, 'ONE download through the updater (its sha512 verification)');
    ok(env.statuses().some((s) => /Downloading FlowPad 0\.2\.48/.test(s)), 'progress on the loading screen');
    const state = env.t.readRecoveryState();
    eq([state.attempts.length, state.attempts[0].targetVersion, state.attempts[0].outcome, state.attempts[0].fromVersion], [1, '0.2.48', 'installing', '0.2.47'], 'the attempt is persisted BEFORE anything is installed');
    env.autoUpdater.emit('update-downloaded', { version: '0.2.48' });
    env.autoUpdater.finishDownload();
    await settle(12);
    eq(env.autoUpdater.quits, [[true, true]], 'quitAndInstall(silent, relaunch) once');
    eq(await done, false, 'the flow ends: the app is quitting into the installer');
    ok(env.recordExists(), 'the fatal record is not cleared by an update (only by a healthy backend, a retry, or a changed runtime)');
  }

  // ── 11: the update did not help → recovery mode, not another install ────
  {
    const env = load({ appVersion: '0.2.48', desktopFeed: '0.2.48' });
    env.t.setupElectronAutoUpdater();
    // The previous desktop recorded the attempt; this launch IS the target version.
    const ur = require('./update-recovery');
    fs.writeFileSync(path.join(env.userData, ur.RECOVERY_FILE), JSON.stringify(ur.recordRecoveryAttempt({ attempts: [] }, { targetVersion: '0.2.48', fingerprint: SAMPLE.fingerprint.hash, fromVersion: '0.2.47', at: 't0' })));
    const after = ur.afterRelaunch({ state: env.t.readRecoveryState(), appVersion: '0.2.48' });
    eq(after.installed && after.installed.outcome, 'installed', 'the relaunch recognises the install');
    fs.writeFileSync(path.join(env.userData, ur.RECOVERY_FILE), JSON.stringify(after.state));
    env.t.primeLaunchCheck();
    const record = env.writeRecord(); // the new version fails the same way (same fingerprint hash from the sample)
    const done = env.t.handleFatalFailure({ match: require('./fatal-failure').policyMatchFromRecord(record), record });
    await settle(10);
    const [panel] = env.panels();
    eq(panel.updateVersion, null, 'the installed version is not offered again');
    eq(env.autoUpdater.downloads.length, 0, 'no download, no loop');
    ok(/No newer FlowPad version/.test(panel.detail), 'the panel says there is no newer version');
    env.t.setQuitting(true); env.ipcMain.emit('retry-startup'); await settle(); eq(await done, false, 'quit ends the flow');
  }

  // ── 8: no update → the panel stays usable: Retry anyway (clears the record, starts, waits), Export logs ──
  {
    const env = load({ desktopFeed: '0.2.47' });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck();
    global.fetch = async () => ({ ok: true }); // the retried backend answers at once
    const record = env.writeRecord();
    const done = env.t.handleFatalFailure({ match: require('./fatal-failure').policyMatchFromRecord(record), record });
    await settle(10);
    const [panel] = env.panels();
    eq([panel.updateVersion, panel.exportable, panel.retryLabel], [null, true, 'Retry anyway'], 'no update offered; export and retry stay');
    ok(/No newer FlowPad version is available/.test(panel.detail), 'said in the text');
    env.ipcMain.emit('retry-startup');
    await settle(10);
    ok(!env.recordExists(), 'Retry anyway clears the monitor\'s record (its consent to start the same runtime)');
    eq(env.uv.starts, 1, 'the backend was started once');
    eq(await done, true, 'and it came up');
    delete global.fetch;
  }

  // ── 9: offline or hanging feed → the panel does not wait on the update check ──
  {
    const env = load({ feedHangs: true });
    env.t.setupElectronAutoUpdater();
    const ur = require('./update-recovery');
    env.t.setLaunchDesktopCheck(ur.boundedCheck(() => new Promise(() => {}), { ms: 30, log: { info() {} } })); // the same bound, shortened for the test
    const record = env.writeRecord();
    const t0 = Date.now();
    const done = env.t.handleFatalFailure({ match: require('./fatal-failure').policyMatchFromRecord(record), record });
    await new Promise((r) => setTimeout(r, 120));
    await settle(10);
    ok(env.panels().length === 1 && Date.now() - t0 < 1000, 'the panel appeared without waiting for the feed');
    eq(env.panels()[0].updateVersion, null, 'no update known');
    env.t.setQuitting(true); env.ipcMain.emit('retry-startup'); await settle(); await done;

    const off = load({ feedFails: true });
    off.t.setupElectronAutoUpdater();
    off.t.primeLaunchCheck();
    const rec2 = off.writeRecord();
    const d2 = off.t.handleFatalFailure({ match: require('./fatal-failure').policyMatchFromRecord(rec2), record: rec2 });
    await settle(10);
    eq([off.panels().length, off.panels()[0].updateVersion, off.panels()[0].exportable], [1, null, true], 'a failing feed: the panel, no update, export still there');
    off.t.setQuitting(true); off.ipcMain.emit('retry-startup'); await settle(); await d2;
  }

  // ── 12: a failed download → diagnostics remain accessible, nothing installed, not retried automatically ──
  {
    const env = load({ desktopFeed: '0.2.48', downloadFails: true });
    env.t.setupElectronAutoUpdater();
    env.t.primeLaunchCheck();
    const record = env.writeRecord();
    const done = env.t.handleFatalFailure({ match: require('./fatal-failure').policyMatchFromRecord(record), record });
    await settle(10);
    eq(env.panels()[0].updateVersion, '0.2.48', 'offered');
    env.ipcMain.emit('update-desktop-recovery');
    await settle(14);
    eq(env.panels().length, 2, 'the panel is shown again after the failed update');
    const again = env.panels()[1];
    ok(/Update to 0\.2\.48 failed/.test(again.detail), 'and says the update failed');
    eq([again.updateVersion, again.exportable, again.retryable], [null, true, true], 'not offered again; export and retry remain');
    ok(/already attempted for this failure/.test(again.detail) && /failed/.test(again.detail), 'the prior attempt is explained');
    eq(env.autoUpdater.quits, [], 'nothing was installed');
    eq(env.t.readRecoveryState().attempts[0].outcome, 'failed', 'persisted as failed');
    env.t.setQuitting(true); env.ipcMain.emit('retry-startup'); await settle(); await done;
  }

  // ── 13: an interrupted attempt is dropped on relaunch (unit-tested in update-recovery.test.js; here: the file) ──
  {
    const env = load({ appVersion: '0.2.47' });
    const ur = require('./update-recovery');
    fs.writeFileSync(path.join(env.userData, ur.RECOVERY_FILE), JSON.stringify(ur.recordRecoveryAttempt({ attempts: [] }, { targetVersion: '0.2.48', fingerprint: 'x', fromVersion: '0.2.47', at: 't0' })));
    const r = ur.afterRelaunch({ state: env.t.readRecoveryState(), appVersion: '0.2.47' });
    eq([r.installed, r.state.attempts], [null, []], 'still the old version: the interrupted attempt is dropped');
  }

  // ── 15: the monitor's record and Electron's own probe → ONE reason, the monitor's ──
  {
    const env = load({ desktopFeed: '0.2.47' });
    env.t.primeLaunchCheck();
    const ff = require('./fatal-failure');
    const record = env.writeRecord();
    const probeMatch = { line: record.excerpt, module: '_multiprocessing', file: 'connection.py', traceback: 'Traceback …', path: 'electron-view.log' };
    const rec = ff.reconcileFatalReason({ record, probeMatch });
    eq([rec.kind, rec.source, rec.agree, rec.match.fromMonitor], ['policy-blocked', 'both', true, true], 'both sides, one kind, the monitor\'s match');
    const done = env.t.handleFatalFailure({ match: rec.match, record });
    await settle(10);
    eq(env.panels().length, 1, 'one panel');
    ok(env.panels()[0].detail.includes(record.server_log), 'with the monitor\'s server log path, not Electron\'s');
    env.t.setQuitting(true); env.ipcMain.emit('retry-startup'); await settle(); await done;
  }

  // ── 2026-10-10: the block hits the LAUNCHER (flow start → pydantic → _pydantic_core) before any server log ──
  {
    const env = load({ desktopFeed: '0.2.47' });
    env.t.primeLaunchCheck();
    global.fetch = async () => { throw new Error('ECONNREFUSED'); }; // no backend answers
    const launch = {
      startedAt: Date.now(), lines: 9, lastLine: '', exit: { code: 1, signal: null },
      stdout: '2026-10-10T16:13:26.236Z [boot] t=14.1s phase=import modules=247 last=pydantic_core\n',
      stderr: '└──────┘\nImportError: DLL load failed while importing _pydantic_core: An Application \nControl policy has blocked this file.\n',
      tail: () => 'tail',
    };
    const w = await env.t.waitForBackend({ maxChecks: 2, launch });
    eq([w.ready, w.reason, w.policyBlock && w.policyBlock.module], [false, 'policy-blocked', '_pydantic_core'], 'a policy block in the launcher output is classified as policy-blocked');
    ok(/launcher/.test(w.policyBlock.path), 'and attributed to the launcher');
    const done = env.t.handleFatalFailure({ match: w.policyBlock, record: null });
    await settle(10);
    const [panel] = env.panels();
    ok(panel && panel.policyBlocked, 'the policy panel, not the generic timeout panel');
    ok(/_pydantic_core/.test(panel.detail) && /runtime repair cannot help/.test(panel.detail), 'the panel names the wheel module and says a repair cannot help');
    eq(panel.repairable, false, 'no Repair button for a wheel module');
    env.t.setQuitting(true); env.ipcMain.emit('retry-startup'); await settle(); await done;
    delete global.fetch;
  }

  // ── 2026-10-12: the block hits the engine INSTALL (uv builds pybars3 from source → setuptools → unicodedata) ──
  {
    const stderr = 'error: Failed to build `pybars3==0.9.7`\n  Caused by: Call to `setuptools.build_meta:__legacy__.get_requires_for_build_wheel` failed (exit code: 1)\nTraceback (most recent call last):\n  File "C:\\u\\setuptools\\unicode_utils.py", line 2, in <module>\n    import unicodedata\nImportError: DLL load failed while importing unicodedata: An Application Control policy has blocked this file.\n';
    const env = load({ noEngine: true, binReady: false, installFails: () => Object.assign(new Error('Command failed: uv tool install flowpad --python 3.11 --force\n' + stderr), { stderr, code: 1 }) });
    env.t.primeLaunchCheck();
    const r = await env.t.installAndStartBackend();
    eq([r.ok, r.installBlock && r.installBlock.module], [false, 'unicodedata'], 'a block in the install output comes back as an install block naming the module, not as a generic failure');
    eq(env.panels().length, 0, 'no generic error panel was shown for it');
    // The repair panel for it: nothing was launched, so nothing is stopped (a bare `flow stop` kills whatever holds the port).
    let retries = 0;
    const done = env.t.handleFatalFailure({ match: r.installBlock, record: null, retry: async () => { retries++; return { ok: false, installBlock: r.installBlock }; } });
    await settle(10);
    const [panel] = env.panels();
    ok(panel && panel.policyBlocked, 'the application-control panel');
    ok(/unicodedata/.test(panel.detail), 'it names the blocked module');
    ok(/uv tool install/.test(panel.detail), 'and where the evidence came from');
    eq(env.uv.stops, 0, 'the install never launched a backend: nothing is stopped');
    env.ipcMain.emit('retry-startup'); await settle(20);
    eq(retries, 1, 'Retry anyway re-runs the INSTALL (there is no engine to start)');
    eq(env.panels().length, 2, 'and a repeat block shows the panel again');
    env.t.setQuitting(true); env.ipcMain.emit('retry-startup'); await settle(); await done;
    // A retry that fails for another reason: the failure is described in the repair panel (no second panel from the install).
    const env3 = load({ noEngine: true, binReady: false, installFails: () => Object.assign(new Error('x'), { stderr: stderr, code: 1 }) });
    env3.t.primeLaunchCheck();
    const blk = (await env3.t.installAndStartBackend()).installBlock;
    const quietEnv = load({ noEngine: true, binReady: false, installFails: () => Object.assign(new Error('Command failed: uv tool install flowpad\nerror: Failed to download distributions: network unreachable'), { stderr: 'network unreachable', code: 1 }) });
    quietEnv.t.primeLaunchCheck();
    const q = await quietEnv.t.installAndStartBackend({ quiet: true });
    eq([q.ok, !!q.error, quietEnv.panels().length], [false, true, 0], 'quiet: the failure comes back to the caller, no panel of its own');
    const done3 = env3.t.handleFatalFailure({ match: blk, record: null, retry: async () => ({ ok: false, error: Object.assign(new Error('Command failed: uv tool install flowpad'), { stderr: 'error: Failed to download distributions: network unreachable', code: 1 }) }) });
    await settle(10);
    env3.ipcMain.emit('retry-startup'); await settle(20);
    const shown = env3.panels();
    ok(shown.length === 2 && /The install failed again/.test(shown[1].detail) && /network unreachable/.test(shown[1].detail), 'a retry that fails for another reason: the new failure is in the panel');
    env3.t.setQuitting(true); env3.ipcMain.emit('retry-startup'); await settle(); await done3;
    // The engine's LAUNCHER blocked (start() fails, text says Device Guard): not an install block, the old generic path with its own evidence.
    const env4 = load({ startFails: () => Object.assign(new Error('This computer\u2019s application-control policy (Windows Defender Application Control / Device Guard) blocks the programs Flowpad needs to start its engine.'), { policyBlocked: true }) });
    env4.t.primeLaunchCheck();
    const r4 = await env4.t.installAndStartBackend({ quiet: true });
    eq([r4.ok, r4.installBlock], [false, undefined], 'a blocked launcher (start) is not labelled as a blocked install');
    // A failure that is not a block stays the generic panel path.
    const env2 = load({ noEngine: true, binReady: false, installFails: () => Object.assign(new Error('Command failed: uv tool install flowpad\nerror: Failed to download distributions: network unreachable'), { stderr: 'network unreachable', code: 1 }) });
    env2.t.primeLaunchCheck();
    const r2 = await env2.t.installAndStartBackend();
    eq([r2.ok, r2.installBlock], [false, undefined], 'a network failure is not an install block');
    env.t.setQuitting(false);
  }

  // ── The preflight: a blocked interpreter never reaches `uv tool install` ──
  {
    const env = load({ noEngine: true, binReady: false, preflightBlocked: true, installFails: () => new Error('the install must not run') });
    env.t.primeLaunchCheck();
    const r = await env.t.installAndStartBackend();
    eq([r.ok, r.firstInstall, !!r.installBlock, env.uv.probes, env.uv.installs || 0], [false, true, true, 1, 0], 'a blocked interpreter is found by the preflight: install block on the first install, and `uv tool install` never ran');
    const okEnv = load({ noEngine: true, binReady: false });
    okEnv.t.primeLaunchCheck();
    const r2 = await okEnv.t.installAndStartBackend();
    eq([okEnv.uv.probes, okEnv.uv.installs], [1, 1], 'an interpreter that runs: the preflight passes and the install follows');
  }

  // ── A blocked FIRST install repairs itself: no panel, no click (there is no engine to lose) ──
  {
    // Repair is Windows-only (`repairable`): the block runs as on Windows on every platform the tests run on.
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const block = { line: 'cause: An Application Control policy has blocked this file. (os error 4551)', module: null, traceback: 'x', path: 'the engine install (uv tool install output)' };
      const env = load({ noEngine: true, binReady: false, repairOk: true });
      env.t.primeLaunchCheck();
      const ok1 = await env.t.handleFatalFailure({ match: block, record: null, retry: async () => ({ ok: false }), autoRepair: true });
      eq([ok1, env.uv.repairs, env.panels().length], [true, 1, 0], 'first install blocked: the repair ran by itself and no panel was shown');
      // The automatic repair fails: the panel appears (with the reason), and the repair is not retried on its own.
      const env2 = load({ noEngine: true, binReady: false });
      env2.t.primeLaunchCheck();
      const done2 = env2.t.handleFatalFailure({ match: block, record: null, retry: async () => ({ ok: false }), autoRepair: true });
      await settle(20);
      eq([env2.uv.repairs, env2.panels().length], [1, 1], 'the automatic repair failed: one attempt, then the panel');
      ok(/Repair failed at step/.test(env2.panels()[0].detail), 'and it says why');
      env2.t.setQuitting(true); env2.ipcMain.emit('retry-startup'); await settle(); await done2;
      // Not asked for (an engine exists): the panel and the user's consent, as before.
      const env3 = load({ noEngine: true, binReady: false, repairOk: true });
      env3.t.primeLaunchCheck();
      const done3 = env3.t.handleFatalFailure({ match: block, record: null, retry: async () => ({ ok: false }) });
      await settle(10);
      eq([env3.uv.repairs, env3.panels().length], [0, 1], 'without autoRepair the panel waits for the user');
      env3.t.setQuitting(true); env3.ipcMain.emit('retry-startup'); await settle(); await done3;
    } finally {
      Object.defineProperty(process, 'platform', platformDesc);
    }
  }

  // ── Export logs: the zip lands where the user chose ─────────────────────
  {
    const env = load();
    fs.mkdirSync(path.join(env.HOME, '.flow', 'logs', 'main_desktop'), { recursive: true });
    fs.writeFileSync(path.join(env.HOME, '.flow', 'logs', 'main_desktop', 'a.log'), 'desktop log line\n');
    env.writeRecord();
    const r = await env.t.exportDiagnostics('shown error');
    eq([r.ok, r.zipPath], [true, path.join(env.HOME, 'exported.zip')], 'saved at the chosen path');
    ok(fs.existsSync(r.zipPath) && fs.statSync(r.zipPath).size > 100, 'a real zip');
    ok(r.included.includes('desktop'), 'with the desktop log');
    eq(env.saveDialogs[0].filters[0].extensions, ['zip'], 'a zip save dialog');
    const c = load({ cancelSave: true });
    eq(await c.t.exportDiagnostics('x'), { ok: false, canceled: true }, 'cancel → nothing written');
  }

  console.log(`main-recovery-flow.test.js: ${passed} assertions passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
