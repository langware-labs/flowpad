'use strict';

/*
 * Bidirectional desktop <-> engine version compatibility — the pure half.
 *
 * Two floors, each owned by the side that declares it:
 *   - engine-compat.json (this app): { "min_backend_version": "X.Y.Z" } — the oldest engine
 *     (the PyPI `flowpad` backend) this desktop build accepts.
 *   - flow_sdk/compat.json (inside the engine wheel): { "min_desktop_version": "X.Y.Z" } — the
 *     oldest desktop that engine release supports. Plain data in the wheel, so it can be read
 *     from any installed or staged copy without running package code. The Python twin of this
 *     logic is flow_sdk/utils/compat.py.
 *
 * A pair is compatible only when BOTH hold — a newer version is never assumed compatible:
 *     engine_version  >= desktop.min_backend_version
 *     desktop_version >= engine.min_desktop_version
 *
 * Comparisons use the shared semver ordering (semver.js, mirrored 1:1 by
 * flow_sdk/utils/semver.py). A missing file or key is the documented legacy policy — no
 * constraint (releases that predate the contract never declared one) — while an unparseable
 * version against a DECLARED floor is rejected, not waved through. The files are plain JSON
 * objects and unknown keys are ignored, so the format can grow ranges/maximums/exceptions later.
 *
 * Everything here is pure (the engine-reading I/O is injected), so it is unit-testable the way
 * update-plan.js and update-recovery.js are.
 */

const { string2semver, compareSemver } = require('./semver');

// The desktop's own declaration, shipped in the asar next to this module (native-deps.json pattern).
const DESKTOP_COMPAT = Object.freeze(require('./engine-compat.json'));

/** The oldest engine this desktop build accepts, or null (no constraint declared). */
function desktopMinBackendVersion(compat = DESKTOP_COMPAT) {
  const v = compat && compat.min_backend_version;
  return typeof v === 'string' && v ? v : null;
}

/**
 * `version >= floor` under the shared ordering. null floor → true (no constraint);
 * an unparseable side against a declared floor → null (indeterminate — callers reject).
 */
function meetsFloor(version, floor) {
  if (floor === null || floor === undefined) return true;
  const v = string2semver(version);
  const f = string2semver(floor);
  if (!v || !f) return null;
  return compareSemver(v, f) >= 0;
}

/**
 * Parse an engine's `flow_sdk/compat.json` text.
 * @returns {{minDesktopVersion: string|null}} — null floor = legacy, no constraint
 * @throws when the text is not a JSON object (invalid metadata must be seen, not ignored)
 */
function parseEngineCompat(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('engine compat.json must be a JSON object');
  }
  const v = data.min_desktop_version;
  return { minDesktopVersion: typeof v === 'string' && v ? v : null };
}

/**
 * Both directions of the contract for one concrete pair.
 * @returns {{compatible: boolean, reasons: string[]}}
 */
function checkPair({ desktopVersion, engineVersion, minDesktopVersion = null, minBackendVersion = null }) {
  const reasons = [];
  if (minDesktopVersion !== null && minDesktopVersion !== undefined) {
    const ok = meetsFloor(desktopVersion, minDesktopVersion);
    if (ok === null) {
      reasons.push(`cannot compare desktop version ${JSON.stringify(desktopVersion)} with the engine's minimum desktop version ${JSON.stringify(minDesktopVersion)}`);
    } else if (!ok) {
      reasons.push(`FlowPad Backend ${engineVersion} requires Desktop ${minDesktopVersion} or newer (installed Desktop: ${desktopVersion})`);
    }
  }
  if (minBackendVersion !== null && minBackendVersion !== undefined) {
    const ok = meetsFloor(engineVersion, minBackendVersion);
    if (ok === null) {
      reasons.push(`cannot compare engine version ${JSON.stringify(engineVersion)} with the desktop's minimum backend version ${JSON.stringify(minBackendVersion)}`);
    } else if (!ok) {
      reasons.push(`FlowPad Desktop ${desktopVersion} requires Backend ${minBackendVersion} or newer (engine: ${engineVersion})`);
    }
  }
  return { compatible: reasons.length === 0, reasons };
}

/**
 * The newest release compatible with THIS desktop, chosen from metadata — never trial-and-error
 * installs over the working engine.
 *
 * @param {object} o
 * @param {Array<{version: string, yanked?: boolean}>} o.releases  every published release (any order)
 * @param {string} o.desktopVersion            the running desktop app's version
 * @param {string|null} o.minBackendVersion    the desktop's floor (engine-compat.json)
 * @param {(version: string) => Promise<{minDesktopVersion: string|null}|'invalid'|null>} o.readEngineCompat
 *        the candidate release's own floor: an object (null floor = legacy, compatible),
 *        'invalid' (broken metadata → candidate rejected), or null (indeterminate — offline /
 *        read failed → candidate ACCEPTED as legacy; the post-install verification is the
 *        authoritative gate and rolls back if this optimism was wrong)
 * @param {number} [o.limit]   how many candidates to interrogate before giving up
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<{version: string, minDesktopVersion: string|null}|null>} null = no compatible release
 */
async function selectCompatibleRelease({ releases, desktopVersion, minBackendVersion, readEngineCompat, limit = 10, log = () => {} }) {
  const candidates = (releases || [])
    .filter((r) => r && !r.yanked)
    .map((r) => ({ version: r.version, parsed: string2semver(r.version) }))
    .filter((r) => r.parsed && meetsFloor(r.version, minBackendVersion) === true)
    .sort((a, b) => compareSemver(b.parsed, a.parsed)); // newest first

  let interrogated = 0;
  for (const candidate of candidates) {
    if (interrogated >= limit) {
      log(`[compat] gave up after ${limit} candidates — no compatible engine release found among them`);
      return null;
    }
    interrogated += 1;
    const compat = await readEngineCompat(candidate.version);
    if (compat === 'invalid') {
      log(`[compat] ${candidate.version}: invalid compatibility metadata — skipping it`);
      continue;
    }
    const floor = compat ? compat.minDesktopVersion : null;
    const ok = meetsFloor(desktopVersion, floor);
    if (ok === true) return { version: candidate.version, minDesktopVersion: floor };
    log(`[compat] ${candidate.version} requires Desktop ${floor} or newer (this is ${desktopVersion}) — trying an older release`);
  }
  return null;
}

/** The user-facing text for an engine release this desktop cannot run. */
function incompatibleMessage({ desktopVersion, engineVersion, minDesktopVersion }) {
  return (
    `FlowPad Desktop ${desktopVersion} is not compatible with FlowPad Backend ${engineVersion}.\n\n` +
    `This backend requires Desktop ${minDesktopVersion} or newer.\n\n` +
    'Your existing installation has been preserved.'
  );
}

module.exports = {
  DESKTOP_COMPAT,
  desktopMinBackendVersion,
  meetsFloor,
  parseEngineCompat,
  checkPair,
  selectCompatibleRelease,
  incompatibleMessage,
};
