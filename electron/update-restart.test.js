'use strict';

/*
 * Tests for ./update-restart.js — the "Restart now" sequencing.
 * Run: `node electron/update-restart.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { createRestartApplier } = require('./update-restart');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

const silentLog = { info() {}, warn() {} };

function harness({ stop, quitAndInstall } = {}) {
  const calls = [];
  const h = {
    calls,
    quitting: null,
    failures: [],
  };
  h.applier = createRestartApplier({
    uvManager: { stop: stop || (async () => { calls.push('stop'); }) },
    autoUpdater: { quitAndInstall: quitAndInstall || ((s, f) => { calls.push(`quitAndInstall(${s},${f})`); }) },
    setQuitting: (v) => { h.quitting = v; calls.push(`quitting=${v}`); },
    hideWindow: () => calls.push('hide'),
    showWindow: () => calls.push('show'),
    notifyInstalling: () => calls.push('notify'),
    onFailure: (e) => { h.failures.push(e.message); calls.push('onFailure'); },
    log: silentLog,
  });
  return h;
}

(async () => {
  // The backend is stopped BEFORE the installer starts, silent + relaunch, window hidden first.
  {
    const h = harness();
    eq(await h.applier.apply(), true, 'apply runs');
    eq(h.calls, ['quitting=true', 'hide', 'notify', 'stop', 'quitAndInstall(true,true)'], 'order: flag, hide, tell the user, stop the backend, then quitAndInstall(silent, relaunch)');
    eq(h.applier.busy, true, 'busy until the app actually quits');
  }

  // The stop must have FINISHED when the installer starts (not just been started).
  {
    let stopped = false;
    const h = harness({
      stop: () => new Promise((r) => setTimeout(() => { stopped = true; r(); }, 20)),
      quitAndInstall: () => { h.calls.push(`quitAndInstall after stop finished=${stopped}`); },
    });
    await h.applier.apply();
    eq(h.calls[h.calls.length - 1], 'quitAndInstall after stop finished=true', 'quitAndInstall waits for the backend stop to complete');
  }

  // A failing stop must not block the update.
  {
    const h = harness({ stop: async () => { throw new Error('flow stop timed out'); } });
    await h.applier.apply();
    eq(h.calls.includes('quitAndInstall(true,true)'), true, 'a stop failure is logged and the installer still runs');
    eq(h.failures, [], 'a stop failure is not an update failure');
  }

  // The updater's `error` event after apply(): the app must come back to life.
  {
    const h = harness();
    await h.applier.apply();
    eq(h.applier.failed(new Error('ERR_UPDATER_...')), true, 'failed() handles an error while restarting');
    eq(h.quitting, false, 'isQuitting is cleared, so later quits stop the backend gracefully again');
    eq(h.calls.slice(-3), ['quitting=false', 'show', 'onFailure'], 'flag cleared, window shown, user told');
    eq(h.failures, ['ERR_UPDATER_...'], 'the error reaches the user-facing handler');
    eq(h.applier.busy, false, 'not busy any more — a new attempt is possible');
    eq(await h.applier.apply(), true, 'a retry after a failure runs again');
  }

  // quitAndInstall throwing synchronously takes the same path.
  {
    const h = harness({ quitAndInstall: () => { throw new Error('spawn EACCES'); } });
    await h.applier.apply();
    eq(h.quitting, false, 'a synchronous throw also clears isQuitting');
    eq(h.failures, ['spawn EACCES'], 'and is reported');
  }

  // An ordinary background updater error (no restart in progress) is not ours.
  {
    const h = harness();
    eq(h.applier.failed(new Error('network')), false, 'failed() ignores errors when no restart is in progress');
    eq(h.calls, [], 'and touches nothing (window, flag)');
  }

  // A second "Restart now" while one is in flight is ignored.
  {
    const h = harness();
    const first = h.applier.apply();
    eq(await h.applier.apply(), false, 'a concurrent second apply is ignored');
    await first;
    eq(h.calls.filter((c) => c === 'stop').length, 1, 'the backend is stopped once');
  }

  // No uvManager (dev run): still installs.
  {
    const calls = [];
    const a = createRestartApplier({
      uvManager: null,
      autoUpdater: { quitAndInstall: () => calls.push('qai') },
      setQuitting() {}, hideWindow() {}, showWindow() {}, onFailure() {}, log: silentLog,
    });
    await a.apply();
    eq(calls, ['qai'], 'works without a backend manager');
  }

  console.log(`update-restart.test.js: ${passed} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
