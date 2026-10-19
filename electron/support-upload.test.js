'use strict';

/*
 * Tests for ./support-upload.js — the "Send Report" upload to the hub's intake.
 * Run: `node electron/support-upload.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uploadSupportBundle, headerValue, MAX_HEADER_CHARS } = require('./support-upload');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (v, m) => { assert.ok(v, m); passed++; };

const fakeFetch = (status, body) => {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('no json'); return body; } };
  };
  impl.calls = calls;
  return impl;
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'support-upload-'));
  const zipPath = path.join(tmp, 'bundle.zip');
  fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04fake'));
  try {
    // 1. Header values are one printable-ASCII line, capped like the hub's own limit.
    eq(headerValue('  a\n b\tc  '), 'a b c', 'whitespace collapses to single spaces');
    eq(headerValue('héllo→x'), 'h llo x', 'non-ASCII cannot reach an HTTP header');
    eq(headerValue('x'.repeat(1000)).length, MAX_HEADER_CHARS, 'capped');
    eq(headerValue(null), '', 'null tolerated');

    // 2. Success: raw zip body to the intake path, metadata in x-flowpad-* headers, id returned.
    {
      const f = fakeFetch(200, { data: { submission_id: 'sub-42' }, status: 'success' });
      const r = await uploadSupportBundle({
        cloudUrl: 'https://hub.test', zipPath, email: 'u@x.y',
        info: { app: '0.2.213', platform: 'darwin arm64', instance: 'prod' }, fetchImpl: f,
      });
      eq(r, { ok: true, submissionId: 'sub-42' });
      eq(f.calls[0].url, 'https://hub.test/api/v1/diagnosis-report/bundle');
      eq(f.calls[0].opts.method, 'POST');
      eq(f.calls[0].opts.headers['Content-Type'], 'application/zip');
      eq(f.calls[0].opts.headers['x-flowpad-email'], 'u@x.y');
      eq(f.calls[0].opts.headers['x-flowpad-app-version'], '0.2.213');
      eq(f.calls[0].opts.headers['x-flowpad-platform'], 'darwin arm64');
      eq(f.calls[0].opts.headers['x-flowpad-instance'], 'prod');
      ok(Buffer.isBuffer(f.calls[0].opts.body) && f.calls[0].opts.body.toString().startsWith('PK'), 'the zip is the raw body');
    }

    // 3. Anonymous: an empty email sends NO email header at all.
    {
      const f = fakeFetch(200, { data: { submission_id: 's' } });
      await uploadSupportBundle({ cloudUrl: 'https://hub.test', zipPath, email: '  ', fetchImpl: f });
      ok(!('x-flowpad-email' in f.calls[0].opts.headers), 'no email header when anonymous');
    }

    // 4. The hub's client-intended message (detail or message) is surfaced on a refusal.
    {
      const f = fakeFetch(413, { detail: 'The log bundle is too large to upload.' });
      eq(await uploadSupportBundle({ cloudUrl: 'https://hub.test', zipPath, fetchImpl: f }),
        { ok: false, error: 'The log bundle is too large to upload.' });
    }

    // 5. A bodyless error (proxy page) falls back to the HTTP status.
    {
      const f = fakeFetch(502);
      eq(await uploadSupportBundle({ cloudUrl: 'https://hub.test', zipPath, fetchImpl: f }),
        { ok: false, error: 'the service answered HTTP 502' });
    }

    // 6. Network failure and a missing id are clean failures, not throws.
    {
      const r = await uploadSupportBundle({ cloudUrl: 'https://hub.test', zipPath, fetchImpl: async () => { throw new Error('offline'); } });
      eq(r.ok, false); ok(r.error.includes('offline'), 'transport error surfaced');
      const f = fakeFetch(200, { data: {} });
      eq(await uploadSupportBundle({ cloudUrl: 'https://hub.test', zipPath, fetchImpl: f }),
        { ok: false, error: 'the service did not return a submission id' });
    }

    // 7. An unreadable zip reports instead of throwing.
    {
      const r = await uploadSupportBundle({ cloudUrl: 'https://hub.test', zipPath: path.join(tmp, 'missing.zip'), fetchImpl: fakeFetch(200, {}) });
      eq(r.ok, false); ok(r.error.includes('could not read'), 'read failure surfaced');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`support-upload: ${passed} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
