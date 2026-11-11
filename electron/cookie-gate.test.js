'use strict';

/*
 * Tests for ./cookie-gate.js — reading the backend's local cookie-gate token and
 * handing it to the health check (header) and the window (cookie).
 *
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/cookie-gate.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gate = require('./cookie-gate');

let passed = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed++;
}

(async () => {
  // tokenPath: FLOW_INSTANCE-aware, prod by default.
  const home = path.join(os.tmpdir(), 'home');
  eq(gate.tokenPath('dev', home), path.join(home, '.flow', 'instances', 'dev', '.cookie_gate'), 'named instance');
  const saved = process.env.FLOW_INSTANCE;
  delete process.env.FLOW_INSTANCE;
  eq(gate.tokenPath(undefined, home), path.join(home, '.flow', 'instances', 'prod', '.cookie_gate'), 'prod by default');
  if (saved !== undefined) process.env.FLOW_INSTANCE = saved;

  // readToken / gateHeaders: a missing file is "no token", never a throw; a new file is seen on the next read.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-gate-test-'));
  const file = path.join(dir, '.cookie_gate');
  eq(gate.readToken(file), null, 'missing file');
  eq(gate.gateHeaders(gate.readToken(file)), {}, 'no header without a token');
  fs.writeFileSync(file, 'tok-123\n');
  eq(gate.readToken(file), 'tok-123', 'file appears, next read sees it');
  eq(gate.gateHeaders(gate.readToken(file)), { 'x-cookie-gate': 'tok-123' }, 'header with a token');
  fs.writeFileSync(file, '   ');
  eq(gate.readToken(file), null, 'an empty file is no token');

  // cookieDetails: the backend's desktop cookie for that port.
  const details = gate.cookieDetails('http://localhost:9007', 'tok-123');
  eq([details.url, details.name, details.value], ['http://localhost:9007', 'cookie-gate-9007', 'tok-123'], 'desktop cookie details');

  // injectCookie: sets it when there is a token, does nothing when there is none.
  const set = [];
  let flushed = 0;
  const session = { cookies: { set: async (d) => set.push(d), flushStore: async () => { flushed += 1; } } };
  eq(await gate.injectCookie(session, 'http://localhost:9007', null), false, 'no token, nothing set');
  eq(set.length, 0, 'nothing set without a token');
  eq(await gate.injectCookie(session, 'http://localhost:9007', 'tok-123'), true, 'token set');
  eq(set[0].name, 'cookie-gate-9007', 'cookie name per port');
  eq(flushed, 1, 'written to disk once set');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`cookie-gate.test.js: ${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
