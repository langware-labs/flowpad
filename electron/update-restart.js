'use strict';

/*
 * "Restart now" after a desktop update: stop the backend, THEN hand over to the installer.
 *
 * quitAndInstall() spawns the installer and quits. Two things went wrong with calling it bare:
 *
 *  1. `isQuitting` was set first, so `before-quit` skipped the graceful backend stop: the backend,
 *     monitor and workers were left running across the update (and killed with a bare port kill by
 *     the next launch) — a SQLite write or a worker's session lock could be cut off.
 *  2. If quitAndInstall did not actually quit — no installer file, a cancelled pkexec, a spawn
 *     error, macOS Squirrel not staged yet — `isQuitting` stayed true for good: every later quit
 *     skipped the backend stop, and the user saw nothing happen.
 *
 * The updater reports those failures as an `error` event, not a throw — and on Windows (NSIS spawn)
 * and macOS (Squirrel) the event can arrive AFTER quitAndInstall returned. So apply() resolves with
 * the REAL outcome, not with "quitAndInstall was called":
 *   'quitting' — the app's quit began (main's before-quit calls quitStarted()); the installer has it.
 *   'failed'   — the updater's error event (wired to failed()) or a synchronous throw; the app is
 *                running again and onFailure has told the user.
 *   'busy'     — another apply is already in flight.
 *   'restart-required' — an earlier late failure poisoned the updater for this process (see below).
 * Updater errors count as ours only once quitAndInstall was called: an unrelated feed-check error
 * while the backend is still stopping must not abort an install that is about to start anyway.
 *
 * A failure that arrives AFTER quitAndInstall returned (Windows: the NSIS spawn fails asynchronously)
 * leaves electron-updater's internal "already installing" flag set: the next quitAndInstall in this
 * process is skipped silently — no error, no quit — and an apply would wait for ever behind a hidden
 * window. So from then on apply() answers 'restart-required' (a fresh process installs cleanly), and
 * the app.quit() the library had already scheduled for that failed install is swallowed once.
 * Dependencies are injected so the sequencing is unit-testable (main.js is not).
 */

/**
 * @param {object} deps
 * @param {{stop: () => Promise<any>}} deps.uvManager
 * @param {{quitAndInstall: (silent: boolean, forceRun: boolean) => void}} deps.autoUpdater
 * @param {(v: boolean) => void} deps.setQuitting   set/clear main's isQuitting
 * @param {() => void} deps.hideWindow
 * @param {() => void} deps.showWindow
 * @param {() => void} [deps.notifyInstalling]  an OS toast: the silent installer shows no window for ~30s, and the app is gone by then
 * @param {(err: Error, info: {late: boolean}) => void} deps.onFailure  tell the user; the app is running again.
 *   `late`: the failure came after quitAndInstall returned — this process cannot apply again (restart)
 * @param {{info: Function, warn: Function}} deps.log
 * @param {(fn: Function) => void} [deps.defer]  setImmediate (injectable for tests)
 * @param {() => boolean} [deps.lateFailurePoisons]  false for macOS: MacUpdater has no "already installing"
 *   flag and schedules no quit of its own — a late Squirrel failure is handled by downloading again
 */
function createRestartApplier({ uvManager, autoUpdater, setQuitting, hideWindow, showWindow, notifyInstalling, onFailure, log, defer = setImmediate, lateFailurePoisons = () => true }) {
  // null (idle) → 'stopping' (backend stop) → 'installing' (quitAndInstall called) → 'quitting'.
  let phase = null;
  let settle = null;
  let installReturned = false;   // quitAndInstall returned; a failure now arrives "late"
  let restartRequired = false;   // a late failure poisoned the updater for this process
  let swallowQuit = false;       // the library's quit scheduled for the failed install

  /** opts.keepWindow: the loading screen stays up (it explains the restart) until the quit takes it. */
  async function apply({ keepWindow = false } = {}) {
    if (phase) return 'busy'; // a second click / prompt must not run the sequence twice
    if (restartRequired) return 'restart-required';
    phase = 'stopping';
    installReturned = false;
    const outcome = new Promise((r) => { settle = r; });
    setQuitting(true);
    if (!keepWindow) hideWindow();
    try { if (notifyInstalling) notifyInstalling(); } catch (err) { log.warn(`[update-restart] notification failed: ${err && err.message}`); }
    try {
      // Same stop before-quit's shutdown runs — bounded by the budgets UvManager.stop() carries.
      if (uvManager) await uvManager.stop();
    } catch (err) {
      log.warn(`[update-restart] backend stop failed, installing anyway: ${err && err.message}`);
    }
    phase = 'installing';
    try {
      autoUpdater.quitAndInstall(true, true);
      installReturned = true;
    } catch (err) {
      failed(err);
    }
    return outcome;
  }

  /** main's before-quit, first: true when this quit is the one the library scheduled for an install
   *  that already failed — main cancels it (the user would get "Quit FlowPad?" right after the error). */
  function consumeScheduledQuit() {
    if (!swallowQuit) return false;
    swallowQuit = false;
    return true;
  }

  /** main's before-quit: the quit the installer needs has begun — apply() resolves 'quitting'. */
  function quitStarted() {
    if (phase !== 'installing') return false;
    phase = 'quitting';
    settle('quitting');
    return true;
  }

  /** The updater said it could not install/restart (its `error` event, or a throw above). */
  function failed(err) {
    if (phase === 'quitting') {
      // The app is already going away: nothing left to restore (the next launch sees the old version).
      log.warn(`[update-restart] updater error after the quit began: ${err && err.message}`);
      return false;
    }
    if (phase !== 'installing') return false; // a background updater error, or noise during the backend stop: not ours
    phase = null;
    const late = installReturned && lateFailurePoisons();
    if (late) {
      restartRequired = true;
      // The library queued its app.quit() with setImmediate when quitAndInstall returned; this
      // setImmediate runs after it, so the swallow covers exactly that quit and nothing later.
      swallowQuit = true;
      defer(() => { swallowQuit = false; });
    }
    setQuitting(false);
    showWindow();
    try { onFailure(err, { late }); } catch (e) { log.warn(`[update-restart] onFailure threw: ${e && e.message}`); }
    settle('failed');
    return true;
  }

  return { apply, failed, quitStarted, consumeScheduledQuit, get busy() { return phase !== null; }, get restartRequired() { return restartRequired; } };
}

module.exports = { createRestartApplier };
