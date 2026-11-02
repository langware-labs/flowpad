'use strict';

/*
 * The decisions of a coordinated update (desktop + engine) — kept out of main.js, which cannot be unit-tested,
 * as pure decisions plus two tiny stateful helpers.
 *
 * A newer desktop is downloaded together with the engine version chosen for it (X); the engine is NOT touched by
 * the old desktop. The pair is saved and agreed when the update starts (the user is asked only once, when both
 * are ready — "now or later" — and either way the next start runs them), so after the restart the NEW desktop
 * installs exactly X.
 * Why the engine waits for the new desktop: a new engine can need things only the new desktop knows (a newer Python
 * pin, a changed start contract), and an old desktop upgrading the engine first is what left users stuck.
 */

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

/** Remember which engine version rides along with `desktopVersion`. Consent is marked separately (markConsented).
 *  `source: 'panel'` marks a coordinated update of the in-app flow (an automatic check or a panel click), so the
 *  new desktop reports the resumed engine install back to the app. */
function savePendingEngine(store, { engineVersion, desktopVersion, source = null, now = new Date() }) {
  store.write({ engineVersion, desktopVersion, source, savedAt: now.toISOString(), consented: false });
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
 * @returns {{action: 'none'|'dialog'|'install', version?: string, clear: boolean, source: string|null}}
 *   'install' — the user agreed: install exactly `version`, silently.
 *   'dialog'  — the desktop was updated without an answer (closed after "Later"): fall back to today's engine dialog.
 *   'none'    — nothing to do. `clear` says whether the saved state is spent.
 *   `source` echoes where the pending update came from ('panel' = the UI's version panel), so a panel-initiated
 *   resume can report its outcome back to the panel. Records saved before the field existed carry null.
 */
function planAfterDesktopUpdate({ state, appVersion, installedEngine, isNewer }) {
  const source = (state && state.source) || null;
  if (!state || !state.engineVersion) return { action: 'none', clear: false, source };
  // The desktop update it was saved for has not been applied yet (still the old build): keep waiting.
  if (state.desktopVersion && isNewer(appVersion, state.desktopVersion)) return { action: 'none', clear: false, source };
  // Installed, not yet proven healthy: the record carries previousEngine, and only the health gate
  // spends it (healthy → clear, never healthy → restore). A re-run of the startup (Retry after an
  // unrelated failure, or a relaunch after a kill) must not erase the one way back.
  if (state.phase === 'installed') return { action: 'none', clear: false, source };
  // A rolled-back install: the record is now the veto on offering that version again (main.js
  // honorFailedEngineVersion) — it must not be cleared as an unanswered offer.
  if (state.phase === 'failed-unhealthy') return { action: 'none', clear: false, source };
  if (!state.consented) return { action: 'dialog', clear: true, source };
  if (installedEngine && !isNewer(installedEngine, state.engineVersion)) return { action: 'none', clear: true, source };
  return { action: 'install', version: state.engineVersion, clear: true, source };
}

/**
 * The agreed-engine record at the health gate — the ONE place it is spent. `healthy`: the backend
 * answered. Returns 'spend' (installed and answering: done), 'restore' (installed, never answered, and
 * the previous engine is known: put it back) or 'keep' (nothing installed by this flow).
 */
function engineRecordAtHealthGate(state, { healthy }) {
  if (!state || state.phase !== 'installed') return 'keep';
  if (healthy) return 'spend';
  return state.previousEngine ? 'restore' : 'keep';
}

module.exports = {
  engineRecordAtHealthGate,
  engineChangePolicy,
  savePendingEngine,
  markPendingEngineConsented,
  planAfterDesktopUpdate,
};
