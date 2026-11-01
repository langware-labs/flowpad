'use strict';

/*
 * Engine ownership record (FLOWPAD-2250) — evidence of WHO INSTALLED the flowpad uv tool venv,
 * written by the desktop after each of its own `uv tool install`s and read by the Windows
 * uninstaller (flow-rs) to decide whether the engine may be removed.
 *
 * It is evidence of origin only, never of exclusive use: the uninstaller also requires the
 * absence of every sharing signal (CLI use, other instances, a modified receipt). A missing or
 * unreadable record means "uncertain", and an uncertain engine is preserved.
 *
 * `%LOCALAPPDATA%\Flowpad\engine-ownership.json`:
 *   schema          1
 *   origin          'desktop'          — the desktop created this venv (no venv existed before its install)
 *                   'adopted'          — the desktop installed over a venv it cannot prove it made
 *                   'legacy-inferred'  — backfilled once for a pre-record engine that carries the
 *                                        desktop's install signature (never authorizes deletion alone)
 *   venv            the venv path the record describes
 *   venvVolume      volume serial of the venv directory   } its identity: a venv deleted and
 *   venvFileId      file id of the venv directory         } recreated is a different object
 *   receiptSha256   sha256 of <venv>/uv-receipt.toml       — changes when anyone reinstalls it
 *   desktopVersion  the desktop that wrote the record
 *   installedAt     ISO time
 *
 * The origin is carried forward only while the venv is the very one recorded (same identity,
 * same receipt). Any other pre-existing venv makes the origin 'adopted', and it stays adopted:
 * nothing the desktop does later can prove it made a venv it found.
 */

const crypto = require('crypto');
const path = require('path');

const SCHEMA = 1;
const RECORD_FILE = 'engine-ownership.json';
const RECEIPT_FILE = 'uv-receipt.toml';

function ownershipRecordPath(localAppData) {
  return path.join(localAppData, 'Flowpad', RECORD_FILE);
}

/** `{ volume, fileId }` of `p` as decimal strings (Windows: volume serial + NTFS file index), or null. */
function fileIdentity(statBigint, p) {
  try {
    const st = statBigint(p);
    return { volume: String(st.dev), fileId: String(st.ino) };
  } catch {
    return null;
  }
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** sha256 of `<venv>/uv-receipt.toml`, or null when it cannot be read. */
function receiptSha256(readBytes, venvDir) {
  try {
    return sha256Hex(readBytes(path.join(venvDir, RECEIPT_FILE)));
  } catch {
    return null;
  }
}

/** What the venv looks like right now: `{ exists, identity, receiptSha256 }`. */
function snapshotVenv({ statBigint, readBytes, exists }, venvDir) {
  if (!exists(venvDir)) return { exists: false, identity: null, receiptSha256: null };
  return { exists: true, identity: fileIdentity(statBigint, venvDir), receiptSha256: receiptSha256(readBytes, venvDir) };
}

// ── uv-receipt.toml (the subset the desktop signature needs; no TOML dependency) ─────────────

/** The text of `key = <value>` inside `section`, with a bracketed value followed across lines. */
function tomlValue(text, section, key) {
  const lines = String(text).split(/\r?\n/);
  let current = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) { current = header[1].trim(); continue; }
    if (current !== section) continue;
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!m || m[1] !== key) continue;
    let value = m[2];
    let depth = (value.match(/[[{]/g) || []).length - (value.match(/[\]}]/g) || []).length;
    while (depth > 0 && i + 1 < lines.length) {
      i += 1;
      value += `\n${lines[i]}`;
      depth += (lines[i].match(/[[{]/g) || []).length - (lines[i].match(/[\]}]/g) || []).length;
    }
    return value.trim();
  }
  return null;
}

