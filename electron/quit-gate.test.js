'use strict';

/*
 * Tests for ./quit-gate.js — every quit asks "Are you sure?" first.
 *
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/quit-gate.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { createQuitGate, quitDialogOptions, QUIT_RESPONSE } = require('./quit-gate');

let passed = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed++;
}

const silentLog = { info() {}, warn() {} };

/** A confirm() the test answers by hand, counting how many dialogs were shown. */
function manualConfirm() {
  const calls = [];
  return {
    calls,
    confirm: (phase) => new Promise((resolve) => calls.push({ phase, resolve })),
  };
}

(async () => {
  {
    // Two X clicks while the dialog is up → one dialog; Cancel → the app stays.
    const c = manualConfirm();
    const gate = createQuitGate({ confirm: c.confirm, log: silentLog });
    const first = gate.request('running');
    const second = gate.request('running');
    await Promise.resolve();
    eq(c.calls.length, 1, 'a second quit while asking does not stack a second dialog');
    c.calls[0].resolve(false);
    eq([await first, await second], [false, false], 'Cancel answers both requests with "stay"');
    eq(gate.isConfirmed(), false, 'Cancel leaves the gate closed');
  }
  {
    // Cancel, then a later X asks again; Quit lets it through, and after that nothing asks.
    const c = manualConfirm();
    const gate = createQuitGate({ confirm: c.confirm, log: silentLog });
    const p1 = gate.request('starting');
    await Promise.resolve();
    c.calls[0].resolve(false);
    await p1;
    const p2 = gate.request('running');
    await Promise.resolve();
    eq(c.calls.length, 2, 'after Cancel, the next quit asks again');
    eq(c.calls[1].phase, 'running', 'the dialog is asked for the phase of that moment');
    c.calls[1].resolve(true);
    eq(await p2, true, 'Quit lets the quit through');
    eq(gate.isConfirmed(), true, 'the gate stays open after Quit');
    eq(await gate.request('running'), true, 'the quit that follows does not ask again');
    eq(c.calls.length, 2, 'no further dialog');
  }
  {
    // allow(): quits the app makes on its own never ask; revoke() restores the question.
    const c = manualConfirm();
    const gate = createQuitGate({ confirm: c.confirm, log: silentLog });
    gate.allow('the system is shutting down');
    eq(await gate.request('running'), true, 'an allowed quit goes through');
    eq(c.calls.length, 0, 'without a dialog');
    gate.revoke('the move did not happen');
    gate.request('running');
    await Promise.resolve();
    eq(c.calls.length, 1, 'after revoke() the next quit asks again');
  }
  {
    // A dialog that cannot be shown must not trap the user in the app.
    const gate = createQuitGate({ confirm: async () => { throw new Error('no display'); }, log: silentLog });
    eq(await gate.request('running'), true, 'a failed dialog lets the quit through');
  }
  {
    // The dialog: Cancel is the default and the escape answer; Quit is QUIT_RESPONSE in every phase.
    for (const phase of ['running', 'starting', 'installing']) {
      const o = quitDialogOptions(phase);
      eq(o.defaultId, 0, `${phase}: the default button stays in the app`);
      eq(o.cancelId, 0, `${phase}: Esc / closing the dialog stays in the app`);
      eq(o.buttons.length, 2, `${phase}: two buttons`);
      eq(QUIT_RESPONSE < o.buttons.length, true, `${phase}: QUIT_RESPONSE names a real button`);
    }
    eq(quitDialogOptions('running').message, 'Are you sure you want to quit FlowPad?', 'running asks the plain question');
    eq(quitDialogOptions('starting').message, 'FlowPad is still starting.', 'starting says the startup will stop');
    eq(/repair/.test(quitDialogOptions('installing', { hasInstallMarker: true }).detail), true,
      'installing with a marker promises the repair on next start');
  }

  console.log(`quit-gate.test.js: ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
