'use strict';

/*
 * The last hop of an app's outside link (the SDK's `openExternal`): the REAL main.js `open-external`
 * IPC handler, loaded with stubs for Electron and friends (test-helpers/load-main.js).
 * An http(s) address reaches the system browser and a mailto: the mail app (shell.openExternal);
 * anything else never does.
 * Run: `node electron/open-external.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { loadMain } = require('./test-helpers/load-main');

(async () => {
  const { handlers, opened, restore } = loadMain();
  const handler = handlers['open-external'];
  assert.ok(typeof handler === 'function', 'main.js registers the open-external handler');

  const crm = 'https://crm.example.com/object/person/42';
  assert.strictEqual(await handler({}, crm), true);
  assert.strictEqual(await handler({}, 'http://localhost:3000/deal/7'), true);
  assert.deepStrictEqual(opened, [crm, 'http://localhost:3000/deal/7'], 'an http(s) address reaches the system browser');
  const draft = 'mailto:?subject=My%20game&body=https%3A%2F%2Fgames.example%2F';
  assert.strictEqual(await handler({}, draft), true);
  assert.strictEqual(opened[2], draft, 'a mailto: draft reaches the mail app');

  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', '/dock/home', '', null, undefined, { url: crm }]) {
    assert.strictEqual(await handler({}, bad), false, `refused: ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(opened.length, 3, 'nothing else was opened');

  restore();
  console.log('open-external: 14 checks passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
