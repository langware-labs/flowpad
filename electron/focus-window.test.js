'use strict';

/*
 * The hub asked this desktop to open a message (its email landing page): the renderer sends `focus-window`,
 * and the REAL main.js brings the window forward — restored if minimized, shown if hidden, focused.
 * Loaded with stubs for Electron the way open-external.test.js does it.
 * Run: `node electron/focus-window.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const MAIN = path.join(__dirname, 'main.js');

function load() {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mainfocus-'));
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  global.setInterval = (fn, ms) => ({ fn, ms, unref() {} });

  const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 'stub' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk(), set: () => true });
  const BW = function () {}; BW.getAllWindows = () => []; BW.getFocusedWindow = () => null;
  const handlers = {};
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => { handlers[channel] = fn; };
  const opened = [];
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, setAsDefaultProtocolClient() {}, getPath: () => HOME, whenReady: () => new Promise(() => {}),
      on() {}, isPackaged: true, getVersion: () => '0.2.47', quit() {}, exit() {}, commandLine: { appendSwitch() {} }, setName() {}, setAppUserModelId() {},
    },
    BrowserWindow: BW,
    dialog: mk(),
    ipcMain,
    shell: { openExternal: async (url) => { opened.push(url); } },
    clipboard: mk(), Menu: mk(), nativeImage: mk(), session: mk(), screen: mk(), Tray: mk(), globalShortcut: mk(), powerMonitor: mk(), protocol: mk(), net: mk(), desktopCapturer: mk(), systemPreferences: mk(), Notification: mk(),
  };
  const log = { info() {}, warn() {}, error() {}, transports: { file: {}, console: {} }, hooks: [] };
  const Uv = function () {}; Uv.getPythonVersion = () => '3.11'; Uv.upgradeCommand = () => ''; Uv.PYPI_PACKAGE = 'flowpad';

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return electron;
    if (request === 'electron-updater') return { autoUpdater: new EventEmitter(), CancellationToken: function () {} };
    if (request === 'electron-log/main' || request === 'electron-log') return log;
    if (request === 'electron-store') return mk();
    if (request === './uv-manager') return Uv;
    return origLoad.apply(this, arguments);
  };
  let exposed;
  const realProcessOn = process.on;
  process.on = function (ev, fn) { if (ev === 'uncaughtException' || ev === 'unhandledRejection') return process; return realProcessOn.call(process, ev, fn); };
  try {
    const m = new Module(MAIN, null);
    m.filename = MAIN; m.paths = Module._nodeModulePaths(path.dirname(MAIN));
    m._compile(fs.readFileSync(MAIN, 'utf8') + '\nmodule.exports.__t = { setMainWindow: (w) => { mainWindow = w; } };', MAIN);
    exposed = m.exports.__t;
  } finally { process.on = realProcessOn; }
  // The handler asks for `electron` when it runs, so the stub stays until the test is over.
  return { ipcMain, exposed, restore: () => { Module._load = origLoad; } };
}

function fakeWindow({ minimized = false, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
}

(() => {
  const { ipcMain, exposed, restore } = load();
  assert.ok(ipcMain.listenerCount('focus-window') === 1, 'main.js listens for focus-window');

  ipcMain.emit('focus-window', {});
  // No window yet: nothing to do, and nothing throws.

  const hidden = fakeWindow();
  exposed.setMainWindow(hidden);
  ipcMain.emit('focus-window', {});
  assert.deepStrictEqual(hidden.calls, ['show', 'focus'], 'a window behind others is shown and focused');

  const minimized = fakeWindow({ minimized: true });
  exposed.setMainWindow(minimized);
  ipcMain.emit('focus-window', {});
  assert.deepStrictEqual(minimized.calls, ['restore', 'show', 'focus'], 'a minimized window is restored first');

  const gone = fakeWindow({ destroyed: true });
  exposed.setMainWindow(gone);
  ipcMain.emit('focus-window', {});
  assert.deepStrictEqual(gone.calls, [], 'a destroyed window is left alone');

  restore();
  console.log('focus-window: 4 checks passed');
  process.exit(0);
})();
