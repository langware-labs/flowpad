'use strict';

/*
 * Tests for ./engine-compat.js — the bidirectional desktop <-> engine compatibility contract:
 * floors, pair verdicts, invalid metadata, legacy policy, and compatible-release selection.
 * Run: `node electron/engine-compat.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { string2semver } = require('./semver');
const {
  DESKTOP_COMPAT,
  desktopMinBackendVersion,
  meetsFloor,
  isInstallableVersion,
  parseEngineCompat,
  checkPair,
  selectCompatibleRelease,
  incompatibleMessage,
} = require('./engine-compat');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (v, m) => { assert.ok(v, m); passed++; };

// ── the shipped declaration ─────────────────────────────────────────────────
ok(typeof DESKTOP_COMPAT.min_backend_version === 'string', 'engine-compat.json declares min_backend_version');
ok(string2semver(DESKTOP_COMPAT.min_backend_version), 'the shipped floor parses under the shared semver');
eq(desktopMinBackendVersion(), DESKTOP_COMPAT.min_backend_version, 'desktopMinBackendVersion reads the shipped file');
eq(desktopMinBackendVersion({}), null, 'a declaration without the key is no constraint');
eq(desktopMinBackendVersion({ min_backend_version: '' }), null, 'an empty floor is no constraint');

// ── meetsFloor ──────────────────────────────────────────────────────────────
eq(meetsFloor('0.2.50', null), true, 'no floor → no constraint');
eq(meetsFloor('0.2.50', '0.2.50'), true, 'equal passes');
eq(meetsFloor('0.2.51', '0.2.50'), true, 'above passes');
eq(meetsFloor('0.2.49', '0.2.50'), false, 'below fails');
eq(meetsFloor('0.2.50-rc1', '0.2.50'), true, 'an extra tag sorts NEWER (the shared rule)');
eq(meetsFloor('garbage', '0.2.50'), null, 'unparseable version against a declared floor is indeterminate');
eq(meetsFloor('0.2.50', 'garbage'), null, 'unparseable floor is indeterminate');
eq(meetsFloor(null, '0.2.50'), null, 'missing version against a declared floor is indeterminate');

// ── parseEngineCompat ───────────────────────────────────────────────────────
eq(parseEngineCompat('{"min_desktop_version": "0.2.60"}'), { minDesktopVersion: '0.2.60' }, 'reads the engine floor');
eq(parseEngineCompat('{}'), { minDesktopVersion: null }, 'no key → legacy, no constraint');
eq(parseEngineCompat('{"min_desktop_version": "0.2.60", "max_desktop_version": "9.9.9"}'),
  { minDesktopVersion: '0.2.60' }, 'unknown keys are ignored (forward extension)');
assert.throws(() => parseEngineCompat('not json'), 'invalid JSON throws'); passed++;
assert.throws(() => parseEngineCompat('[1,2]'), 'a non-object throws'); passed++;

// ── checkPair: both directions are mandatory ────────────────────────────────
eq(checkPair({ desktopVersion: '0.2.60', engineVersion: '0.2.70', minDesktopVersion: '0.2.60', minBackendVersion: '0.2.50' }).compatible,
  true, 'a pair passing both floors is compatible');
{
  // Newer is NOT compatible — backend 0.2.70 demands desktop 0.2.60.
  const v = checkPair({ desktopVersion: '0.2.45', engineVersion: '0.2.70', minDesktopVersion: '0.2.60', minBackendVersion: '0.2.50' });
  eq(v.compatible, false, 'an engine requiring a newer desktop fails even though the engine is newer');
  ok(v.reasons[0].includes('requires Desktop 0.2.60'), 'the reason names the floor');
}
{
  const v = checkPair({ desktopVersion: '0.2.60', engineVersion: '0.2.40', minDesktopVersion: null, minBackendVersion: '0.2.50' });
  eq(v.compatible, false, 'an engine below the desktop floor fails');
}
eq(checkPair({ desktopVersion: '0.1.0', engineVersion: '0.1.0', minDesktopVersion: '0.2.0', minBackendVersion: '0.2.0' }).reasons.length,
  2, 'both directions can fail at once');
eq(checkPair({ desktopVersion: '0.2.60', engineVersion: '0.2.70' }).compatible, true, 'no floors (legacy) → compatible');
{
  const v = checkPair({ desktopVersion: 'nope', engineVersion: '0.2.70', minDesktopVersion: '0.2.60', minBackendVersion: null });
  eq(v.compatible, false, 'an unparseable desktop version against a declared floor is rejected');
  ok(v.reasons[0].includes('cannot compare'), 'the reason says it could not compare');
}

// ── the user-facing message ─────────────────────────────────────────────────
{
  // Built from the verdict's own reasons, so it names the direction that actually failed.
  const v = checkPair({ desktopVersion: '0.2.45', engineVersion: '0.2.70', minDesktopVersion: '0.2.60', minBackendVersion: null });
  const msg = incompatibleMessage({ desktopVersion: '0.2.45', engineVersion: '0.2.70', reasons: v.reasons });
  ok(msg.includes('FlowPad Desktop 0.2.45 is not compatible'), 'message names the desktop');
  ok(msg.includes('requires Desktop 0.2.60'), 'message names the required floor');
  ok(msg.includes('has been preserved'), 'message says the installation was preserved');
}
{
  // The engine is too OLD and the engine declares no desktop floor at all: the text must not invent one.
  const v = checkPair({ desktopVersion: '0.2.60', engineVersion: '0.2.40', minDesktopVersion: null, minBackendVersion: '0.2.50' });
  const msg = incompatibleMessage({ desktopVersion: '0.2.60', engineVersion: '0.2.40', reasons: v.reasons });
  ok(!/null|undefined/.test(msg), `no "null"/"undefined" in the text: ${JSON.stringify(msg)}`);
  ok(msg.includes('requires Backend 0.2.50 or newer'), 'it names the floor that failed');
}

// ── only release-shaped versions may become install arguments ───────────────
for (const good of ['0.2.219', '1.0.0', '0.2.41rc1', '0.2.40+local1', '0.2.40-local', '10.20.30.dev4']) ok(isInstallableVersion(good), `installable: ${good}`);
for (const bad of ['', 'garbage', '1.2', 'v1.2.3', '1.2.3 --index-url http://evil', '1.2.3&calc', '1.2.3"', '1.2.3;x', ' 1.2.3', '1.2.3\n', 'x1.2.3', null, undefined, 123]) {
  ok(!isInstallableVersion(bad), `not installable: ${JSON.stringify(bad)}`);
}

// ── selectCompatibleRelease (async) ─────────────────────────────────────────
(async () => {
  {
    // Latest 0.2.70 needs desktop 0.2.60; desktop is 0.2.45 and requires engine >= 0.2.50
    // → the newest release passing BOTH directions is picked, not latest.
    const floors = { '0.2.70': '0.2.60', '0.2.65': '0.2.40', '0.2.55': null, '0.2.45': null };
    const asked = [];
    const picked = await selectCompatibleRelease({
      releases: Object.keys(floors).map((version) => ({ version })),
      desktopVersion: '0.2.45',
      minBackendVersion: '0.2.50',
      readEngineCompat: async (v) => { asked.push(v); return { minDesktopVersion: floors[v] }; },
    });
    eq(picked, { version: '0.2.65', minDesktopVersion: '0.2.40' }, 'the newest release passing both directions wins');
    eq(asked, ['0.2.70', '0.2.65'], 'metadata is read newest-first and only as far as needed');
  }
  {
    // Yanked and unparseable releases are never candidates; input order does not matter.
    const picked = await selectCompatibleRelease({
      releases: [{ version: '0.2.1' }, { version: 'junk' }, { version: '0.2.9', yanked: true }, { version: '0.2.3' }],
      desktopVersion: '1.0.0',
      minBackendVersion: null,
      readEngineCompat: async () => ({ minDesktopVersion: null }),
    });
    eq(picked, { version: '0.2.3', minDesktopVersion: null }, 'yanked/garbage skipped; newest valid picked');
  }
  {
    // Invalid metadata rejects the candidate; an INDETERMINATE read (null) accepts it as legacy —
    // the post-install verification is the authoritative gate for that optimism.
    const picked = await selectCompatibleRelease({
      releases: [{ version: '0.3.0' }, { version: '0.2.9' }],
      desktopVersion: '0.2.45',
      minBackendVersion: null,
      readEngineCompat: async (v) => (v === '0.3.0' ? 'invalid' : null),
    });
    eq(picked, { version: '0.2.9', minDesktopVersion: null }, 'invalid metadata skips; indeterminate passes as legacy');
  }
  {
    // No release satisfies the desktop → null, and the walk is bounded.
    const reads = [];
    const picked = await selectCompatibleRelease({
      releases: Array.from({ length: 30 }, (_, i) => ({ version: `0.2.${30 - i}` })),
      desktopVersion: '0.1.0',
      minBackendVersion: null,
      readEngineCompat: async (v) => { reads.push(v); return { minDesktopVersion: '9.9.9' }; },
      limit: 5,
    });
    eq(picked, null, 'no compatible release → null');
    eq(reads.length, 5, 'bounded by the limit');
  }
  {
    // A release key that PARSES (semver.js finds a triple anywhere) but is not release-shaped never becomes
    // an install argument: it is skipped without being read.
    const asked = [];
    const picked = await selectCompatibleRelease({
      releases: [{ version: '9.9.9 --index-url http://evil' }, { version: '9.9.8&calc' }, { version: '0.2.5' }],
      desktopVersion: '1.0.0',
      minBackendVersion: null,
      readEngineCompat: async (v) => { asked.push(v); return { minDesktopVersion: null }; },
    });
    eq(picked, { version: '0.2.5', minDesktopVersion: null }, 'the only release-shaped candidate wins');
    eq(asked, ['0.2.5'], 'the others were never interrogated');
  }
  {
    // Nothing passes the desktop's own floor → null without reading any metadata.
    const picked = await selectCompatibleRelease({
      releases: [{ version: '0.2.1' }],
      desktopVersion: '1.0.0',
      minBackendVersion: '0.5.0',
      readEngineCompat: async () => { throw new Error('must not be called'); },
    });
    eq(picked, null, 'no candidate above the desktop floor → null');
  }
  console.log(`engine-compat.test.js: ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
