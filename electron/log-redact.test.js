'use strict';

/*
 * Tests for ./log-redact.js — no secret reaches the desktop log file.
 * Run: `node electron/log-redact.test.js` (exits non-zero on failure).
 *
 * The sample lines are shaped like the real ones found in user logs (2026-09-30): the login deep link
 * carries a live API key. The keys below are synthetic.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redactUrl, redactLogMessage, installLogRedaction } = require('./log-redact');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

const KEY = 'fp_live_4q1jc6x9r3muybmgh05xhgx5';
const NEXT = '%2F%3Faction%3Dopen%26setup_git%3D1%26project_id%3D5b1dcd12-6eb6-4395-90f3-6aba7d56335d';
const DEEP = `flowpad://auth/login_callback?flowpad-api-key=${KEY}&next=${NEXT}`;

// ── redactUrl ───────────────────────────────────────────────────────────────
{
  const r = redactUrl(DEEP);
  ok(!r.includes(KEY) && !r.includes('fp_live_'), 'the deep link\'s API key is masked');
  ok(r.startsWith('flowpad://auth/login_callback?flowpad-api-key=[REDACTED]&next='), 'scheme, path and the parameter NAME stay (the log still says what happened)');
  ok(r.includes(NEXT), 'harmless parameters are kept whole (project id etc. are useful when debugging)');
}
for (const [name, url] of [
  ['access_token', 'https://x.example/cb?access_token=abc123secretvalue&state=ok'],
  ['code', 'https://x.example/cb?code=4%2F0AbCdEfGh&state=ok'],
  ['fragment token', 'https://x.example/cb#id_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigsigsigsig&state=ok'],
  ['api_key', 'http://localhost:9007/x?api_key=zzz999&y=1'],
  ['userinfo', 'https://user:hunter2@github.com/org/repo.git'],
]) {
  const r = redactUrl(url);
  ok(!/abc123secretvalue|4%2F0AbCdEfGh|sigsigsigsig|zzz999|hunter2/.test(r), `${name}: the credential is masked (${r})`);
}
eq(redactUrl('http://localhost:9007/?viewMode=vibe&keyboard=1&monkey=2'), 'http://localhost:9007/?viewMode=vibe&keyboard=1&monkey=2', 'names that merely CONTAIN "key" (keyboard, monkey) are not touched');
eq(redactUrl('http://localhost:9007/dock/conversation/23c3fefd-7fd1-4a95-9442-015989ec6bb2?viewMode=vibe'), 'http://localhost:9007/dock/conversation/23c3fefd-7fd1-4a95-9442-015989ec6bb2?viewMode=vibe', 'an ordinary app URL is unchanged');
eq(redactUrl(undefined), '', 'undefined → empty');
ok(!redactUrl(`not a url ${KEY}`).includes(KEY), 'a non-URL string with a key in it is still masked');

// ── redactLogMessage ────────────────────────────────────────────────────────
{
  const original = { level: 'info', data: [`[deep-link] received: ${DEEP}`, { untouched: true }, 42] };
  const out = redactLogMessage(original);
  ok(!out.data[0].includes(KEY), 'string data is redacted');
  eq(out.data.slice(1), [{ untouched: true }, 42], 'non-string data passes through');
  ok(original.data[0].includes(KEY), 'the shared original message is NOT mutated (hooks run once per transport)');
  const err = new Error(`spawn failed with token=abcdef1234567890 (${KEY})`);
  const e = redactLogMessage({ data: ['boom', err] });
  ok(typeof e.data[1] === 'string' && !e.data[1].includes(KEY) && !e.data[1].includes('abcdef1234567890') && /spawn failed/.test(e.data[1]), 'an Error is logged as its redacted stack');
  eq(redactLogMessage(null), null, 'null message tolerated');
}

// ── through the REAL electron-log (its node build, no Electron needed) ───────
{
  const log = require('electron-log/node');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logredact-'));
  try {
    const file = path.join(dir, 'test.log');
    log.transports.file.resolvePathFn = () => file;
    log.transports.file.level = 'info';
    log.transports.console.level = false;
    installLogRedaction(log);
    installLogRedaction(log);
    eq(log.hooks.filter((h) => h.__flowpadRedaction).length, 1, 'installLogRedaction is idempotent');
    log.info(`[deep-link] received: ${DEEP}`);
    log.info('secret env dump', { note: 'objects are not scanned' }, `AZURE_CLIENT_SECRET=hunter2hunter2 and ${KEY}`);
    log.error('Failed', new Error(`Bearer abcdefghijklmnop123456 ${KEY}`));
    log.info('[nav] did-navigate url=http://localhost:9007/?viewMode=vibe');
    const text = fs.readFileSync(file, 'utf8'); // the file transport writes synchronously
    ok(text.includes('[deep-link] received: flowpad://auth/login_callback?flowpad-api-key=[REDACTED]'), 'the log FILE has the masked deep link');
    ok(!/fp_live_|hunter2hunter2|abcdefghijklmnop123456/.test(text), 'no key, secret or bearer token anywhere in the log file');
    ok(text.includes('[nav] did-navigate url=http://localhost:9007/?viewMode=vibe'), 'ordinary lines are written unchanged');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log(`log-redact.test.js: ${passed} assertions passed`);
