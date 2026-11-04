'use strict';

/*
 * Load the REAL main.js with Electron and friends stubbed, so a test can call the IPC
 * handlers it registers. `app.whenReady` never resolves, so no window is created; the
 * stubs are a recursive Proxy for anything a test does not care about.
 *
 *   const { handlers, opened, restore } = loadMain({ platform: 'darwin', electron: { systemPreferences } });
 *   await handlers['open-external']({}, url);
 *   restore();
 *
 * `electron` entries override the default stubs; `platform` overrides `process.platform`
 * for the load and for the handlers until `restore()`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const MAIN = path.join(__dirname, '..', 'main.js');

function mk() {
  return new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => 'stub' : k === 'then' ? undefined : mk()),
    apply: () => mk(),
    construct: () => mk(),
    set: () => true,
  });
}

function loadMain({ platform, electron: overrides = {} } = {}) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'main-'));
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  const realSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => ({ fn, ms, unref() {} });

  const BW = function () {}; BW.getAllWindows = () => []; BW.getFocusedWindow = () => null;
  const handlers = {};
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => { handlers[channel] = fn; };
  const opened = [];
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, setAsDefaultProtocolClient() {}, getPath: () => HOME, setPath() {}, whenReady: () => new Promise(() => {}),
      on() {}, isPackaged: true, getVersion: () => '0.2.47', quit() {}, exit() {}, commandLine: { appendSwitch() {} }, setName() {}, setAppUserModelId() {},
    },
    BrowserWindow: BW,
    dialog: mk(),
    ipcMain,
    shell: { openExternal: async (url) => { opened.push(url); } },
    clipboard: mk(), Menu: mk(), nativeImage: mk(), session: mk(), screen: mk(), Tray: mk(), globalShortcut: mk(), powerMonitor: mk(), protocol: mk(), net: mk(), desktopCapturer: mk(), systemPreferences: mk(), Notification: mk(),
    ...overrides,
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
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (platform) Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  const realProcessOn = process.on;
  process.on = function (ev, fn) { if (ev === 'uncaughtException' || ev === 'unhandledRejection') return process; return realProcessOn.call(process, ev, fn); };
  try {
    const m = new Module(MAIN, null);
    m.filename = MAIN; m.paths = Module._nodeModulePaths(path.dirname(MAIN));
    m._compile(fs.readFileSync(MAIN, 'utf8'), MAIN);
  } finally { process.on = realProcessOn; }
  // The handlers ask for `electron` when they run, so the stubs stay until `restore()`.
  const restore = () => {
    Module._load = origLoad;
    if (platform) Object.defineProperty(process, 'platform', realPlatform);
    global.setInterval = realSetInterval;
    process.env.HOME = env.HOME;
    process.env.USERPROFILE = env.USERPROFILE;
  };
  return { handlers, electron, opened, restore };
}

module.exports = { loadMain, mk };
