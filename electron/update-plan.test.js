'use strict';

/*
 * Tests for ./update-plan.js — desktop + engine updates: the engine-change policy, the saved engine version, the health gate.
 * Run: `node electron/update-plan.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { isNewer } = require('./semver');
const {
  engineChangePolicy, savePendingEngine, markPendingEngineConsented, planAfterDesktopUpdate, engineRecordAtHealthGate,
} = require('./update-plan');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

// ── may the running desktop change the engine? ──────────────────────────────
const policy = (state, mustInstall) => engineChangePolicy({ desktop: state === undefined ? undefined : { state }, mustInstall });
eq(policy('current'), 'allow', 'running the latest desktop → the engine may change');
eq(policy('unsupported'), 'allow', 'nothing to update (dev / Store build) → the engine may change');
eq(policy('available'), 'hold', 'a newer desktop is waiting → the engine is held');
eq(policy('unknown'), 'hold', "could not check the desktop → held (unknown is not 'up to date')");
eq(policy(undefined), 'hold', 'no status at all → held');
eq(policy('bogus'), 'hold', 'unrecognised status → held');
eq(policy('available', true), 'desktop-first', 'must install + newer desktop → desktop first, engine after the relaunch');
eq(policy('unknown', true), 'allow', 'must install + unknown → install anyway (a missing engine is worse)');
eq(policy('current', true), 'allow', 'must install + latest desktop → install');
eq(policy('unsupported', true), 'allow', 'must install + nothing to update → install');

// ── the saved engine version ────────────────────────────────────────────────
const memStore = (initial = null) => { let v = initial; return { read: () => v, write: (x) => { v = x; }, get value() { return v; } }; };
{
  const s = memStore();
  savePendingEngine(s, { engineVersion: '0.2.180', desktopVersion: '0.2.48', now: new Date('2026-09-30T12:00:00Z') });
  eq(s.value, { engineVersion: '0.2.180', desktopVersion: '0.2.48', source: null, savedAt: '2026-09-30T12:00:00.000Z', consented: false }, 'saved, not yet agreed');
  eq(markPendingEngineConsented(s), true, 'consent recorded');
  eq(s.value.consented, true, 'and kept with the rest of the state');
  eq(s.value.engineVersion, '0.2.180', 'the version is untouched by consent');
  eq(markPendingEngineConsented(memStore()), false, 'no saved version → nothing to consent to');
}
{
  const s = memStore();
  savePendingEngine(s, { engineVersion: '0.2.180', desktopVersion: '0.2.48', source: 'panel', now: new Date('2026-09-30T12:00:00Z') });
  eq(s.value.source, 'panel', 'a panel-initiated update records where it came from');
  markPendingEngineConsented(s);
  eq(s.value.source, 'panel', 'and consent keeps it');
}

// ── after the desktop restarted ─────────────────────────────────────────────
const saved = { engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: true };
const plan = (over) => planAfterDesktopUpdate({ state: saved, appVersion: '0.2.48', installedEngine: '0.2.168', isNewer, ...over });
eq(plan({}), { action: 'install', version: '0.2.180', clear: true, source: null }, 'agreed + desktop updated + engine older → install EXACTLY the saved version');
eq(plan({ state: null }), { action: 'none', clear: false, source: null }, 'nothing saved → nothing to do');
eq(plan({ appVersion: '0.2.47' }), { action: 'none', clear: false, source: null }, 'the desktop is still the old build → keep the saved version for later');
eq(plan({ appVersion: '0.2.49' }), { action: 'install', version: '0.2.180', clear: true, source: null }, 'a desktop NEWER than the target counts as updated');
eq(plan({ state: { ...saved, consented: false } }), { action: 'dialog', clear: true, source: null }, "desktop updated with no answer (quit after Later) → today's engine dialog, never a silent install");
eq(plan({ installedEngine: '0.2.180' }), { action: 'none', clear: true, source: null }, 'the engine is already at the saved version');
eq(plan({ installedEngine: '0.2.181' }), { action: 'none', clear: true, source: null }, 'or newer');
eq(plan({ installedEngine: null }), { action: 'install', version: '0.2.180', clear: true, source: null }, 'engine version unreadable → still installs what was agreed');
eq(plan({ state: { ...saved, source: 'panel' } }), { action: 'install', version: '0.2.180', clear: true, source: 'panel' }, 'a panel-initiated update carries its source through to the resume');
eq(plan({ state: { ...saved, source: 'panel', consented: false } }), { action: 'dialog', clear: true, source: 'panel' }, 'and through the no-answer fallback');

// An INSTALLED record (installed, not yet healthy) is the health gate's, whatever re-runs the startup
// in between (Retry after an unrelated failure, a relaunch after a kill): erasing it lost previousEngine,
// and a broken engine then started on every launch with no way back.
const installed = { engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: false, phase: 'installed', previousEngine: '0.2.168', source: 'panel' };
eq(plan({ state: installed, installedEngine: '0.2.180' }), { action: 'none', clear: false, source: 'panel' }, 'an installed, unproven record survives a startup re-run');
eq(plan({ state: { ...installed, phase: 'installing' } }), { action: 'dialog', clear: true, source: 'panel' }, 'a crash MID-install still asks next launch');
eq(plan({ state: { ...installed, phase: 'failed-unhealthy', failedVersion: '0.2.180' } }), { action: 'none', clear: false, source: 'panel' },
  'a rolled-back install is the veto on that version — never cleared as an unanswered offer');

// ── the health gate: the only place the record is spent ─────────────────────
eq(engineRecordAtHealthGate(installed, { healthy: true }), 'spend', 'installed and answering: the record is spent');
eq(engineRecordAtHealthGate(installed, { healthy: false }), 'restore', 'installed, never answered: restore the previous engine');
eq(engineRecordAtHealthGate({ ...installed, previousEngine: null }, { healthy: false }), 'keep', 'no previous engine known: nothing to restore');
eq(engineRecordAtHealthGate({ ...installed, phase: 'installing' }, { healthy: true }), 'keep', 'an unfinished install is not spent by a healthy OLD engine');
eq(engineRecordAtHealthGate(saved, { healthy: true }), 'keep', 'a record nothing installed yet is kept');
eq(engineRecordAtHealthGate(null, { healthy: true }), 'keep', 'no record: nothing to do');

console.log(`update-plan.test.js: ${passed} assertions passed`);
