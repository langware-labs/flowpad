'use strict';

/*
 * The quit → relaunch handoff.
 *
 * `flow stop` takes the instance lifecycle lock (connection-service.lock) and
 * holds it for the whole kill sequence — up to 5s per process, because the
 * backend's kill_process waits out SIGTERM before SIGKILL. `flow start` takes
 * that SAME lock with timeout=0, so a start issued while a stop is still
 * running dies with:
 *
 *     service_busy: Instance '<name>' is temporarily owned
 *
 * Exiting the app on a fixed timer while its `flow stop` child is still running
 * is what puts a start into that window: a non-detached execFile child is
 * REPARENTED when its parent exits, not killed, so the lock outlives the app
 * that owns it and the next launch collides with it.
 *
 * So the app owns its shutdown to the end — it exits only once the backend stop
 * has actually finished. That is bounded by budgets UvManager.stop() already
 * carries on its own subprocess calls (`flow stop` runs under an execFile
 * timeout, the port kills under theirs), so quitting cannot hang here; no new
 * wait is introduced.
 *
 * The window is hidden before this runs, so the user still sees an instant
 * close. A launch that arrives while we are stopping would otherwise be dropped
 * by the single-instance lock, so it is remembered and honoured by relaunching
 * ourselves once the stop is done.
 */

/**
 * @param {object} opts
 * @param {{stop: () => Promise<any>}} opts.uvManager  backend lifecycle owner
 * @param {{info: Function, warn: Function, error: Function}} opts.log
 * @param {(code: number) => void} opts.exit           app.exit
 * @param {() => void} opts.relaunch                   app.relaunch
 */
function createShutdown({ uvManager, log, exit, relaunch }) {
  let running = false;
  let relaunchRequested = false;

  return {
    isRunning() {
      return running;
    },

    /**
     * Remember a launch that arrived while the backend stop is still running.
     * Returns true if it was absorbed (the caller must not start its own app),
     * false if there is no shutdown in flight and the caller should proceed.
     */
    requestRelaunch() {
      if (!running) return false;
      relaunchRequested = true;
      log.info('[shutdown] relaunch requested mid-stop — will relaunch after the stop finishes');
      return true;
    },

    /**
     * Stop the backend, then exit. Resolves after exit() has been called so a
     * caller (or a test) can await the whole handoff.
     */
    async run() {
      if (running) return;
      running = true;
      log.info('[shutdown] stopping backend before exit');
      try {
        await uvManager.stop();
        log.info('[shutdown] backend stop finished — the lifecycle lock is released');
      } catch (err) {
        // A failed stop must not strand the app: the lock is released when the
        // stop process dies either way.
        log.error(`[shutdown] backend stop failed: ${err && err.message}`);
      } finally {
        running = false;
        if (relaunchRequested) {
          log.info('[shutdown] relaunching after a clean stop');
          relaunch();
        }
        exit(0);
      }
    },
  };
}

/**
 * Relaunch the app, honouring a backend stop that is still in flight.
 *
 * The startup-timeout panel stops the backend fire-and-forget and leaves the
 * window up, so a reopen from there hits the same trap as the quit did:
 * relaunching immediately reparents that stop, and the fresh instance's
 * `flow start` collides with the lock it still holds. Waiting for the stop we
 * already started costs nothing new — it is the same call, just not abandoned.
 *
 * @param {object} opts
 * @param {Promise<any>|null} opts.pendingStop  in-flight backend stop, if any
 * @param {{info: Function, warn: Function}} opts.log
 * @param {() => void} opts.relaunch            app.relaunch
 * @param {(code: number) => void} opts.exit    app.exit
 */
async function relaunchAfterStop({ pendingStop, log, relaunch, exit }) {
  if (pendingStop) {
    log.info('[shutdown] waiting for the in-flight backend stop before relaunching');
    await pendingStop.catch(() => {});
  }
  relaunch();
  exit(0);
}

module.exports = { createShutdown, relaunchAfterStop };
