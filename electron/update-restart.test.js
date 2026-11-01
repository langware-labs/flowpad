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

function harness({ stop, quitAndInstall, lateFailurePoisons } = {}) {
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
    onFailure: (e, info) => { h.failures.push(e.message); h.late = info && info.late; calls.push('onFailure'); },
    log: silentLog,
    ...(lateFailurePoisons ? { lateFailurePoisons } : {}),
  });
  return h;
}

(async () => {
  const tick = () => new Promise((r) => setImmediate(r));

  // The backend is stopped BEFORE the installer starts, silent + relaunch, window hidden first —
  // and apply() resolves only when the quit really begins.
  {
    const h = harness();
    const outcome = h.applier.apply();
    await tick();
    eq(h.calls, ['quitting=true', 'hide', 'notify', 'stop', 'quitAndInstall(true,true)'], 'order: flag, hide, tell the user, stop the backend, then quitAndInstall(silent, relaunch)');
    eq(h.applier.busy, true, 'busy until the app actually quits');
    eq(h.applier.quitStarted(), true, "before-quit: the quit the installer needs has begun");
    eq(await outcome, 'quitting', "apply() resolves 'quitting' — the real outcome, not \"quitAndInstall was called\"");
    eq(h.applier.busy, true, 'still busy: the app is going away');
    eq(h.applier.failed(new Error('late spawn error')), false, 'an error after the quit began restores nothing');
    eq(h.calls.includes('show'), false, 'the window is not brought back mid-quit');
  }

  // The stop must have FINISHED when the installer starts (not just been started).
  {
    let stopped = false;
    const h = harness({
      stop: () => new Promise((r) => setTimeout(() => { stopped = true; r(); }, 20)),
      quitAndInstall: () => { h.calls.push(`quitAndInstall after stop finished=${stopped}`); h.applier.quitStarted(); },
    });
    await h.applier.apply();
    eq(h.calls[h.calls.length - 1], 'quitAndInstall after stop finished=true', 'quitAndInstall waits for the backend stop to complete');
  }

  // A failing stop must not block the update.
  {
    const h = harness({ stop: async () => { throw new Error('flow stop timed out'); }, quitAndInstall: () => { h.calls.push('qai'); h.applier.quitStarted(); } });
    eq(await h.applier.apply(), 'quitting', 'a stop failure is logged and the installer still runs');
    eq(h.failures, [], 'a stop failure is not an update failure');
  }

  // The updater's `error` event after quitAndInstall (Squirrel, an async NSIS spawn error): the app
  // comes back to life, and the awaiting caller learns it FAILED — not that the app is quitting.
  {
    const h = harness();
    const outcome = h.applier.apply();
    await tick();
    eq(h.applier.failed(new Error('ERR_UPDATER_...')), true, 'failed() handles an error while restarting');
    eq(await outcome, 'failed', "apply() resolves 'failed'");
    eq(h.quitting, false, 'isQuitting is cleared, so later quits stop the backend gracefully again');
    eq(h.calls.slice(-3), ['quitting=false', 'show', 'onFailure'], 'flag cleared, window shown, user told');
    eq(h.failures, ['ERR_UPDATER_...'], 'the error reaches the user-facing handler');
    eq(h.applier.busy, false, 'not busy any more');
    eq(h.late, true, 'onFailure is told the failure came AFTER quitAndInstall returned');
    // electron-updater keeps its "already installing" flag after a late failure: another quitAndInstall
    // in this process is skipped silently — an apply would wait for ever behind a hidden window.
    eq(await h.applier.apply(), 'restart-required', 'a retry in the same process answers restart-required');
    eq(h.calls.filter((c) => c.startsWith('quitAndInstall')).length, 1, '…and never calls quitAndInstall again');
    eq(h.applier.restartRequired, true, 'restartRequired is reported');
  }

  // The library had queued app.quit() for the install that then failed late: that ONE quit is
  // swallowed (no "Quit FlowPad?" right after the failure dialog) — and only that one.
  {
    const deferred = [];
    const calls = [];
    const a = createRestartApplier({
      uvManager: null,
      autoUpdater: { quitAndInstall: () => calls.push('qai') },
      setQuitting() {}, hideWindow() {}, showWindow() {}, onFailure() {}, log: silentLog,
      defer: (fn) => deferred.push(fn),
    });
    const outcome = a.apply();
    await tick();
    a.failed(new Error('spawn EPERM'));
    eq(await outcome, 'failed', 'late failure: failed');
    eq(a.consumeScheduledQuit(), true, "the library's scheduled quit is cancelled");
    eq(a.consumeScheduledQuit(), false, 'once');
    a.failed(new Error('noise'));
    deferred.forEach((fn) => fn());
    eq(a.consumeScheduledQuit(), false, 'a later quit (the next turn) is the user\'s own');
  }

  // macOS: MacUpdater keeps no such flag and queues no quit — a late Squirrel failure is handled by
  // downloading again, and the applier stays usable.
  {
    const h = harness({ lateFailurePoisons: () => false });
    const outcome = h.applier.apply();
    await tick();
    h.applier.failed(new Error('Squirrel could not install'));
    eq(await outcome, 'failed', 'macOS late failure: failed');
    eq(h.late, false, 'not reported as a poisoning failure');
    eq(h.applier.consumeScheduledQuit(), false, 'no quit to swallow');
    const retry = h.applier.apply();
    await tick();
    eq(h.applier.quitStarted(), true, 'a retry after a failure runs again');
    eq(await retry, 'quitting', 'and can succeed');
  }

  // An updater error while the backend is still STOPPING is not ours: quitAndInstall was not called
  // yet (a periodic feed check failing at that moment must not abort the install).
  {
    let releaseStop;
    const h = harness({ stop: () => new Promise((r) => { releaseStop = r; }) });
    const outcome = h.applier.apply();
    await tick();
    eq(h.applier.failed(new Error('feed check failed')), false, 'noise during the stop is ignored');
    eq(h.calls.includes('show'), false, 'and the window stays hidden');
    releaseStop();
    await tick();
    eq(h.calls[h.calls.length - 1], 'quitAndInstall(true,true)', 'the install still starts');
    h.applier.quitStarted();
    eq(await outcome, 'quitting', 'and the outcome is the real one');
  }

  // quitAndInstall throwing synchronously takes the same path.
  {
    const h = harness({ quitAndInstall: () => { throw new Error('spawn EACCES'); } });
    eq(await h.applier.apply(), 'failed', 'a synchronous throw resolves failed');
    eq(h.quitting, false, 'a synchronous throw also clears isQuitting');
    eq(h.failures, ['spawn EACCES'], 'and is reported');
  }

  // An ordinary background updater error (no restart in progress) is not ours.
  {
    const h = harness();
    eq(h.applier.failed(new Error('network')), false, 'failed() ignores errors when no restart is in progress');
    eq(h.applier.quitStarted(), false, 'nor is an ordinary quit');
    eq(h.calls, [], 'and touches nothing (window, flag)');
  }

  // A second "Restart now" while one is in flight is ignored.
  {
    const h = harness();
    const first = h.applier.apply();
    eq(await h.applier.apply(), 'busy', 'a concurrent second apply is ignored');
    await tick();
    h.applier.quitStarted();
    await first;
    eq(h.calls.filter((c) => c === 'stop').length, 1, 'the backend is stopped once');
  }

  // keepWindow (the loading screen explains the restart): the window is NOT hidden before the quit.
  {
    const h = harness({ quitAndInstall: () => { h.calls.push('qai'); h.applier.quitStarted(); } });
    eq(await h.applier.apply({ keepWindow: true }), 'quitting', 'keepWindow: installs as usual');
    eq(h.calls.includes('hide'), false, 'keepWindow: the window stays on screen until the quit takes it');
  }

  // No uvManager (dev run): still installs.
  {
    const calls = [];
    const a = createRestartApplier({
      uvManager: null,
      autoUpdater: { quitAndInstall: () => { calls.push('qai'); a.quitStarted(); } },
      setQuitting() {}, hideWindow() {}, showWindow() {}, onFailure() {}, log: silentLog,
    });
    eq(await a.apply(), 'quitting', 'works without a backend manager');
    eq(calls, ['qai'], 'and installs');
  }

  console.log(`update-restart.test.js: ${passed} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
