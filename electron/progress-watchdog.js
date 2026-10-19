'use strict';

/*
 * A progress-based stall watchdog: NOT a wall-clock cap.
 *
 * Every `windowMs` it looks at a counter that changes whenever the watched work makes progress.
 * A window in which it did not change is a miss; `strikes` misses IN A ROW mean the work is stalled
 * (onStall fires once). Any change resets the miss count to zero, so a slow-but-moving download is
 * never interrupted, however long it takes — only silence is.
 *
 * Approved parameters (the user, 2026-09-30): 30 s windows, 3 in a row -> 90 s without a new byte.
 * They live here as the defaults so one place holds them; callers pass overrides only in tests.
 *
 * The sampler must be trustworthy: a counter that stays flat while work is really progressing would
 * kill a good download. Callers that cannot vouch for their signal must not arm the watchdog — or pass
 * `canStall`, which is asked at the moment a stall would be declared: while it says no, quiet windows
 * are not counted at all (used to establish trust at runtime, see uv-manager's tool-install guard).
 *
 * `sample` may return a Promise (a slow directory scan must not block the event loop); a tick that finds
 * the previous sample still running is skipped, never counted as a miss.
 */

const DEFAULT_WINDOW_MS = 30 * 1000;
const DEFAULT_STRIKES = 3;

/**
 * @param {object} o
 * @param {() => number|string} o.sample   value that CHANGES when the work progresses
 * @param {() => boolean} [o.canStall]     false = do not count quiet windows (signal not trusted yet)
 * @param {(info: {misses: number, windowMs: number, strikes: number}) => void} o.onStall
 * @param {number} [o.windowMs]
 * @param {number} [o.strikes]
 * @param {{setInterval: Function, clearInterval: Function}} [o.timers]  injectable for tests
 * @param {{info?: Function, warn?: Function}} [o.log]
 */
function createProgressWatchdog({ sample, onStall, canStall = () => true, windowMs = DEFAULT_WINDOW_MS, strikes = DEFAULT_STRIKES, timers, log }) {
  const t = timers || { setInterval, clearInterval };
  let last;
  let misses = 0;
  let handle = null;
  let done = false;

  let sampling = false;

  function stop() {
    done = true;
    if (handle !== null) { t.clearInterval(handle); handle = null; }
  }

  // The outcome of one window, given the sampled value (undefined = sampling failed).
  function settle(now) {
    if (done) return;
    if (now === undefined || now !== last) {
      if (now !== undefined) last = now;
      if (misses && log && log.info) log.info(`[watchdog] progress resumed after ${misses} quiet window(s)`);
      misses = 0;
      return;
    }
    if (!canStall()) { misses = 0; return; } // signal not trusted yet: silence proves nothing
    misses += 1;
    if (log && log.warn) log.warn(`[watchdog] no progress for ${misses} of ${strikes} window(s) of ${windowMs / 1000}s`);
    if (misses >= strikes) {
      stop();
      onStall({ misses, windowMs, strikes });
    }
  }

  function failed(err) {
    // Our own sampling failed: that says nothing about the work. Never count it as a stall.
    if (log && log.warn) log.warn(`[watchdog] sampling failed, treating as progress: ${err && err.message}`);
    settle(undefined);
  }

  // Take one sample. Returns the value synchronously, or a Promise of it.
  function read(then) {
    let r;
    try { r = sample(); } catch (err) { return then ? failed(err) : undefined; }
    if (r && typeof r.then === 'function') {
      if (!then) return undefined; // the baseline of an async sampler is taken below
      sampling = true;
      r.then((v) => { sampling = false; settle(v); }, (err) => { sampling = false; failed(err); });
      return undefined;
    }
    if (then) settle(r);
    return r;
  }

  function tick() {
    if (done || sampling) return; // a slow scan still running: skip this tick, do not count it
    read(true);
  }

  function start() {
    // Baseline. An async sampler's baseline is taken the same way, before the first window ends.
    let baseline;
    try { baseline = sample(); } catch { baseline = undefined; }
    if (baseline && typeof baseline.then === 'function') {
      sampling = true;
      baseline.then((v) => { sampling = false; if (last === undefined) last = v; }, () => { sampling = false; });
    } else {
      last = baseline;
    }
    handle = t.setInterval(tick, windowMs);
    if (handle && typeof handle.unref === 'function') handle.unref(); // never keeps the app alive
    return api;
  }

  const api = { start, stop, get misses() { return misses; } };
  return api;
}

module.exports = { createProgressWatchdog, DEFAULT_WINDOW_MS, DEFAULT_STRIKES };
