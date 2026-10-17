'use strict';

/*
 * The shape of an update when the desktop app AND the engine both have a new version — kept out of main.js,
 * which cannot be unit-tested, as pure decisions plus two tiny stateful helpers.
 *
 *   engine only        → today's "Update available" dialog (Upgrade / Later), unchanged.
 *   desktop only       → download in the background, ask to restart when ready (unchanged).
 *   desktop + engine   → ONE screen (Update now / Later). The engine version on offer (X) is SAVED; the desktop is
 *                        downloaded in the background and the engine is NOT touched by the old desktop. After the
 *                        restart, the NEW desktop installs exactly X — but only if the user agreed to restart.
 *
 * "Update now" asks for the restart as soon as the download is done; "Later" waits and asks every 90 minutes.
 * Why the engine waits for the new desktop: a new engine can need things only the new desktop knows (a newer Python
 * pin, a changed start contract), and an old desktop upgrading the engine first is what left users stuck.
 */

// How often "the update is ready — restart now?" is offered again to a user who said Later (user-decided: 90 min).
const READY_REMINDER_MS = 90 * 60 * 1000;

/** @returns {'none'|'engine'|'desktop'|'both'} */
function decideOffer({ desktopLatest, engineStatus }) {
  if (desktopLatest && engineStatus) return 'both';
  if (desktopLatest) return 'desktop';
  if (engineStatus) return 'engine';
  return 'none';
}

// ── may the RUNNING desktop change the engine? ──────────────────────────────

/**
 * The desktop is the stronger channel: the engine is changed (upgraded, installed, repaired) by the running
 * desktop only when no newer desktop is waiting — a new engine can need things only the new desktop knows.
 *
 * @param {{state: 'available'|'current'|'unknown'|'unsupported'}} desktop  what the update check found:
 *   available   — a desktop newer than the running one exists (downloaded or not, "Later" or not)
 *   current     — running the latest desktop
 *   unsupported — nothing to update: a dev run, the Microsoft Store build (the Store delivers desktops)
 *   unknown     — the check failed or timed out: we cannot tell that no newer desktop exists
 * @param {boolean} mustInstall  the app cannot run without an engine (first-time install, repair of a broken one)
 * @returns {'allow'|'hold'|'desktop-first'}
 *   allow         — change the engine as asked
 *   hold          — leave the engine alone: no prompt, no upgrade
 *   desktop-first — update the desktop, then install the engine with the NEW desktop
 * An engine that must be installed is never held back by an UNKNOWN desktop status: a missing engine is worse
 * than a version gap, and there is no newer desktop we know of to wait for.
 */
function engineChangePolicy({ desktop, mustInstall = false }) {
  const state = desktop && desktop.state;
  if (state === 'current' || state === 'unsupported') return 'allow';
  if (state === 'available') return mustInstall ? 'desktop-first' : 'hold';
  return mustInstall ? 'allow' : 'hold'; // 'unknown' and anything unrecognised
}

// ── the engine version saved for the new desktop to install ─────────────────

/** Remember which engine version was offered alongside `desktopVersion`. Consent comes later (see markConsented). */
function savePendingEngine(store, { engineVersion, desktopVersion, now = new Date() }) {
  store.write({ engineVersion, desktopVersion, savedAt: now.toISOString(), consented: false });
}

/** The user agreed to restart into the new desktop: installing the saved engine version afterwards is agreed too. */
function markPendingEngineConsented(store) {
  const state = store.read();
  if (!state || !state.engineVersion) return false;
  store.write({ ...state, consented: true });
  return true;
}

/**
 * What the freshly started desktop does about a saved engine version.
 * @param {{state: object|null, appVersion: string, installedEngine: string|null, isNewer: (current: string, latest: string) => boolean}} a
 * @returns {{action: 'none'|'dialog'|'install', version?: string, clear: boolean}}
 *   'install' — the user agreed: install exactly `version`, silently.
 *   'dialog'  — the desktop was updated without an answer (closed after "Later"): fall back to today's engine dialog.
 *   'none'    — nothing to do. `clear` says whether the saved state is spent.
 */
function planAfterDesktopUpdate({ state, appVersion, installedEngine, isNewer }) {
  if (!state || !state.engineVersion) return { action: 'none', clear: false };
  // The desktop update it was saved for has not been applied yet (still the old build): keep waiting.
  if (state.desktopVersion && isNewer(appVersion, state.desktopVersion)) return { action: 'none', clear: false };
  if (!state.consented) return { action: 'dialog', clear: true };
  if (installedEngine && !isNewer(installedEngine, state.engineVersion)) return { action: 'none', clear: true };
  return { action: 'install', version: state.engineVersion, clear: true };
}

// ── the periodic "update ready" reminder ────────────────────────────────────

/**
 * Re-offers the ready prompt every `intervalMs`. A tick that finds the update not ready yet (still downloading, or
 * another dialog open) marks the reminder DUE, and notifyReady() shows it the moment the update is ready.
 *
 * @param {object} o
 * @param {() => boolean} o.isReady   a downloaded update exists and nothing else is in the way
 * @param {() => void} o.show         put the ready prompt on screen
 * @param {number} [o.intervalMs]
 * @param {{setInterval: Function, clearInterval: Function}} [o.timers]  injectable for tests
 */
function createReadyReminder({ isReady, show, intervalMs = READY_REMINDER_MS, timers }) {
  const t = timers || { setInterval, clearInterval };
  let handle = null;
  let due = false;

  function tick() {
    if (isReady()) { due = false; show(); } else { due = true; }
  }

  return {
    /** Start the periodic reminder (idempotent). The first reminder comes after `intervalMs`. */
    start() {
      if (handle !== null) return;
      handle = t.setInterval(tick, intervalMs);
      if (handle && typeof handle.unref === 'function') handle.unref(); // never keeps the app alive
    },
    stop() {
      if (handle !== null) { t.clearInterval(handle); handle = null; }
      due = false;
    },
    /** Call when the download finished: shows the prompt now if a reminder came due while it was not ready. */
    notifyReady() {
      if (due && isReady()) { due = false; show(); }
    },
    get running() { return handle !== null; },
    get due() { return due; },
  };
}

module.exports = {
  READY_REMINDER_MS,
  decideOffer,
  engineChangePolicy,
  savePendingEngine,
  markPendingEngineConsented,
  planAfterDesktopUpdate,
  createReadyReminder,
};
