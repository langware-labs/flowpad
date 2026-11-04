'use strict';

/*
 * Screen recording wiring: the display-media handler answers with the first whole-screen
 * source (through the system picker), the macOS grant is read only on darwin, and the REAL
 * main.js IPC handlers route the grant and the settings pane (test-helpers/load-main.js).
 * Run: `node electron/screen-capture.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { loadMain } = require('./test-helpers/load-main');
const sc = require('./screen-capture');

const macPrefs = { systemPreferences: { getMediaAccessStatus: (kind) => (kind === 'screen' ? 'denied' : 'granted') } };

(async () => {
  let checks = 0;

  // --- the module on its own ---------------------------------------------------------------
  const calls = [];
  const session = { setDisplayMediaRequestHandler: (fn, opts) => calls.push({ fn, opts }) };
  const screen = { id: 'screen:0:0', name: 'Entire screen' };
  const capturer = { getSources: async (opts) => { calls.push({ getSources: opts }); return [screen, { id: 'screen:1:0' }]; } };
  const handler = sc.installScreenCapture(session, capturer, null);
  assert.strictEqual(calls[0].fn, handler, 'the handler is installed on the session'); checks++;
  assert.deepStrictEqual(calls[0].opts, { useSystemPicker: true }, 'the OS picker is preferred'); checks++;

  const answered = await new Promise((resolve) => handler({}, resolve));
  assert.deepStrictEqual(answered, { video: screen }, 'answers with the first whole-screen source'); checks++;
  assert.deepStrictEqual(calls[1].getSources, { types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }, 'asks for screens only, no thumbnails'); checks++;

  const empty = { getSources: async () => [] };
  const h2 = sc.installScreenCapture(session, empty, null);
  assert.deepStrictEqual(await new Promise((resolve) => h2({}, resolve)), {}, 'no screen → an empty answer (NotFoundError in the page)'); checks++;

  const broken = { getSources: async () => { throw new Error('no capturer'); } };
  const warned = [];
  const h3 = sc.installScreenCapture(session, broken, { warn: (m) => warned.push(m) });
  assert.deepStrictEqual(await new Promise((resolve) => h3({}, resolve)), {}, 'a capturer failure still answers'); checks++;
  assert.ok(warned[0].includes('no capturer'), 'and is logged'); checks++;

  const prefs = { getMediaAccessStatus: (kind) => (kind === 'screen' ? 'not-determined' : 'granted') };
  assert.strictEqual(sc.screenCaptureStatus(prefs, 'darwin'), 'not-determined', 'darwin reads the Screen Recording grant'); checks++;
  assert.strictEqual(sc.screenCaptureStatus(prefs, 'win32'), 'granted', 'Windows needs no grant'); checks++;
  assert.strictEqual(sc.screenCaptureStatus(prefs, 'linux'), 'granted', 'Linux needs no grant'); checks++;
  assert.strictEqual(sc.screenCaptureStatus({ getMediaAccessStatus: () => { throw new Error('x'); } }, 'darwin'), 'not-determined', 'a failing read is not-determined'); checks++;

  // --- the IPC handlers in main.js, on macOS -------------------------------------------------
  {
    const { handlers, opened, restore } = loadMain({ platform: 'darwin', electron: macPrefs });
    assert.strictEqual(typeof handlers['screen-capture-status'], 'function', 'main.js registers screen-capture-status'); checks++;
    assert.strictEqual(await handlers['screen-capture-status']({}), 'denied', 'the status IPC reads the screen grant'); checks++;
    assert.strictEqual(await handlers['open-screen-recording-settings']({}), true, 'the settings IPC opens the pane on macOS'); checks++;
    assert.deepStrictEqual(opened, [sc.SCREEN_RECORDING_SETTINGS_URL], 'the Screen & System Audio Recording pane'); checks++;
    restore();
  }
  // --- and on Windows ------------------------------------------------------------------------
  {
    const { handlers, opened, restore } = loadMain({ platform: 'win32', electron: macPrefs });
    assert.strictEqual(await handlers['screen-capture-status']({}), 'granted', 'no grant to read on Windows'); checks++;
    assert.strictEqual(await handlers['open-screen-recording-settings']({}), false, 'no pane to open on Windows'); checks++;
    assert.deepStrictEqual(opened, [], 'nothing opened'); checks++;
    restore();
  }

  console.log(`screen-capture: ${checks} checks passed`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
