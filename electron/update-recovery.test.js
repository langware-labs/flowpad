'use strict';
// Tests for update-recovery.js: the desktop update as a recovery route, without loops (FLOWPAD-2231).
const assert = require('assert');
const ur = require('./update-recovery');
const { isNewer } = require('./semver');

let count = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); count++; };
const ok = (v, m) => { assert.ok(v, m); count++; };

const FP = 'abc123';

// ── persisted state ─────────────────────────────────────────────────────────
{
  eq(ur.readRecoveryState(() => { throw new Error('ENOENT'); }, '/x'), { attempts: [] }, 'missing → empty');
  eq(ur.readRecoveryState(() => 'garbage', '/x'), { attempts: [] }, 'garbage → empty');
  eq(ur.readRecoveryState(() => '{"attempts":[{"targetVersion":"1"},null,"x"]}', '/x'), { attempts: [{ targetVersion: '1' }] }, 'non-object entries dropped');
  let written = null;
  ur.writeRecoveryState((p, t) => { written = [p, JSON.parse(t)]; }, '/p', { attempts: [] });
  eq(written, ['/p', { attempts: [] }], 'write');
}

// ── test 7: update available → offered once ─────────────────────────────────
{
  const state = { attempts: [] };
  const plan = ur.planRecoveryUpdate({ state, appVersion: '0.2.52', latestVersion: '0.2.53', fingerprint: FP, isNewer });
  eq(plan, { action: 'offer', version: '0.2.53' }, 'a newer release is offered');
  const after = ur.recordRecoveryAttempt(state, { targetVersion: '0.2.53', fingerprint: FP, fromVersion: '0.2.52', at: 't1' });
  eq(after.attempts, [{ targetVersion: '0.2.53', fingerprint: FP, fromVersion: '0.2.52', at: 't1', outcome: 'installing' }], 'the attempt is recorded before anything is installed');
  const again = ur.planRecoveryUpdate({ state: after, appVersion: '0.2.52', latestVersion: '0.2.53', fingerprint: FP, isNewer });
  eq([again.action, again.why], ['none', 'already-attempted'], 'the same version for the same failure is never offered twice');
  ok(again.prior && again.prior.at === 't1', 'the prior attempt is reported for the panel text');
  const otherFailure = ur.planRecoveryUpdate({ state: after, appVersion: '0.2.52', latestVersion: '0.2.53', fingerprint: 'other', isNewer });
  eq(otherFailure.action, 'offer', 'a different failure fingerprint may try the same version once');
  const newerStill = ur.planRecoveryUpdate({ state: after, appVersion: '0.2.52', latestVersion: '0.2.54', fingerprint: FP, isNewer });
  eq(newerStill.action, 'offer', 'a newer target is a new attempt');
}

// ── test 8: no update → no offer, nothing else changes ──────────────────────
{
  eq(ur.planRecoveryUpdate({ state: { attempts: [] }, appVersion: '0.2.52', latestVersion: null, fingerprint: FP, isNewer }), { action: 'none', why: 'no-update' }, 'no update known');
  eq(ur.planRecoveryUpdate({ state: { attempts: [] }, appVersion: '0.2.52', latestVersion: '0.2.52', fingerprint: FP, isNewer }).why, 'not-newer', 'same version is not an update');
  eq(ur.planRecoveryUpdate({ state: { attempts: [] }, appVersion: '0.2.52', latestVersion: '0.2.50', fingerprint: FP, isNewer }).why, 'not-newer', 'never a downgrade');
}

// ── test 11: update succeeded but the backend still fails → recovery mode, no reinstall ──
{
  let state = ur.recordRecoveryAttempt({ attempts: [] }, { targetVersion: '0.2.53', fingerprint: FP, fromVersion: '0.2.52', at: 't1' });
  const relaunched = ur.afterRelaunch({ state, appVersion: '0.2.53' });
  state = relaunched.state;
  eq(relaunched.installed && relaunched.installed.outcome, 'installed', 'the running version is the target: installed');
  eq(state.attempts[0].outcome, 'installed', 'persisted as installed');
  // The new version fails the same way (same fingerprint — the runtime did not change). The feed still says 0.2.53.
  const plan = ur.planRecoveryUpdate({ state, appVersion: '0.2.53', latestVersion: '0.2.53', fingerprint: FP, isNewer });
  eq(plan.why, 'not-newer', 'the installed version is not offered again');
  // And even if the feed moved on, the failure history is NOT reset by the install.
  ok(state.attempts.length === 1, 'history kept until a healthy startup');
  eq(ur.markStartupHealthy(state), { attempts: [] }, 'only a confirmed healthy startup clears it');
}

// ── test 13: interrupted download / relaunch ────────────────────────────────
{
  const state = ur.recordRecoveryAttempt({ attempts: [] }, { targetVersion: '0.2.53', fingerprint: FP, fromVersion: '0.2.52', at: 't1' });
  const r = ur.afterRelaunch({ state, appVersion: '0.2.52' }); // still the old version: nothing got installed
  eq(r.installed, null, 'not installed');
  eq(r.state.attempts, [], 'an interrupted attempt is dropped so the offer can be made again');
  const again = ur.planRecoveryUpdate({ state: r.state, appVersion: '0.2.52', latestVersion: '0.2.53', fingerprint: FP, isNewer });
  eq(again.action, 'offer', 'offered again after an interruption');
  const failed = ur.markAttemptOutcome(state, { targetVersion: '0.2.53', fingerprint: FP, outcome: 'failed', detail: 'sha512 mismatch' });
  eq(failed.attempts[0].outcome, 'failed', 'a failed download/install is recorded');
  eq(ur.planRecoveryUpdate({ state: failed, appVersion: '0.2.52', latestVersion: '0.2.53', fingerprint: FP, isNewer }).why, 'already-attempted', 'and not retried automatically');
}

// ── test 9: offline → the check is bounded ──────────────────────────────────
(async () => {
  const timers = (() => {
    let cb = null;
    return { setTimeout: (fn) => { cb = fn; return 1; }, clearTimeout: () => {}, fire: () => cb && cb() };
  })();
  const never = new Promise(() => {});
  const logged = [];
  const p = ur.boundedCheck(() => never, { ms: 20000, timers, log: { info: (m) => logged.push(m) } });
  timers.fire();
  eq(await p, null, 'a check that never answers resolves null when the bound fires');
  ok(logged.some((m) => /gave up after 20000 ms/.test(m)), 'and says so');
  eq(await ur.boundedCheck(() => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')), { ms: 1000 }), null, 'a failing check resolves null, never rejects');
  eq(await ur.boundedCheck(() => { throw new Error('sync'); }, { ms: 1000 }), null, 'a throwing check resolves null');
  eq(await ur.boundedCheck(() => Promise.resolve('0.2.53'), { ms: 1000 }), '0.2.53', 'a fast answer comes through');

  // ── the note next to the failure ──
  ok(/Repair FlowPad/.test(ur.recoveryNote('policy-blocked', '0.2.53')) && /not the Python runtime/.test(ur.recoveryNote('policy-blocked', '0.2.53')), 'a desktop update is not claimed to fix a blocked runtime');
  ok(/No newer FlowPad version/.test(ur.recoveryNote('crash-loop', null)), 'no update: says so');

  console.log(`update-recovery.test.js: ${count} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
