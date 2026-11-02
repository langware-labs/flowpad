'use strict';

/*
 * When automatic update checks happen (FLOWPAD-2308) — the pure half, kept out of main.js the way
 * update-plan.js and update-recovery.js are. One schedule paces BOTH update channels: the desktop
 * app (electron-updater/GitHub) and the engine (PyPI) ride the same periodic pass.
 *
 * The cadence is per account: an @langware.ai login (the hub-validated email the backend writes to
 * the instance's config.json) checks every hour for early validation; everyone else — including a
 * logged-out app — once a day. The last answer and the failure streak are persisted
 * (update-schedule.json in userData), so a restart does not reset the cadence, and a failing feed is
 * retried on a growing backoff instead of hammered.
 *
 * main.js owns the timers and the fs; everything here is a decision on plain values. Manual checks,
 * recovery-mode checks and the update-cycle harness bypass the schedule at the call site — this
 * module only answers "is an AUTOMATIC check due?".
 */

const REGULAR_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INTERNAL_INTERVAL_MS = 60 * 60 * 1000;
const INTERNAL_DOMAIN = 'langware.ai';
const SCHEDULE_FILE = 'update-schedule.json';
// The tick only ASKS whether a check is due; the real cadence is the interval above.
const SCHEDULER_TICK_MS = 5 * 60 * 1000;
// Failed checks retry sooner than the interval (an outage must not cost a day), but never
// faster than this, doubling to the cap.
const BACKOFF_BASE_MS = 10 * 60 * 1000;
const BACKOFF_MAX_MS = 4 * 60 * 60 * 1000;

/** Exact-domain match: `a@langware.ai.evil.com` and `a@notlangware.ai` are NOT internal. */
function isInternalEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim(); // hand-edited configs carry stray whitespace
  const at = trimmed.lastIndexOf('@');
  return at > 0 && trimmed.slice(at + 1).toLowerCase() === INTERNAL_DOMAIN;
}

function intervalForEmail(email) {
  return isInternalEmail(email) ? INTERNAL_INTERVAL_MS : REGULAR_INTERVAL_MS;
}

/**
 * The hub-validated account email the backend keeps in the instance's config.json under "user"
 * (flow_sdk/cli/app_config.py), or null: logged out, no file, garbage. `readFile(path)` → text or throws.
 */
function readAccountEmail(readFile, configPath) {
  try {
    const user = JSON.parse(readFile(configPath)).user;
    return (user && typeof user.email === 'string' && user.email) || null;
  } catch { return null; }
}

/** `readFile(path)` → text or throws. Garbage → empty state (everything is then due). */
function readScheduleState(readFile, filePath) {
  try {
    const data = JSON.parse(readFile(filePath));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch { /* fall through */ }
  return {};
}

function writeScheduleState(writeFile, filePath, state) {
  writeFile(filePath, JSON.stringify(state, null, 2));
}

function backoffDelayMs(failureCount) {
  return Math.min(BACKOFF_BASE_MS * 2 ** (Math.max(1, failureCount) - 1), BACKOFF_MAX_MS);
}

// ISO timestamp → epoch ms, or null for garbage AND for the future (a clock set back must read
// as "long ago", never silence the schedule for days).
function pastMs(iso, now) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms <= now ? ms : null;
}

// For a BACKOFF anchor the clock-set-back rule inverts: an attempt stamped in the future reads as
// "just now" — keeping the delay — because reading it as "long ago" would collapse the backoff to
// every tick. Unparseable still reads as "long ago" (null → due now).
function attemptMs(iso, now) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.min(ms, now) : null;
}

/**
 * Is an automatic check due? While checks fail, the backoff is the cadence; otherwise `intervalMs`
 * after the last successful check. No usable history → due now.
 * @returns {{due: boolean, dueAt: number, reason: 'first-run'|'interval'|'backoff'|'not-due'}}
 */
