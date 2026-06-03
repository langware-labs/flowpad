'use strict';

/*
 * Tests for ./semver.js — mirror of tests/unit/test_semver.py.
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/semver.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const { string2semver, compareSemver, isNewer } = require('./semver');

let passed = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed++;
}

// ── string2semver: extraction ───────────────────────────────────────────────
const sv = (M, m, p, e) => ({ major: M, minor: m, patch: p, extra: e });
eq(string2semver('0.2.40'), sv(0, 2, 40, ''), '0.2.40');
eq(string2semver('v0.2.40'), sv(0, 2, 40, ''), 'v0.2.40');
eq(string2semver('V0.2.40'), sv(0, 2, 40, ''), 'V0.2.40');
eq(string2semver('flowpad v0.1.35'), sv(0, 1, 35, ''), 'noisy prefix');
eq(string2semver('flowpad v0.2.40-local'), sv(0, 2, 40, 'local'), '-local');
eq(string2semver('0.2.40+local'), sv(0, 2, 40, 'local'), '+local');
eq(string2semver('0.2.40.local'), sv(0, 2, 40, 'local'), '.local');
eq(string2semver('0.2.40_local'), sv(0, 2, 40, 'local'), '_local');
eq(string2semver('flowpad v0.2.40-local'), sv(0, 2, 40, 'local'), 'noisy prefix + tag');
eq(string2semver('1.2.3-rc.1'), sv(1, 2, 3, 'rc.1'), 'rc.1');
eq(string2semver('10.20.30'), sv(10, 20, 30, ''), 'multi-digit');
eq(string2semver('  v2.3.4-dev  '), sv(2, 3, 4, 'dev'), 'whitespace');
eq(string2semver('released 1.2.3, enjoy'), sv(1, 2, 3, ','), 'trailing punctuation');
eq(string2semver('1.2.3.4'), sv(1, 2, 3, '4'), '4th segment → extra');

// ── string2semver: missing / garbage → null ─────────────────────────────────
for (const bad of [null, undefined, '', '   ', 'garbage', '1', '1.2', 'v1.2', '..', '1..3', 'a.b.c', 'version one']) {
  eq(string2semver(bad), null, `null for ${JSON.stringify(bad)}`);
}

// ── ordering: extra tag is NEWER than no tag ─────────────────────────────────
eq(compareSemver(string2semver('2.3.4-somenote'), string2semver('2.3.4')), 1, 'tagged > plain');
eq(compareSemver(string2semver('2.3.4'), string2semver('2.3.4-somenote')), -1, 'plain < tagged');
eq(compareSemver(string2semver('1.2.3'), string2semver('1.2.3')), 0, 'equal');

const ordering = [
  ['1.2.3', '1.2.4'],
  ['1.2.3', '1.3.0'],
  ['1.2.3', '2.0.0'],
  ['1.9.9', '2.0.0'],
  ['0.2.40', '0.2.40-local'],
  ['1.2.3-alpha', '1.2.3-beta'],
  ['0.2.40-local', '0.2.41'],
];
for (const [lo, hi] of ordering) {
  eq(compareSemver(string2semver(lo), string2semver(hi)), -1, `${lo} < ${hi}`);
  eq(compareSemver(string2semver(hi), string2semver(lo)), 1, `${hi} > ${lo}`);
}

// ── isNewer: the entry point ─────────────────────────────────────────────────
const newerCases = [
  ['0.2.40', '0.2.41', true],
  ['0.2.41', '0.2.40', false],
  ['0.2.40', '0.2.40', false],
  ['0.2.40-local', '0.2.40', false],
  ['0.2.40', '0.2.40-local', true],
  ['0.2.40-local', '0.2.41', true],
];
for (const [cur, lat, exp] of newerCases) {
  eq(isNewer(cur, lat), exp, `isNewer(${cur}, ${lat})`);
}
// fallback on unparseable input
eq(isNewer('garbage', 'garbage'), false, 'fallback equal');
eq(isNewer('garbage', 'other'), true, 'fallback differ');

console.log(`semver.test.js: ${passed} assertions passed`);
