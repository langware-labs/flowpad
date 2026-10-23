'use strict';

/*
 * A hung-renderer watchdog. The page beats once a second (preload.js, a timer on the renderer's main
 * thread); a render loop or any other busy main thread stops the beats — measured on the 2026-10-23
 * freeze, where the timers went silent within ~3 s of the loop starting while the backend stayed healthy.
 *
 * Silence alone is not a hang: a hidden or minimized window, App Nap and system sleep throttle timers.
 * So silence is counted only while the window is on screen, and is CONFIRMED with a probe (a script the
 * renderer must run) before `onHang` fires; a probe that answers resets the clock.
 *
 * `onHang` fires once per arming; the caller re-arms after the recovery load.
 */

const DEFAULT_SILENCE_MS = 10 * 1000;
const DEFAULT_PROBE_MS = 3 * 1000;
const DEFAULT_TICK_MS = 2 * 1000;

/**
 * @param {object} o
 * @param {() => boolean} o.onScreen               the window is visible and not minimized
 * @param {(timeoutMs: number) => Promise<boolean>} o.probe  true = the renderer answered in time
 * @param {(info: {silentMs: number, source: string}) => void} o.onHang
 * @param {number} [o.silenceMs]
 * @param {number} [o.probeMs]
 * @param {number} [o.tickMs]
 * @param {() => number} [o.now]
 * @param {{setInterval: Function, clearInterval: Function}} [o.timers]
 */
function createRendererWatchdog({ onScreen, probe, onHang, silenceMs = DEFAULT_SILENCE_MS, probeMs = DEFAULT_PROBE_MS, tickMs = DEFAULT_TICK_MS, now = Date.now, timers }) {
  const t = timers || { setInterval, clearInterval };
  let armed = false;
  let lastBeat = now();
  let probing = false;
  let handle = null;

  function hang(source) {
    if (!armed) return;
    armed = false;
    onHang({ silentMs: now() - lastBeat, source });
  }

  async function tick() {
    if (!armed || probing) return;
    // Off screen, timers are throttled: silence there proves nothing, and the clock restarts on return.
    if (!onScreen()) { lastBeat = now(); return; }
    if (now() - lastBeat < silenceMs) return;
    probing = true;
    let answered = false;
    try { answered = await probe(probeMs); } catch { answered = false; }
    probing = false;
    if (answered) { lastBeat = now(); return; }
    hang('heartbeat');
  }

  return {
    /** The page's heartbeat arrived. */
    beat() { lastBeat = now(); },
    /** Start watching (after the app UI has loaded). */
    arm() {
      armed = true;
      lastBeat = now();
      if (handle === null) handle = t.setInterval(() => void tick(), tickMs);
    },
    /** Stop counting (recovery in progress, quitting). */
    disarm() { armed = false; },
    /** Another signal (Chromium's `unresponsive`) says the renderer is hung. */
    hang,
    stop() {
      armed = false;
      if (handle !== null) { t.clearInterval(handle); handle = null; }
    },
    /** For tests. */
    _tick: tick,
  };
}

module.exports = { createRendererWatchdog };
