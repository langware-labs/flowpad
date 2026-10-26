'use strict';

/*
 * Unit test for update-schedule.js — the pure schedule behind FLOWPAD-2308: who checks how often,
 * what persists across restarts, the failure backoff, and the once-per-version offer.
 * Run: `node electron/update-schedule.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const s = require('./update-schedule');
const { isNewer } = require('./semver');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

const T0 = Date.parse('2026-10-26T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// ── who is internal: exact domain, case-insensitive, nothing else ───────────
eq(s.isInternalEmail('a@langware.ai'), true, 'langware.ai is internal');
eq(s.isInternalEmail('A@LANGWARE.AI'), true, 'case does not matter');
eq(s.isInternalEmail('a@notlangware.ai'), false, 'a suffix match is not a domain match');
eq(s.isInternalEmail('a@langware.ai.evil.com'), false, 'a prefix match is not a domain match');
eq(s.isInternalEmail('a@sub.langware.ai'), false, 'a subdomain is not the domain');
eq(s.isInternalEmail('@langware.ai'), false, 'no local part, no account');
eq(s.isInternalEmail(null), false, 'logged out is not internal');
eq(s.isInternalEmail(' a@langware.ai '), true, 'stray whitespace (a hand-edited config) still matches');
eq(s.intervalForEmail('dev@langware.ai'), s.INTERNAL_INTERVAL_MS, 'internal: hourly');
eq(s.intervalForEmail('user@example.com'), s.REGULAR_INTERVAL_MS, 'regular: daily');
eq(s.intervalForEmail(null), s.REGULAR_INTERVAL_MS, 'no email: the regular (safe) cadence');

// ── the account email comes from the backend-written config.json ────────────
const files = {};
const readFile = (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); };
eq(s.readAccountEmail(readFile, '/i/config.json'), null, 'no file: null');
files['/i/config.json'] = 'not json';
eq(s.readAccountEmail(readFile, '/i/config.json'), null, 'garbage: null');
files['/i/config.json'] = JSON.stringify({ user: {} });
eq(s.readAccountEmail(readFile, '/i/config.json'), null, 'logged out (empty user): null');
files['/i/config.json'] = JSON.stringify({ user: { email: 'dev@langware.ai' } });
eq(s.readAccountEmail(readFile, '/i/config.json'), 'dev@langware.ai', 'the hub-written email is read');

// ── state file round-trip; garbage never throws ─────────────────────────────
{
  let written = null;
  const state = s.recordSuccess({}, { result: { state: 'current', version: null }, at: T0 });
  s.writeScheduleState((p, text) => { written = text; }, '/u/update-schedule.json', state);
  eq(s.readScheduleState(() => written, '/u/f'), state, 'what was written reads back');
  eq(s.readScheduleState(() => '[]', '/u/f'), {}, 'a JSON array is garbage');
  eq(s.readScheduleState(() => { throw new Error('ENOENT'); }, '/u/f'), {}, 'no file: empty state');
}

// ── due: first run, interval, persistence across restarts ───────────────────
eq(s.shouldAutoCheck({ state: {}, intervalMs: HOUR, now: T0 }).reason, 'first-run', 'no history: due now');
{
  const state = s.recordSuccess({}, { result: { state: 'current', version: null }, at: T0 });
  eq(s.shouldAutoCheck({ state, intervalMs: 24 * HOUR, now: T0 + HOUR }).due, false, 'regular: not due after an hour');
  eq(s.shouldAutoCheck({ state, intervalMs: 24 * HOUR, now: T0 + 24 * HOUR }).reason, 'interval', 'regular: due after a day');
  eq(s.shouldAutoCheck({ state, intervalMs: HOUR, now: T0 + 30 * 60 * 1000 }).due, false, 'internal: not due after 30 minutes');
  eq(s.shouldAutoCheck({ state, intervalMs: HOUR, now: T0 + HOUR }).due, true, 'internal: due after an hour');
  // The same state read back after a "restart" answers the same — the interval never resets.
  const reread = s.readScheduleState(() => JSON.stringify(state), '/u/f');
  eq(s.shouldAutoCheck({ state: reread, intervalMs: 24 * HOUR, now: T0 + HOUR }).due, false, 'a restart does not reset the interval');
  // An account switch re-reads the interval against the SAME anchor: overdue under the new one fires.
  eq(s.shouldAutoCheck({ state: reread, intervalMs: HOUR, now: T0 + 2 * HOUR }).due, true, 'switch to internal with a stale check: due at once');
}
{
  const future = s.recordSuccess({}, { result: { state: 'current', version: null }, at: T0 + 48 * HOUR });
  eq(s.shouldAutoCheck({ state: future, intervalMs: 24 * HOUR, now: T0 }).due, true, 'a clock set back never silences the schedule');
}

// ── backoff: grows, caps, beats the interval, resets on success ─────────────
eq(s.backoffDelayMs(1), s.BACKOFF_BASE_MS, 'first failure: the base delay');
eq(s.backoffDelayMs(3), s.BACKOFF_BASE_MS * 4, 'doubles per failure');
eq(s.backoffDelayMs(99), s.BACKOFF_MAX_MS, 'capped');
{
  let state = s.recordSuccess({}, { result: { state: 'current', version: null }, at: T0 });
  state = s.recordFailure(state, { at: T0 + HOUR });
  eq(state.failureCount, 1, 'a failure is counted');
  eq(state.lastSuccessAt, iso(T0), 'the last SUCCESSFUL check is kept');
  eq(s.shouldAutoCheck({ state, intervalMs: 24 * HOUR, now: T0 + HOUR + 1 }).due, false, 'inside the backoff: quiet');
  const retry = s.shouldAutoCheck({ state, intervalMs: 24 * HOUR, now: T0 + HOUR + s.BACKOFF_BASE_MS });
  eq([retry.due, retry.reason], [true, 'backoff'], 'the backoff retries sooner than the daily interval');
  state = s.recordFailure(state, { at: T0 + 2 * HOUR });
  eq(s.shouldAutoCheck({ state, intervalMs: 24 * HOUR, now: T0 + 2 * HOUR + s.BACKOFF_BASE_MS }).due, false, 'the second retry waits twice as long');
  state = s.recordSuccess(state, { result: { state: 'current', version: null }, at: T0 + 3 * HOUR });
  eq(state.failureCount, 0, 'a success ends the backoff');
}
{
  const state = { failureCount: 2, lastAttemptAt: 'garbage' };
  eq(s.shouldAutoCheck({ state, intervalMs: HOUR, now: T0 }).due, true, 'failures with no usable attempt time: due now');
}

// ── the engine channel keeps its own streak — neither channel drags the other ──
{
  let state = s.recordSuccess({}, { result: { state: 'current', version: null }, at: T0 });
  state = s.recordEngineFailure(state, { at: T0 });
  eq([state.engineFailureCount, state.failureCount], [1, 0], 'an engine failure never touches the feed streak');
  eq(s.shouldAutoCheck({ state, intervalMs: 24 * HOUR, now: T0 + s.BACKOFF_BASE_MS }).due, false, 'the feed stays on its own interval');
  eq(s.engineRetryDue({ state, now: T0 + s.BACKOFF_BASE_MS - 1 }), false, 'engine retry: not inside the backoff');
  eq(s.engineRetryDue({ state, now: T0 + s.BACKOFF_BASE_MS }), true, 'engine retry: due after the backoff');
  state = s.recordEngineFailure(state, { at: T0 + s.BACKOFF_BASE_MS });
  eq(s.engineRetryDue({ state, now: T0 + 2 * s.BACKOFF_BASE_MS - 1 }), false, 'the engine backoff doubles too');
  state = s.recordEngineSuccess(state);
  eq(s.engineRetryDue({ state, now: T0 + 10 * s.BACKOFF_BASE_MS }), false, 'an engine success ends its streak');
  const feedFailing = s.recordFailure({}, { at: T0 });
  eq(s.engineRetryDue({ state: feedFailing, now: T0 + 10 * s.BACKOFF_BASE_MS }), false, 'a feed failure never arms an engine retry');
}

// ── the launch check: run only when it serves someone ───────────────────────
eq(s.planLaunchCheck({ state: {}, intervalMs: HOUR, now: T0 }).run, true, 'first launch: the real check runs');
{
  const current = s.recordSuccess({}, { result: { state: 'current', version: null }, at: T0 });
  const plan = s.planLaunchCheck({ state: current, intervalMs: 24 * HOUR, now: T0 + HOUR });
  eq([plan.run, plan.seed], [false, { state: 'current' }], 'recent "current": skipped, the status is seeded (the engine is not held)');
  eq(s.planLaunchCheck({ state: current, intervalMs: 24 * HOUR, now: T0 + 25 * HOUR }).run, true, 'due again: the real check runs');

  const available = s.recordSuccess({}, { result: { state: 'available', version: '0.2.48' }, at: T0 });
  eq(s.planLaunchCheck({ state: available, intervalMs: 24 * HOUR, now: T0 + HOUR }).reason, 'update-pending', 'a pending update always re-checks');

  const unsupported = s.recordSuccess({}, { result: { state: 'unsupported', version: null }, at: T0 });
  eq(s.planLaunchCheck({ state: unsupported, intervalMs: 24 * HOUR, now: T0 + HOUR }).run, true, 'unsupported answers without the network: no reason to skip');

  // A seed is never INVENTED: only an explicit 'current' answer is reused.
  const noResult = { lastSuccessAt: iso(T0), lastAttemptAt: iso(T0), failureCount: 0 };
  eq(s.planLaunchCheck({ state: noResult, intervalMs: 24 * HOUR, now: T0 + HOUR }).reason, 'no-usable-answer', 'a recent success with no recorded answer runs the real check');
  const unknownResult = { ...noResult, lastResult: { state: 'unknown' } };
  eq(s.planLaunchCheck({ state: unknownResult, intervalMs: 24 * HOUR, now: T0 + HOUR }).run, true, 'an unknown answer is not seeded as current');

  // A RELAUNCH inside a failure backoff retries for real — a seeded/quiet skip would hold every
  // engine update behind an 'unknown' status with no visible way out. Ticks still pace the backoff.
  const failing = s.recordFailure(current, { at: T0 + HOUR });
  eq(s.planLaunchCheck({ state: failing, intervalMs: 24 * HOUR, now: T0 + HOUR + 1 }).reason, 'launch-retry', 'relaunch inside the backoff: the real check runs');
  const neverAnswered = s.recordFailure({}, { at: T0 });
  eq(s.planLaunchCheck({ state: neverAnswered, intervalMs: 24 * HOUR, now: T0 + 1 }).reason, 'launch-retry', 'relaunch with no answer ever: the real check runs');
}

// ── one announcement per version, across restarts, never a regression ───────
{
  let state = s.recordOffered({}, { version: '0.2.48' });
  eq(s.shouldNotify({ state: {}, version: '0.2.48', isNewer }), true, 'never offered: announce');
  eq(s.shouldNotify({ state, version: '0.2.48', isNewer }), false, 'the same version (e.g. after a restart): never twice');
  eq(s.shouldNotify({ state, version: '0.2.49', isNewer }), true, 'a strictly newer version: announce');
  eq(s.shouldNotify({ state, version: '0.2.47', isNewer }), false, 'a feed regression: never re-announce an older build');
  state = s.readScheduleState(() => JSON.stringify(state), '/u/f');
  eq(s.shouldNotify({ state, version: '0.2.48', isNewer }), false, 'the offer survives a restart');
}

// ── the one decision ladder for a feed answer ───────────────────────────────
{
  const d = (state, version, deferredVersion = null, offeredThisSession = null) => s.decideDesktopAction({ state, version, isNewer, deferredVersion, offeredThisSession });
  const offered49 = s.recordOffered({}, { version: '0.2.49' });
  eq(d({}, '0.2.48'), 'announce', 'never announced: announce');
  eq(d(offered49, '0.2.50'), 'announce', 'strictly newer than the watermark: announce');
  eq(d(offered49, '0.2.49', '0.2.49'), 'ignore', 'deferred this session: the reminder owns it');
  eq(d(offered49, '0.2.49', null, '0.2.49'), 'resume', 'announced this session (e.g. "Update now"): only the download continues');
  eq(d(offered49, '0.2.49'), 'adopt', 'offered before a restart: adopt quietly');
  eq(d(offered49, '0.2.48'), 'adopt', 'a feed regression: adopt quietly');
  const adopted48 = s.recordAdopted(offered49, { version: '0.2.48' });
  eq(d(adopted48, '0.2.48'), 'redownload', 'already adopted: just resume the download');
  eq(adopted48.lastOfferedDesktopVersion, '0.2.49', 'adoption never lowers the announce watermark');
  eq(d(adopted48, '0.2.49'), 'adopt', 'the pulled release coming back is still not re-announced');
  eq(d(adopted48, '0.2.50'), 'announce', 'but a genuinely newer one is');
}

console.log(`update-schedule.test.js: ${passed} assertions passed`);
