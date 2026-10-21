'use strict';

/*
 * Tests for ./wheel-compat.js — reading one member out of a remote wheel with Range requests.
 * Run: `node electron/wheel-compat.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const crypto = require('crypto');
const { createZip } = require('./zip-writer');
const { readWheelMember } = require('./wheel-compat');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (v, m) => { assert.ok(v, m); passed++; };

const MEMBER = 'flow_sdk/compat.json';
const COMPAT = '{\n  "min_desktop_version": "0.2.60"\n}\n';

/** A wheel-shaped zip: many members (so its central directory is bigger than the 64 KB tail) + the compat file. */
function makeWheel({ withCompat = true, files = 3000 } = {}) {
  const entries = [];
  for (let i = 0; i < files; i++) entries.push({ name: `flow_sdk/pkg/module_${String(i).padStart(5, '0')}.py`, data: crypto.randomBytes(2048) }); // incompressible, like a real wheel's bulk (the central directory is <1% of it)
  if (withCompat) entries.splice(Math.floor(files / 2), 0, { name: MEMBER, data: COMPAT });
  return createZip(entries);
}

/** An in-memory server honouring `bytes=a-b` and `bytes=-n`; counts requests and bytes served. */
function server(zip, { honourRange = true } = {}) {
  const stats = { requests: 0, bytes: 0 };
  const fetchRange = async (_url, header) => {
    stats.requests++;
    if (!honourRange) { stats.bytes += zip.length; return { status: 200 }; }
    const m = /^bytes=(\d*)-(\d*)$/.exec(header);
    let from; let to;
    if (m[1] === '') { to = zip.length - 1; from = Math.max(0, zip.length - Number(m[2])); } else { from = Number(m[1]); to = Math.min(Number(m[2]), zip.length - 1); }
    const body = zip.subarray(from, to + 1);
    stats.bytes += body.length;
    return { status: 206, contentRange: `bytes ${from}-${to}/${zip.length}`, body };
  };
  return { fetchRange, stats };
}

(async () => {
  {
    const zip = makeWheel();
    const { fetchRange, stats } = server(zip);
    const got = await readWheelMember({ url: 'u', member: MEMBER, fetchRange });
    eq(got && got.found, true, 'the member is found in a wheel with thousands of members');
    eq(got.data.toString('utf8'), COMPAT, 'and its bytes are exact (inflated, CRC-checked)');
    ok(stats.requests <= 5, `a handful of requests (${stats.requests})`);
    ok(stats.bytes < zip.length / 3, `far less than the whole wheel: ${stats.bytes} of ${zip.length} bytes`);
  }
  {
    // A tiny wheel: the central directory is inside the tail, so only tail + local header + data are fetched.
    const zip = makeWheel({ files: 3 });
    const { fetchRange, stats } = server(zip);
    const got = await readWheelMember({ url: 'u', member: MEMBER, fetchRange });
    eq(got.data.toString('utf8'), COMPAT, 'a small wheel works too');
    eq(stats.requests, 3, 'tail, local header, data');
  }
  {
    const { fetchRange } = server(makeWheel({ withCompat: false }));
    eq(await readWheelMember({ url: 'u', member: MEMBER, fetchRange }), { found: false },
      'a wheel without the member is an ANSWER (a pre-contract release), not a failure');
  }
  {
    const { fetchRange } = server(makeWheel(), { honourRange: false });
    eq(await readWheelMember({ url: 'u', member: MEMBER, fetchRange }), null, 'a server that ignores Range -> null (caller falls back)');
  }
  {
    const { fetchRange } = server(Buffer.from('this is not a zip file at all, just text'.repeat(10)));
    eq(await readWheelMember({ url: 'u', member: MEMBER, fetchRange }), null, 'not a zip -> null');
  }
  {
    // ZIP64 sentinels in the end record -> null rather than a wrong read.
    const zip = Buffer.from(makeWheel({ files: 3 }));
    const e = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    zip.writeUInt16LE(0xffff, e + 10);
    const { fetchRange } = server(zip);
    eq(await readWheelMember({ url: 'u', member: MEMBER, fetchRange }), null, 'ZIP64 -> null');
  }
  {
    // A corrupted member (the deflate stream) is rejected, never returned.
    const zip = Buffer.from(makeWheel({ files: 3 }));
    const at = zip.indexOf(Buffer.from(MEMBER)); // the local header's name; the data follows it
    zip[at + MEMBER.length + 2] ^= 0xff;
    const { fetchRange } = server(zip);
    eq(await readWheelMember({ url: 'u', member: MEMBER, fetchRange }), null, 'corrupted data -> null');
  }
  {
    // A server that answers 206 with the wrong number of bytes is not trusted.
    const zip = makeWheel({ files: 3 });
    let calls = 0;
    const fetchRange = async (_u, header) => {
      calls++;
      const real = await server(zip).fetchRange(_u, header);
      return calls === 1 ? real : { ...real, body: real.body.subarray(0, real.body.length - 1) };
    };
    eq(await readWheelMember({ url: 'u', member: MEMBER, fetchRange }), null, 'short body -> null');
  }
  console.log(`wheel-compat.test.js: ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
