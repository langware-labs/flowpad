'use strict';

/*
 * Desktop self-update as a RECOVERY route (FLOWPAD-2231), independent of the Python backend.
 *
 * The desktop updater (electron-updater, the verified GitHub feed, sha512 from latest.yml) never
 * needed the backend — but the check and the offer were threaded through the backend start
 * sequence, so a backend that could not start also hid the way out. This module is the pure
 * half of the fix: the decision "offer the update from the failure panel, or not", the persisted
 * attempt history that prevents an update/relaunch loop, and a bounded check that cannot hold
 * the recovery panel hostage to a slow or absent network.
 *
 * Loop prevention, the rules:
 *   - ONE recovery attempt per (target desktop version, failure fingerprint). A second failure of the
 *     same kind after installing that version is recovery mode, not another install.
 *   - The history is cleared only when a startup is confirmed healthy (markStartupHealthy), never by
 *     the install itself.
 *   - No downgrade: the offer requires `latest` newer than `appVersion`.
 *   - Nothing here downloads or installs: the caller uses the existing updater (the only verified path).
 */

const RECOVERY_FILE = 'desktop-recovery.json';

// How long the failure panel waits for the update check before showing "no update known": the
// check races the network; the panel never does.
const DEFAULT_CHECK_BOUND_MS = 20 * 1000;

function emptyState() { return { attempts: [] }; }

/** `readFile(path)` → text or throws. Garbage → empty state. */
function readRecoveryState(readFile, filePath) {
  try {
    const data = JSON.parse(readFile(filePath));
    if (data && Array.isArray(data.attempts)) return { attempts: data.attempts.filter((a) => a && typeof a === 'object') };
  } catch { /* fall through */ }
  return emptyState();
}

function writeRecoveryState(writeFile, filePath, state) {
  writeFile(filePath, JSON.stringify(state, null, 2));
}

function findAttempt(state, { targetVersion, fingerprint }) {
  return (state.attempts || []).find((a) => a.targetVersion === targetVersion && a.fingerprint === fingerprint) || null;
}

/**
 * Should the failure panel offer "Update FlowPad to <latest>"?
 * @returns {{action:'offer'|'none', version?:string, why?:string, prior?:object}}
 */
function planRecoveryUpdate({ state, appVersion, latestVersion, fingerprint, isNewer }) {
  if (!latestVersion) return { action: 'none', why: 'no-update' };
  if (!isNewer(appVersion, latestVersion)) return { action: 'none', why: 'not-newer' }; // never a downgrade
  const prior = findAttempt(state, { targetVersion: latestVersion, fingerprint });
  if (prior) return { action: 'none', why: 'already-attempted', prior };
  return { action: 'offer', version: latestVersion };
}

/** Record that the recovery update to `targetVersion` was started for this failure. Returns the new state. */
function recordRecoveryAttempt(state, { targetVersion, fingerprint, fromVersion, at = new Date().toISOString(), outcome = 'installing' }) {
  const attempts = (state.attempts || []).filter((a) => !(a.targetVersion === targetVersion && a.fingerprint === fingerprint));
  attempts.push({ targetVersion, fingerprint, fromVersion, at, outcome });
  return { attempts };
}

function markAttemptOutcome(state, { targetVersion, fingerprint, outcome, detail }) {
  const attempts = (state.attempts || []).map((a) =>
    a.targetVersion === targetVersion && (fingerprint === undefined || a.fingerprint === fingerprint)
      ? { ...a, outcome, ...(detail ? { detail } : {}) }
      : a,
  );
  return { attempts };
}

/**
 * The app just started: did a recovery install bring it here? An attempt whose target is the
 * running version and whose outcome is still 'installing' becomes 'installed' (the download and
 * relaunch completed); one for a DIFFERENT version that is still 'installing' was interrupted
 * (download or relaunch never finished) and becomes 'interrupted' — the offer may be made again
 * once, because nothing was installed.
 */
function afterRelaunch({ state, appVersion }) {
  let installed = null;
  const attempts = (state.attempts || []).map((a) => {
    if (a.outcome !== 'installing') return a;
    if (a.targetVersion === appVersion) { installed = { ...a, outcome: 'installed' }; return installed; }
    return { ...a, outcome: 'interrupted' };
  }).filter((a) => a.outcome !== 'interrupted');
  return { state: { attempts }, installed };
}

/** A startup reached a healthy backend: the failure history is spent. ONLY then. */
function markStartupHealthy() { return emptyState(); }

/**
 * Race an update check against a bound. Resolves to the check's value, or null on timeout or error
 * — never rejects, never waits past `ms`. `timers` injectable for tests.
 */
function boundedCheck(run, { ms = DEFAULT_CHECK_BOUND_MS, timers = { setTimeout, clearTimeout }, log } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value, why) => {
      if (done) return;
      done = true;
      timers.clearTimeout(handle);
      if (why && log) log.info(`[update-recovery] update check ${why}`);
      resolve(value);
    };
    const handle = timers.setTimeout(() => finish(null, `gave up after ${ms} ms (offline or slow feed) — the recovery panel does not wait`), ms);
    let p;
    try { p = Promise.resolve(run()); } catch (err) { finish(null, `threw: ${err && err.message}`); return; }
    p.then((v) => finish(v), (err) => finish(null, `failed: ${err && err.message}`));
  });
}

/** What the panel says about the update next to a fatal failure of `kind`. */
function recoveryNote(kind, version) {
  const head = version ? `FlowPad ${version} is available.` : 'No newer FlowPad version is available right now.';
  if (kind === 'policy-blocked' || kind === 'interpreter-blocked') {
    return `${head} A desktop update replaces the FlowPad app, not the Python runtime Windows blocked: ` +
      'after updating, “Repair FlowPad” is still needed unless the new version ships a different runtime.';
  }
  if (kind === 'native-missing' || kind === 'unsupported-arch' || kind === 'runtime-integrity') {
    return `${head} A desktop update may ship a corrected runtime; otherwise “Repair FlowPad” replaces it.`;
  }
  return `${head} If this failure started after an update, the newer version may contain the fix.`;
}

module.exports = {
  RECOVERY_FILE,
  DEFAULT_CHECK_BOUND_MS,
  readRecoveryState,
  writeRecoveryState,
  findAttempt,
  planRecoveryUpdate,
  recordRecoveryAttempt,
  markAttemptOutcome,
  afterRelaunch,
  markStartupHealthy,
  boundedCheck,
  recoveryNote,
};
