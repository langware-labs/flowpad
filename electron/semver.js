'use strict';

/*
 * Shared semver-ish parsing and comparison.
 *
 * This module is mirrored 1:1 in flow_sdk/utils/semver.py — the SEMVER_RE
 * pattern and the string2semver / comparison rules MUST stay equivalent across
 * the two. If you change one, change the other.
 *
 * Rules:
 *   - Extract the FIRST <num>.<num>.<num> triple found anywhere in a string
 *     (so "flowpad v0.2.40" and "v0.2.40-local" both parse).
 *   - Anything trailing the patch number is the "extra" tag (e.g. the "-local"
 *     in "0.2.40-local"). A leading -/+/./_ separator is stripped.
 *   - A version WITH an extra tag is considered NEWER than the same version
 *     without one — i.e. 2.3.4-somenote > 2.3.4 (the OPPOSITE of the SemVer
 *     pre-release rule; intentional for this project).
 *   - Missing numbers / garbage / empty input → string2semver returns null.
 */

// SHARED REGEX — mirror of SEMVER_RE in flow_sdk/utils/semver.py.
// Captures major, minor, patch, and any trailing non-space "extra" tag.
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)([^\s]*)/;

// Leading separators stripped off the extra tag before it is stored/compared.
const EXTRA_LEAD_RE = /^[-+._]+/;

/**
 * Parse the first <num>.<num>.<num>[extra] out of `text`.
 * @returns {{major:number,minor:number,patch:number,extra:string}|null}
 *   null when no full major.minor.patch triple is present.
 */
function string2semver(text) {
  if (!text) return null;
  const m = String(text).match(SEMVER_RE);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    extra: (m[4] || '').replace(EXTRA_LEAD_RE, ''),
  };
}

function _cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Return -1 if a < b, 0 if equal, 1 if a > b (shared ordering). */
function compareSemver(a, b) {
  return (
    _cmp(a.major, b.major) ||
    _cmp(a.minor, b.minor) ||
    _cmp(a.patch, b.patch) ||
    // an extra tag sorts AFTER (newer than) no tag; both present → lexical
    _cmp(a.extra ? 1 : 0, b.extra ? 1 : 0) ||
    _cmp(a.extra, b.extra)
  );
}

/**
 * True if `latest` is a newer version than `current`. Falls back to plain
 * string inequality when either side cannot be parsed, so behaviour never
 * silently regresses to "no update" on odd input.
 */
function isNewer(current, latest) {
  const cur = string2semver(current);
  const lat = string2semver(latest);
  if (!cur || !lat) return latest !== current;
  return compareSemver(lat, cur) > 0;
}

module.exports = { SEMVER_RE, string2semver, compareSemver, isNewer };
