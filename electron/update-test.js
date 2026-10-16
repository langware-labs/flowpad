'use strict';

/*
 * Test-only instrumentation for the install/update cycle, driven by the Update Cycle Test workflow in
 * langware-labs/flowpad-desktop (scripts/update-cycle).
 *
 * Inert by default: unless the process is launched with FLOWPAD_UPDATE_TEST=1, answerFor() returns null (callers
 * then show the real native dialog), event() does nothing and forceRunAfter() passes its argument through — so
 * production behaviour is unchanged.
 *
 * In test mode:
 *
 *   FLOWPAD_UPDATE_TEST_ANSWERS scripts the update dialogs, e.g.
 *     FLOWPAD_UPDATE_TEST_ANSWERS="both=later,restart=later,engine=upgrade"
 *   Prompt ids (button 0 always accepts, 1 defers):
 *     move    — macOS: the app runs from a transient place     ("Move to Applications" / "Not now")
 *     both    — desktop + engine both have a new version   ("Update now" / "Later")
 *     restart — the desktop update is downloaded           ("Restart now" / "Later")
 *     engine  — an engine-only update                      ("Upgrade" / "Later")
 *   Accepted values: accept|update|upgrade|restart|yes|0 → button 0; anything else → button 1. An UNSCRIPTED
 *   prompt answers button 1 (defer), so a harness run can never hang on an unexpected native dialog.
 *
 *   Every prompt and lifecycle event is logged as one parseable line:
 *     [update-test] {"event":"prompt","prompt":"engine","answer":1,...}
 *   The harness reads them from the app's stdout.
 *
 *   FLOWPAD_UPDATE_CONFIG            alternate app-update.yml (a local `generic` feed) for electron-updater (main.js)
 *   FLOWPAD_PYPI_JSON_URL            alternate "latest flowpad" JSON in place of pypi.org (uv-manager.js)
 *   FLOWPAD_UPDATE_TEST_ENGINE_SPEC  what install/upgrade/repair resolve instead of `flowpad@latest` (uv-manager.js)
 *   FLOWPAD_UPDATE_TEST_CHECK_INTERVAL_MS  how often a running session re-checks both update channels (default 20 min),
 *                                    so a test can watch a held engine at a later tick without waiting (main.js)
 *   FLOWPAD_UPDATE_TEST_CHECK_BOUND_MS  how long the launch-time desktop update check may take before the app
 *                                    gives up on it (default 20 s). A CI runner can need longer; a check that
 *                                    gave up means no "Updates available" screen at that launch (main.js)
 *
 * forceRunAfter(): "Restart now" and the desktop-first install end in quitAndInstall(silent, relaunch). The
 * relaunched process is spawned with its output discarded, so in test mode the relaunch is skipped and the
 * harness starts the new build itself (keeping its output observable). Nothing else differs.
 */

const ACCEPT_WORDS = new Set(['accept', 'update', 'upgrade', 'restart', 'yes', '0']);

function isEnabled() {
  return process.env.FLOWPAD_UPDATE_TEST === '1';
}

/** "both=later,engine=accept" → { both: 'later', engine: 'accept' } */
function parseAnswers(raw) {
  const out = {};
  for (const part of String(raw || '').split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim().toLowerCase();
    if (key && value) out[key] = value;
  }
  return out;
}

// Resolved lazily so this module stays loadable from plain node (no Electron runtime);
// update-test.test.js injects its own sink via _setLogLine.
let logLine = null;

function emit(payload) {
  if (!logLine) {
    try {
      const electronLog = require('electron-log');
      logLine = (line) => electronLog.info(line);
    } catch {
      logLine = (line) => console.log(line);
    }
  }
  logLine(`[update-test] ${JSON.stringify(payload)}`);
}

function _setLogLine(fn) {
  logLine = fn;
}

/** Log a lifecycle event ({"event": name, ...data}). No-op outside test mode. */
function event(name, data = {}) {
  if (!isEnabled()) return;
  emit({ event: name, ...data });
}

/**
 * Scripted answer (button index) for an update dialog, or null when test mode is off — the caller must then
 * show the real dialog.
 */
function answerFor(prompt, data = {}) {
  if (!isEnabled()) return null;
  const scripted = parseAnswers(process.env.FLOWPAD_UPDATE_TEST_ANSWERS)[prompt];
  const answer = scripted !== undefined && ACCEPT_WORDS.has(scripted) ? 0 : 1;
  emit({ event: 'prompt', prompt, answer, scripted: scripted !== undefined, ...data });
  return answer;
}

/** The launch-time desktop check bound in ms, or undefined (the app's own default) outside test mode. */
function checkBoundMs() {
  const ms = Number(process.env.FLOWPAD_UPDATE_TEST_CHECK_BOUND_MS);
  return isEnabled() && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** The periodic re-check interval in ms, or undefined (the app's own default) outside test mode. */
function checkIntervalMs() {
  const ms = Number(process.env.FLOWPAD_UPDATE_TEST_CHECK_INTERVAL_MS);
  return isEnabled() && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** The `forceRunAfter` argument for quitAndInstall: off in test mode (the harness relaunches itself). */
function forceRunAfter(forceRun) {
  return isEnabled() ? false : forceRun;
}

module.exports = { isEnabled, answerFor, event, parseAnswers, forceRunAfter, checkBoundMs, checkIntervalMs, _setLogLine };
