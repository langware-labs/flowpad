'use strict';

/*
 * Tests for ./update-plan.js — desktop + engine updates: decisions, the saved engine version, the 90 minute reminder.
 * Run: `node electron/update-plan.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { isNewer } = require('./semver');
const {
  READY_REMINDER_MS, decideOffer, savePendingEngine, markPendingEngineConsented, planAfterDesktopUpdate, createReadyReminder,
} = require('./update-plan');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

eq(READY_REMINDER_MS, 90 * 60 * 1000, 'the reminder interval is the agreed 90 minutes');

// ── what is on offer ────────────────────────────────────────────────────────
eq(decideOffer({ desktopLatest: '0.2.48', engineStatus: { latestVersion: '0.2.180' } }), 'both', 'desktop + engine → the combined screen');
eq(decideOffer({ desktopLatest: '0.2.48', engineStatus: null }), 'desktop', 'desktop only');
eq(decideOffer({ desktopLatest: null, engineStatus: { latestVersion: '0.2.180' } }), 'engine', "engine only → today's dialog");
eq(decideOffer({ desktopLatest: null, engineStatus: null }), 'none', 'nothing');

// ── the saved engine version ────────────────────────────────────────────────
const memStore = (initial = null) => { let v = initial; return { read: () => v, write: (x) => { v = x; }, get value() { return v; } }; };
{
  const s = memStore();
  savePendingEngine(s, { engineVersion: '0.2.180', desktopVersion: '0.2.48', now: new Date('2026-09-30T12:00:00Z') });
  eq(s.value, { engineVersion: '0.2.180', desktopVersion: '0.2.48', savedAt: '2026-09-30T12:00:00.000Z', consented: false }, 'saved, not yet agreed');
  eq(markPendingEngineConsented(s), true, 'consent recorded');
  eq(s.value.consented, true, 'and kept with the rest of the state');
  eq(s.value.engineVersion, '0.2.180', 'the version is untouched by consent');
  eq(markPendingEngineConsented(memStore()), false, 'no saved version → nothing to consent to');
}

// ── after the desktop restarted ─────────────────────────────────────────────
const saved = { engineVersion: '0.2.180', desktopVersion: '0.2.48', consented: true };
const plan = (over) => planAfterDesktopUpdate({ state: saved, appVersion: '0.2.48', installedEngine: '0.2.168', isNewer, ...over });
eq(plan({}), { action: 'install', version: '0.2.180', clear: true }, 'agreed + desktop updated + engine older → install EXACTLY the saved version');
eq(plan({ state: null }), { action: 'none', clear: false }, 'nothing saved → nothing to do');
eq(plan({ appVersion: '0.2.47' }), { action: 'none', clear: false }, 'the desktop is still the old build → keep the saved version for later');
eq(plan({ appVersion: '0.2.49' }), { action: 'install', version: '0.2.180', clear: true }, 'a desktop NEWER than the target counts as updated');
eq(plan({ state: { ...saved, consented: false } }), { action: 'dialog', clear: true }, "desktop updated with no answer (quit after Later) → today's engine dialog, never a silent install");
eq(plan({ installedEngine: '0.2.180' }), { action: 'none', clear: true }, 'the engine is already at the saved version');
eq(plan({ installedEngine: '0.2.181' }), { action: 'none', clear: true }, 'or newer');
eq(plan({ installedEngine: null }), { action: 'install', version: '0.2.180', clear: true }, 'engine version unreadable → still installs what was agreed');

// ── the reminder ────────────────────────────────────────────────────────────
function fakeTimers() {
  let now = 0; const jobs = [];
  return {
    setInterval(fn, ms) { const j = { fn, ms, next: now + ms, dead: false, unref() {} }; jobs.push(j); return j; },
    clearInterval(j) { if (j) j.dead = true; },
    advance(ms) {
      const end = now + ms;
      for (;;) { const due = jobs.filter((j) => !j.dead && j.next <= end).sort((a, b) => a.next - b.next)[0]; if (!due) break; now = due.next; due.next += due.ms; due.fn(); }
      now = end;
    },
    live: () => jobs.filter((j) => !j.dead).length,
  };
}
const MIN = 60 * 1000;
function makeReminder(ready) {
  const timers = fakeTimers(); const shown = [];
  const r = createReadyReminder({ isReady: () => ready.value, show: () => shown.push(1), timers });
  return { r, timers, shown };
}
{
  const ready = { value: true };
  const { r, timers, shown } = makeReminder(ready);
  r.start();
  timers.advance(89 * MIN); eq(shown.length, 0, 'nothing before 90 minutes');
  timers.advance(1 * MIN); eq(shown.length, 1, 'first reminder at 90 minutes');
  timers.advance(90 * MIN); eq(shown.length, 2, 'and again every 90 minutes');
  timers.advance(180 * MIN); eq(shown.length, 4, '…for as long as the user keeps saying Later');
  r.start(); r.start(); eq(timers.live(), 1, 'start() is idempotent (one timer)');
  r.stop(); timers.advance(1000 * MIN); eq([shown.length, timers.live()], [4, 0], 'stop() ends it');
}
{
  // Not ready at reminder time (still downloading): due → shown as soon as the download finishes.
  const ready = { value: false };
  const { r, timers, shown } = makeReminder(ready);
  r.start();
  timers.advance(90 * MIN);
  eq([shown.length, r.due], [0, true], 'reminder came due while the download is unfinished: not shown, remembered');
  ready.value = true; r.notifyReady();
  eq([shown.length, r.due], [1, false], 'shown the moment the update is ready');
  r.notifyReady(); eq(shown.length, 1, 'and only once');
  timers.advance(90 * MIN); eq(shown.length, 2, 'the periodic reminder continues after that');
}
{
  // notifyReady with nothing due does nothing (the "Update now" path shows its prompt through the normal handler).
  const ready = { value: true };
  const { r, shown } = makeReminder(ready);
  r.notifyReady(); eq(shown.length, 0, 'notifyReady() without a due reminder shows nothing');
}
{
  // Another dialog is open at the tick: due, then shown on the next tick when it is free.
  const ready = { value: false };
  const { r, timers, shown } = makeReminder(ready);
  r.start(); timers.advance(90 * MIN);
  ready.value = true; timers.advance(90 * MIN);
  eq(shown.length, 1, 'shown on the next tick once nothing else is in the way');
}

console.log(`update-plan.test.js: ${passed} assertions passed`);
