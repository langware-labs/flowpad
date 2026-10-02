'use strict';

/*
 * Tests for ./failure-dialog.js — every failure dialog offers "Share with us".
 * Run: `node electron/failure-dialog.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { showFailureDialog } = require('./failure-dialog');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

const silentLog = { warn() {} };

function fakeDialog(responses) {
  const d = { shown: [], showMessageBox: async (...args) => {
    const opts = args[args.length - 1];
    d.shown.push({ parent: args.length === 2 ? args[0] : undefined, opts });
    return { response: responses.length ? responses.shift() : 0 };
  } };
  return d;
}

(async () => {
  // 1. With a sharer: two buttons, OK first and default; Esc/close = OK.
  {
    const d = fakeDialog([0]);
    const r = await showFailureDialog({ dialog: d, title: 'T', message: 'M', detail: 'D', share: async () => ({ ok: true }), log: silentLog });
    eq(r, 'ok');
    eq(d.shown[0].opts.buttons, ['OK', 'Share with us']);
    eq([d.shown[0].opts.defaultId, d.shown[0].opts.cancelId], [0, 0]);
  }
  // 2. Without a sharer: OK only.
  {
    const d = fakeDialog([0]);
    await showFailureDialog({ dialog: d, title: 'T', message: 'M', log: silentLog });
    eq(d.shown[0].opts.buttons, ['OK']);
  }
  // 3. "Share with us" calls the sharer with the headline + detail, once, and reports 'shared'.
  {
    const d = fakeDialog([1]);
    const got = [];
    const r = await showFailureDialog({ dialog: d, title: 'T', message: 'Headline', detail: 'Cause: boom', share: async (t) => { got.push(t); return { ok: true }; }, log: silentLog });
    eq(r, 'shared');
    eq(got, ['Headline\n\nCause: boom']);
    eq(d.shown.length, 1, 'no second dialog when sharing worked');
  }
  // 4. A failed share (returned or thrown) tells the user and where the logs are.
  for (const sharer of [async () => ({ ok: false, error: 'disk full' }), async () => { throw new Error('disk full'); }]) {
    const d = fakeDialog([1, 0]);
    const r = await showFailureDialog({ dialog: d, title: 'T', message: 'M', share: sharer, log: silentLog });
    eq(r, 'share-failed');
    eq(d.shown.length, 2);
    assert.ok(d.shown[1].opts.detail.includes('disk full') && d.shown[1].opts.detail.includes('diagnosis@langware.ai')); passed++;
  }
  // 5. A parent window is passed through; none → the single-argument form.
  {
    const d = fakeDialog([0]);
    const win = { id: 7 };
    await showFailureDialog({ dialog: d, parent: win, title: 'T', message: 'M', log: silentLog });
    eq(d.shown[0].parent, win);
    const d2 = fakeDialog([0]);
    await showFailureDialog({ dialog: d2, title: 'T', message: 'M', log: silentLog });
    eq(d2.shown[0].parent, undefined);
  }
  // 6. A dialog that cannot be shown never throws into the caller.
  {
    const d = { showMessageBox: async () => { throw new Error('no window'); } };
    eq(await showFailureDialog({ dialog: d, title: 'T', message: 'M', share: async () => ({ ok: true }), log: silentLog }), 'ok');
  }
  console.log(`failure-dialog: ${passed} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
