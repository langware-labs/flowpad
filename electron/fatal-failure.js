'use strict';

/*
 * The monitor's verdict, read by the desktop app (FLOWPAD-2231).
 *
 * When the backend dies for a reason restarting cannot change, the Python supervisor
 * (flow_sdk/server/launch.py, via flow_sdk/server/failure_classification.py) stops
 * supervising and writes `<instance>/server-failure.json`. This module is the only reader
 * of that file on the Electron side: the shape is the classifier's `to_record()`, and the
 * two are tested against the same sample (fixtures/server-failure.sample.json) so the
 * monitor and Electron always name the same reason.
 *
 * Pure: file access is injected, nothing here touches Electron.
 */

const path = require('path');

const FAILURE_FILE = 'server-failure.json';
const SCHEMA_VERSION = 1;

// Mirrors failure_classification.py. Kinds the runtime repair addresses, and the two that
// mean Windows application control refused something (the panel wording differs).
const FATAL_KINDS = new Set(['policy-blocked', 'interpreter-blocked', 'native-missing', 'unsupported-arch', 'runtime-integrity', 'crash-loop']);
const REPAIRABLE_KINDS = new Set(['policy-blocked', 'interpreter-blocked', 'native-missing', 'unsupported-arch', 'runtime-integrity']);
const POLICY_KINDS = new Set(['policy-blocked', 'interpreter-blocked']);

// A record older than this when the wait began belongs to a previous launch (the monitor
// writes a fresh one on every fatal death). Same idea as runtime-repair's STALE_LOG_MS.
const STALE_RECORD_MS = 5000;

const RETRY_WARNING =
  'Retrying without changing anything is unlikely to help: the engine was stopped because this failure ' +
  'repeats deterministically. Fix the cause first (repair the runtime, or ask IT to allow the blocked files), ' +
  'then retry.';

function failureRecordPath(instanceDir) {
  return path.join(instanceDir, FAILURE_FILE);
}

/** The record, or null when the text is not a record this app understands. */
function parseFailureRecord(text) {
  let data;
  try { data = JSON.parse(String(text)); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  if (data.schema !== SCHEMA_VERSION) return null;
  if (typeof data.kind !== 'string' || !data.kind) return null;
  if (typeof data.fatal !== 'boolean') return null;
  return data;
}

/** `readFile(path)` returns text or throws. Missing/unreadable/garbage → null. */
function readFailureRecord(readFile, instanceDir) {
  try { return parseFailureRecord(readFile(failureRecordPath(instanceDir))); } catch { return null; }
}

/** `unlink(path)` may throw; returns whether a record was removed. */
function clearFailureRecord(unlink, instanceDir) {
  try { unlink(failureRecordPath(instanceDir)); return true; } catch { return false; }
}

function isFatalRecord(record) {
  return !!record && record.fatal === true && FATAL_KINDS.has(record.kind);
}

function isPolicyKind(kind) { return POLICY_KINDS.has(kind); }
function isRepairableKind(kind) { return REPAIRABLE_KINDS.has(kind); }

/**
 * Same rule as failure_classification.same_fingerprint, by components: the interpreter path
 * (case- and slash-insensitive — Python's sys.executable and the path Electron builds from the
 * home directory can differ in case on Windows) and the engine version. Equal hashes short-cut;
 * `platform` is compared only when both sides spell it the same way (Electron does not set it).
 */
function normalizePython(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}
function sameFingerprint(a, b) {
  if (!a || !b) return false;
  if (a.hash && b.hash && a.hash === b.hash) return true;
  if (!a.python || !b.python || normalizePython(a.python) !== normalizePython(b.python)) return false;
  if ((a.engine_version || null) !== (b.engine_version || null)) return false;
  if (a.platform && b.platform && a.platform !== b.platform) return false;
  return true;
}

/** Does a persisted record describe the runtime the app is about to start? */
function recordMatchesRuntime(record, runtime) {
  return !!record && sameFingerprint(record.fingerprint, runtime);
}

/**
 * A probe for the startup gate: "did the monitor record a fatal failure for THIS boot?"
 * Returns the record, or null. A record written before `startedAt` (minus a small grace) is
 * a previous launch's and is ignored — that one is handled before the backend is started
 * (recordMatchesRuntime), never mid-wait.
 */
function createFailureRecordProbe({ readRecord, startedAt, graceMs = STALE_RECORD_MS }) {
  let last = null;
  return function probe() {
    const record = readRecord();
    if (!record || !isFatalRecord(record)) return (last = null);
    const at = Date.parse(record.at || '');
    if (Number.isFinite(at) && at < startedAt - graceMs) return (last = null);
    last = record;
    return last;
  };
}

/**
 * The record as the shape handleRuntimeBlocked already understands (runtime-repair.js's
 * detectPolicyBlockInLog match): line, module, file, traceback, path.
 */
function policyMatchFromRecord(record) {
  return {
    line: record.excerpt || record.reason || record.kind,
    module: record.module || null,
    file: (record.evidence && record.evidence.file) || null,
    traceback: record.traceback || record.excerpt || '',
    path: record.server_log || '(server log)',
    kind: record.kind,
    fromMonitor: true,
  };
}

/**
 * One reason, whichever side saw it first. The monitor's record is authoritative when it
 * exists; Electron's own log probe (runtime-repair.js) is the fallback for a block the
 * monitor did not get to record (an older engine, a monitor that died). When both exist
 * they must agree — `agree` is false only when they name different modules, which is
 * logged, never shown as two errors.
 */
function reconcileFatalReason({ record, probeMatch }) {
  if (record && isFatalRecord(record)) {
    if (!probeMatch) return { kind: record.kind, source: 'monitor', agree: true, match: policyMatchFromRecord(record), record };
    const agree = isPolicyKind(record.kind) && (!record.module || !probeMatch.module || record.module === probeMatch.module);
    return { kind: record.kind, source: 'both', agree, match: policyMatchFromRecord(record), record };
  }
  if (probeMatch) return { kind: 'policy-blocked', source: 'electron', agree: true, match: probeMatch, record: null };
  return null;
}

/** What the panel says for a fatal record that is NOT a policy block (those have their own text). */
function describeFatalFailure(record) {
  const lines = [record.reason || `The FlowPad engine stopped (${record.kind}).`];
  if (record.excerpt) lines.push('', 'Last error:', `  ${record.excerpt}`);
  const n = Number(record.attempts) || 0;
  lines.push('', `The engine's supervisor stopped restarting it${n ? ` after ${n} attempt${n === 1 ? '' : 's'}` : ''}: the same failure repeats.`);
  if (record.server_log) lines.push(`Server log: ${record.server_log}`);
  lines.push('', RETRY_WARNING);
  return lines.join('\n');
}

module.exports = {
  FAILURE_FILE,
  SCHEMA_VERSION,
  FATAL_KINDS,
  REPAIRABLE_KINDS,
  POLICY_KINDS,
  RETRY_WARNING,
  failureRecordPath,
  parseFailureRecord,
  readFailureRecord,
  clearFailureRecord,
  isFatalRecord,
  isPolicyKind,
  isRepairableKind,
  sameFingerprint,
  recordMatchesRuntime,
  createFailureRecordProbe,
  policyMatchFromRecord,
  reconcileFatalReason,
  describeFatalFailure,
};
