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
 * The updater reports those failures as an `error` event, not a throw, so the caller wires that
 * event to failed(). Dependencies are injected so the sequencing is unit-testable (main.js is not).
 */

/**
 * @param {object} deps
 * @param {{stop: () => Promise<any>}} deps.uvManager
 * @param {{quitAndInstall: (silent: boolean, forceRun: boolean) => void}} deps.autoUpdater
 * @param {(v: boolean) => void} deps.setQuitting   set/clear main's isQuitting
 * @param {() => void} deps.hideWindow
 * @param {() => void} deps.showWindow
 * @param {() => void} [deps.notifyInstalling]  an OS toast: the silent installer shows no window for ~30s, and the app is gone by then
 * @param {(err: Error) => void} deps.onFailure     tell the user; the app is running again
 * @param {{info: Function, warn: Function}} deps.log
 */
function createRestartApplier({ uvManager, autoUpdater, setQuitting, hideWindow, showWindow, notifyInstalling, onFailure, log }) {
  let busy = false;

  async function apply() {
    if (busy) return false; // a second click / prompt must not run the sequence twice
    busy = true;
    setQuitting(true);
    hideWindow();
    try { if (notifyInstalling) notifyInstalling(); } catch (err) { log.warn(`[update-restart] notification failed: ${err && err.message}`); }
    try {
      // Same stop before-quit's shutdown runs — bounded by the budgets UvManager.stop() carries.
      if (uvManager) await uvManager.stop();
    } catch (err) {
      log.warn(`[update-restart] backend stop failed, installing anyway: ${err && err.message}`);
    }
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (err) {
      failed(err);
    }
    return true;
  }

  /** The updater said it could not install/restart (its `error` event, or a throw above). */
  function failed(err) {
    if (!busy) return false; // an ordinary background updater error is not ours to handle
    busy = false;
    setQuitting(false);
    showWindow();
    try { onFailure(err); } catch (e) { log.warn(`[update-restart] onFailure threw: ${e && e.message}`); }
    return true;
  }

  return { apply, failed, get busy() { return busy; } };
}

module.exports = { createRestartApplier };
