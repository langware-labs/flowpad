'use strict';

/*
 * The last hop of an app's outside link (the SDK's `openExternal`): the REAL main.js `open-external`
 * IPC handler, loaded with stubs for Electron and friends the way main-recovery-flow.test.js does it.
 * An http(s) address reaches the system browser (shell.openExternal); anything else never does.
 * Run: `node electron/open-external.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const MAIN = path.join(__dirname, 'main.js');

function load() {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mainext-'));
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
  const realProcessOn = process.on;
  process.on = function (ev, fn) { if (ev === 'uncaughtException' || ev === 'unhandledRejection') return process; return realProcessOn.call(process, ev, fn); };
  try {
    const m = new Module(MAIN, null);
    m.filename = MAIN; m.paths = Module._nodeModulePaths(path.dirname(MAIN));
    m._compile(fs.readFileSync(MAIN, 'utf8'), MAIN);
  } finally { process.on = realProcessOn; }
  // The handler asks for `electron` when it runs, so the stub stays until the test is over.
  return { handler: handlers['open-external'], opened, restore: () => { Module._load = origLoad; } };
}

(async () => {
  const { handler, opened, restore } = load();
  assert.ok(typeof handler === 'function', 'main.js registers the open-external handler');

  const crm = 'https://crm.example.com/object/person/42';
  assert.strictEqual(await handler({}, crm), true);
  assert.strictEqual(await handler({}, 'http://localhost:3000/deal/7'), true);
  assert.deepStrictEqual(opened, [crm, 'http://localhost:3000/deal/7'], 'an http(s) address reaches the system browser');

  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', '/dock/home', '', null, undefined, { url: crm }]) {
    assert.strictEqual(await handler({}, bad), false, `refused: ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(opened.length, 2, 'nothing else was opened');

  restore();
  console.log('open-external: 12 checks passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