function shouldAutoCheck({ state, intervalMs, now }) {
  const failures = Number(state.failureCount) || 0;
  if (failures > 0) {
    const attempted = attemptMs(state.lastAttemptAt, now);
    const dueAt = attempted === null ? now : attempted + backoffDelayMs(failures);
    return { due: now >= dueAt, dueAt, reason: now >= dueAt ? 'backoff' : 'not-due' };
  }
  const succeeded = pastMs(state.lastSuccessAt, now);
  if (succeeded === null) return { due: true, dueAt: now, reason: 'first-run' };
  const dueAt = succeeded + intervalMs;
  return { due: now >= dueAt, dueAt, reason: now >= dueAt ? 'interval' : 'not-due' };
}

/**
 * Run the launch-time check, or reuse the persisted answer? A restart must not reset the interval,
 * but engineChangePolicy (update-plan.js) holds the engine while the desktop status is 'unknown' —
 * so a skip SEEDS the status from the last successful answer instead of leaving it unanswered.
 * Skipped only for a recent 'current': a persisted 'available' re-checks (an update is pending: its
 * background download picks up where it is), 'unsupported' answers without the network,
 * and inside a failure backoff a RELAUNCH retries for real — leaving the status 'unknown' would
 * hold every engine update with no visible way out. The backoff keeps pacing the in-session ticks;
 * only a relaunch breaks it.
 * @returns {{run: boolean, reason: string, seed?: {state: 'current'}}}
 */
function planLaunchCheck({ state, intervalMs, now }) {
  const check = shouldAutoCheck({ state, intervalMs, now });
  if (check.due) return { run: true, reason: check.reason };
  if ((Number(state.failureCount) || 0) > 0) return { run: true, reason: 'launch-retry' };
  const last = state.lastResult || {};
  if (last.state === 'available') return { run: true, reason: 'update-pending' };
  if (last.state === 'unsupported') return { run: true, reason: 'unsupported' };
  if (last.state === 'current') return { run: false, reason: 'recent-check', seed: { state: 'current' } };
  // No usable answer (a hand-edited or old-schema file): a real check, never an invented 'current'.
  return { run: true, reason: 'no-usable-answer' };
}

/** An answered check: sets the cadence anchor, keeps what it found, ends any backoff. */
function recordSuccess(state, { result, at }) {
  const iso = new Date(at).toISOString();
  return {
    ...state,
    lastSuccessAt: iso,
    lastAttemptAt: iso,
    lastResult: { state: result.state, version: result.version || null },
    failureCount: 0,
  };
}

/** A failed check: starts/extends the backoff. The last SUCCESSFUL answer is kept. */
function recordFailure(state, { at }) {
  return { ...state, lastAttemptAt: new Date(at).toISOString(), failureCount: (Number(state.failureCount) || 0) + 1 };
}

// ── the engine (PyPI) channel's own failure streak ──────────────────────────
// Kept apart from failureCount, which belongs to the desktop feed: one channel failing must not
// send the OTHER back to the feed on the backoff cadence.

function recordEngineFailure(state, { at }) {
  return { ...state, engineLastAttemptAt: new Date(at).toISOString(), engineFailureCount: (Number(state.engineFailureCount) || 0) + 1 };
}

function recordEngineSuccess(state) {
  return { ...state, engineFailureCount: 0 };
}

/**
 * An engine retry that could not run (the check was HELD behind a pending desktop): pace the next
 * retry by the existing backoff without growing the streak — a hold is neither failure nor answer.
 */
function recordEngineAttempt(state, { at }) {
  return { ...state, engineLastAttemptAt: new Date(at).toISOString() };
}

/** Is an engine-only retry due? Only meaningful while engineFailureCount > 0. */
function engineRetryDue({ state, now }) {
  const failures = Number(state.engineFailureCount) || 0;
  if (failures === 0) return false;
  const attempted = attemptMs(state.engineLastAttemptAt, now);
  return attempted === null || now >= attempted + backoffDelayMs(failures);
}

module.exports = {
  REGULAR_INTERVAL_MS,
  INTERNAL_INTERVAL_MS,
  SCHEDULE_FILE,
  SCHEDULER_TICK_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  isInternalEmail,
  intervalForEmail,
  readAccountEmail,
  readScheduleState,
  writeScheduleState,
  backoffDelayMs,
  shouldAutoCheck,
  planLaunchCheck,
  recordSuccess,
  recordFailure,
  recordEngineFailure,
  recordEngineSuccess,
  recordEngineAttempt,
  engineRetryDue,
};