function parseReceipt(text) {
  const reqText = tomlValue(text, 'tool', 'requirements') || '';
  const requirements = [];
  for (const m of reqText.matchAll(/\{([^}]*)\}/g)) {
    const name = (m[1].match(/name\s*=\s*"([^"]*)"/) || [])[1];
    const specifier = (m[1].match(/specifier\s*=\s*"([^"]*)"/) || [])[1] || '';
    if (name) requirements.push({ name, specifier });
  }
  const compile = tomlValue(text, 'tool.options', 'compile-bytecode');
  const noBuild = tomlValue(text, 'tool.options', 'no-build-package') || '';
  const excludePkg = tomlValue(text, 'tool.options', 'exclude-newer-package') || '';
  return {
    requirements,
    compileBytecode: compile === 'true',
    noBuildPackage: [...noBuild.matchAll(/"([^"]*)"/g)].map((m) => m[1]),
    excludeNewerPackages: [...excludePkg.matchAll(/([A-Za-z0-9_.-]+)\s*=\s*"/g)].map((m) => m[1]),
  };
}

/**
 * Does the receipt carry the flags the desktop's own install passes (`_uvToolInstallForce`)?
 * A hand-typed `uv tool install flowpad` produces none of them.
 */
function hasDesktopInstallSignature(receipt) {
  return receipt.compileBytecode
    && receipt.noBuildPackage.length === 1 && receipt.noBuildPackage[0] === 'cryptography'
    && receipt.excludeNewerPackages.includes('flowpad')
    && receipt.requirements.length === 1
    && receipt.requirements[0].name === 'flowpad'
    && /^==\S+$/.test(receipt.requirements[0].specifier);
}

// ── origin ───────────────────────────────────────────────────────────────────────────────

function sameVenv(record, snapshot) {
  return !!(record && snapshot && snapshot.exists && snapshot.identity
    && record.venvVolume === snapshot.identity.volume
    && record.venvFileId === snapshot.identity.fileId
    && record.receiptSha256 && record.receiptSha256 === snapshot.receiptSha256);
}

/**
 * The origin of the venv a desktop install just produced. `before` is the venv as it was before
 * the install; `prior` the record on disk (or null).
 */
function classifyEngineOrigin({ prior, before }) {
  if (!before || !before.exists) return 'desktop';
  if (prior && ['desktop', 'adopted', 'legacy-inferred'].includes(prior.origin) && sameVenv(prior, before)) return prior.origin;
  return 'adopted';
}

/** The once-only backfill for an engine installed before records existed. */
function inferLegacyOrigin({ receiptText, desktopManaged }) {
  if (receiptText == null) return 'adopted';
  return desktopManaged && hasDesktopInstallSignature(parseReceipt(receiptText)) ? 'legacy-inferred' : 'adopted';
}

function buildRecord({ origin, venv, snapshot, desktopVersion, now }) {
  return {
    schema: SCHEMA,
    origin,
    venv,
    venvVolume: snapshot.identity ? snapshot.identity.volume : null,
    venvFileId: snapshot.identity ? snapshot.identity.fileId : null,
    receiptSha256: snapshot.receiptSha256,
    desktopVersion: desktopVersion || null,
    installedAt: now(),
  };
}

function readRecord(readText, recordPath) {
  try {
    const parsed = JSON.parse(readText(recordPath));
    return parsed && typeof parsed === 'object' && parsed.schema === SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic: a crash mid-write leaves the previous record, never a truncated one. */
function writeRecord({ mkdir, writeText, rename }, recordPath, record) {
  mkdir(path.dirname(recordPath));
  const tmp = `${recordPath}.${process.pid}.tmp`;
  writeText(tmp, JSON.stringify(record, null, 2));
  rename(tmp, recordPath);
}

module.exports = {
  SCHEMA,
  RECORD_FILE,
  RECEIPT_FILE,
  ownershipRecordPath,
  fileIdentity,
  receiptSha256,
  snapshotVenv,
  parseReceipt,
  hasDesktopInstallSignature,
  classifyEngineOrigin,
  inferLegacyOrigin,
  buildRecord,
  readRecord,
  writeRecord,
};
