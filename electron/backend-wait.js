'use strict';

/*
 * The startup gate — "is the backend up yet, and if not, is it still coming?"
 *
 * Health is polled every `intervalMs`. The base window (`maxChecks` polls) needs
 * no evidence: a healthy cold boot answers well inside it. Past the base window
 * the gate does NOT give up on the clock alone. It keeps polling for as long as
 * `logActivity` reports the boot is still moving. The caller decides what that
 * means; in main.js it is two sources, either of which counts: a line from
 * `flow start` (the launcher: CLI import, migrations, monitor spawn) on its
 * pipe, or new bytes in the SERVER log (the backend's own stderr). Both
 * processes report their own progress (flow_sdk/boot_progress.py writes one
 * `[boot] … phase=…` line per step forward and nothing while standing still),
 * so growth means "advanced" even during the import phase, which logs nothing
 * on its own. A hung or dead boot goes silent. Three things end the wait early:
 *
 *   stalled  — no activity for `stallChecks` polls in a row;
 *   hard-cap — `hardCapChecks` polls in total. The monitor restarts a backend
 *              that stays unhealthy, and every attempt opens a fresh log, so
 *              "the log is alive" alone must not hold the loading screen forever;
 *   aborted  — `aborted()` names a reason (the launcher exited non-zero): there
 *              is nothing to wait for, and the reason is the result.
 *
 * Why the SERVER log and not the monitor log: the monitor writes a warning on
 * every failed health check and on every restart it performs, so its log grows
 * fastest precisely when the backend is broken. Growth there is not liveness.
 *
 * Pure: the caller injects health, activity, sleep and clock, so the gate is
 * exercised without a backend or a filesystem (backend-wait.test.js).
 */

/**
 * The generic activity cursor: `read()` returns a value (a line count, a byte
 * count) and each call to the probe answers "did it change since the last
 * call?". Primed at construction so history does not count as activity.
 */
function createChangeProbe(read) {
  let seen = read();
  return function probe() {
    const current = read();
    const changed = current !== seen;
    seen = current;
    return changed;
  };
}

/**
 * A cursor over the newest server log. Each call answers "did the server log
 * change since the last call?" — a new newest file (the monitor restarted the
 * backend), more bytes in the same file, or a rewrite. The cursor is primed at
 * construction, so a log left over from a previous launch does not count as
 * activity on the first call.
 *
 * `newestLogFile` returns `{ path }` or null; `fileSize(path)` returns bytes
 * and may throw (the file vanished between discovery and stat).
 */
function createLogActivityProbe({ newestLogFile, fileSize }) {
  let seenPath = null;
  let seenSize = 0;

  function snapshot() {
    const newest = newestLogFile();
    if (!newest) return null;
    try {
      return { path: newest.path, size: fileSize(newest.path) };
    } catch {
      return null;
    }
  }

  const primed = snapshot();
  if (primed) {
    seenPath = primed.path;
    seenSize = primed.size;
  }

  return function probe() {
    const current = snapshot();
    if (!current) return false;
    const active = current.path !== seenPath || current.size !== seenSize;
    seenPath = current.path;
    seenSize = current.size;
    return active;
  };
}

/**
 * Poll `probeHealth` until it answers true.
 *
 * Resolves `{ ready, reason, extended, elapsedSec, checks }` where reason is
 * 'healthy' | 'timeout' (base window over, log already silent) | 'stalled'
 * (extended on log activity, then the log went quiet) | 'hard-cap' | whatever
 * string `aborted()` returned.
 *
 * `onExtended(elapsedSec)` fires once per `noticeEveryChecks` polls while the
 * gate is past the base window, so the caller can tell the user the wait is
 * deliberate and not a frozen screen.
 */
async function waitForBackend({
  probeHealth,
  logActivity = () => false,
  aborted = () => null,
  maxChecks,
  stallChecks,
  hardCapChecks,
  intervalMs,
  noticeEveryChecks = 20,
  onExtended = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = console,
}) {
  if (!(hardCapChecks >= maxChecks)) {
    throw new Error(`hardCapChecks (${hardCapChecks}) must be >= maxChecks (${maxChecks})`);
  }
  const startedAt = now();
  const elapsedSec = () => Math.round((now() - startedAt) / 1000);
  let lastActivityCheck = -1;
  let extended = false;
  let reason;
  let checks = 0;

  for (let i = 0; ; i++) {
    checks = i + 1;
    if (await probeHealth()) {
      reason = 'healthy';
      break;
    }
    const abortReason = aborted();
    if (abortReason) {
      reason = abortReason;
      break;
    }
    if (logActivity()) lastActivityCheck = i;

    if (checks >= maxChecks) {
      const silentFor = i - lastActivityCheck;
      if (silentFor >= stallChecks) {
        reason = extended ? 'stalled' : 'timeout';
        break;
      }
      if (checks >= hardCapChecks) {
        reason = 'hard-cap';
        break;
      }
      if (!extended) {
        extended = true;
        log.warn(
          `[backend-wait] base window (${checks} checks) over but the boot is still ` +
            `reporting progress — waiting while it keeps doing so`,
        );
      }
      if ((checks - maxChecks) % noticeEveryChecks === 0) onExtended(elapsedSec());
    }
    await sleep(intervalMs);
  }

  return { ready: reason === 'healthy', reason, extended, elapsedSec: elapsedSec(), checks };
}

module.exports = { waitForBackend, createLogActivityProbe, createChangeProbe };
