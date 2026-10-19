'use strict';
// Tests for fatal-failure.js: the monitor's record as the desktop app reads it (FLOWPAD-2231).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ff = require('./fatal-failure');

let count = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); count++; };
const ok = (v, m) => { assert.ok(v, m); count++; };

const SAMPLE_PATH = path.join(__dirname, 'fixtures', 'server-failure.sample.json');
const sampleText = fs.readFileSync(SAMPLE_PATH, 'utf8');
const sample = JSON.parse(sampleText);

// ── parsing the monitor's record ────────────────────────────────────────────
{
  const r = ff.parseFailureRecord(sampleText);
  ok(r && r.kind === 'policy-blocked' && r.fatal === true, 'the Python classifier\'s record parses');
  eq(r.module, '_multiprocessing', 'module carried through');
  ok(r.traceback.startsWith('Traceback (most recent call last)'), 'traceback carried through');
  eq(ff.parseFailureRecord('{"kind":"policy-blocked","fatal":true}'), null, 'a record without the schema version is refused');
  eq(ff.parseFailureRecord('{"schema":1,"kind":"","fatal":true}'), null, 'an empty kind is refused');
  eq(ff.parseFailureRecord('{"schema":1,"kind":"x","fatal":"yes"}'), null, 'fatal must be a boolean');
  eq(ff.parseFailureRecord('garbage'), null, 'garbage → null');
  eq(ff.readFailureRecord(() => { throw new Error('ENOENT'); }, '/x'), null, 'missing file → null');
  eq(ff.readFailureRecord((p) => { eq(p, path.join('/inst', 'server-failure.json'), 'path = <instance>/server-failure.json'); return sampleText; }, '/inst').kind, 'policy-blocked', 'read + parse');
  let unlinked = null;
  ok(ff.clearFailureRecord((p) => { unlinked = p; }, '/inst') && unlinked === path.join('/inst', 'server-failure.json'), 'clear unlinks the record');
  ok(!ff.clearFailureRecord(() => { throw new Error('ENOENT'); }, '/inst'), 'clear of a missing record → false');
}

// ── fatal / policy / repairable ─────────────────────────────────────────────
{
  ok(ff.isFatalRecord(sample), 'the sample is fatal');
  ok(!ff.isFatalRecord({ ...sample, fatal: false }), 'fatal:false is not fatal whatever the kind');
  ok(!ff.isFatalRecord({ ...sample, kind: 'unknown' }), 'an unknown kind is not fatal');
  ok(ff.isPolicyKind('policy-blocked') && ff.isPolicyKind('interpreter-blocked') && !ff.isPolicyKind('crash-loop'), 'policy kinds');
  ok(ff.isRepairableKind('native-missing') && !ff.isRepairableKind('crash-loop'), 'repairable kinds');
}

// ── fingerprint: "the same server under unchanged conditions" ───────────────
{
  const fp = sample.fingerprint;
  ok(ff.sameFingerprint(fp, { ...fp }), 'same hash → same');
  ok(ff.sameFingerprint(fp, { python: fp.python.toUpperCase().replace(/\\\\/g, '/'), engine_version: fp.engine_version }), 'no hash on the Electron side: same interpreter (any case/slashes) + engine → same');
  ok(!ff.sameFingerprint(fp, { python: fp.python, engine_version: '0.2.204' }), 'another engine version → different');
  ok(!ff.sameFingerprint(fp, { python: 'C:/other/python.exe', engine_version: fp.engine_version }), 'another interpreter → different');
  ok(!ff.sameFingerprint(fp, { ...fp, hash: 'other', platform: 'linux-x86_64' }), 'same components but a different platform spelled by both → different');
  ok(ff.sameFingerprint({ python: 'a', engine_version: '1', platform: 'p' }, { python: 'a', engine_version: '1', platform: 'p' }), 'no hashes: component comparison');
  ok(!ff.sameFingerprint(fp, null) && !ff.sameFingerprint(null, fp), 'null → not same');
  ok(ff.recordMatchesRuntime(sample, fp), 'the record matches the runtime it was written for');
  ok(!ff.recordMatchesRuntime(sample, { ...fp, hash: 'repaired', python: 'C:/repaired/python.exe' }), 'a repaired runtime does not match');
}

// ── the gate probe: only a record for THIS boot ends the wait ───────────────
{
  const startedAt = Date.parse(sample.at) + 1000; // this boot began 1 s after the record was written
  let current = null;
  const probe = ff.createFailureRecordProbe({ readRecord: () => current, startedAt });
  eq(probe(), null, 'no record → null');
  current = sample;
  ok(probe() === sample, 'a record written within the grace window counts');
  const stale = ff.createFailureRecordProbe({ readRecord: () => sample, startedAt: Date.parse(sample.at) + 60 * 1000 });
  eq(stale(), null, 'a record from a previous launch (older than the grace) is ignored');
  const nonFatal = ff.createFailureRecordProbe({ readRecord: () => ({ ...sample, fatal: false }), startedAt });
  eq(nonFatal(), null, 'a non-fatal record never ends the wait');
  const noDate = ff.createFailureRecordProbe({ readRecord: () => ({ ...sample, at: undefined }), startedAt });
  ok(noDate() && noDate().kind === 'policy-blocked', 'a record without a timestamp is taken as current');
}

// ── the record as a runtime-repair match ────────────────────────────────────
{
  const m = ff.policyMatchFromRecord(sample);
  eq(m.module, '_multiprocessing', 'match.module');
  ok(m.line.startsWith('ImportError: DLL load failed'), 'match.line is the excerpt');
  ok(m.file.endsWith('connection.py'), 'match.file from evidence');
  eq(m.path, sample.server_log, 'match.path is the server log');
  ok(m.fromMonitor === true && m.kind === 'policy-blocked', 'marked as the monitor\'s');
}

// ── test 15: the monitor and Electron agree ─────────────────────────────────
{
  const probeMatch = { line: 'ImportError: DLL load failed while importing _multiprocessing: An Application Control policy has blocked this file.', module: '_multiprocessing', file: 'x.py', traceback: '…', path: 'log' };
  const both = ff.reconcileFatalReason({ record: sample, probeMatch });
  eq([both.kind, both.source, both.agree], ['policy-blocked', 'both', true], 'same module from both sides → agree, monitor kind wins');
  ok(both.match.fromMonitor, 'the monitor\'s record is the one shown');
  const disagree = ff.reconcileFatalReason({ record: sample, probeMatch: { ...probeMatch, module: '_ssl' } });
  eq([disagree.kind, disagree.agree], ['policy-blocked', false], 'different modules → flagged, still one reason');
  const monitorOnly = ff.reconcileFatalReason({ record: sample, probeMatch: null });
  eq([monitorOnly.kind, monitorOnly.source], ['policy-blocked', 'monitor'], 'record alone');
  const electronOnly = ff.reconcileFatalReason({ record: null, probeMatch });
  eq([electronOnly.kind, electronOnly.source, electronOnly.match === probeMatch], ['policy-blocked', 'electron', true], 'Electron\'s own probe as the fallback');
  eq(ff.reconcileFatalReason({ record: { ...sample, fatal: false }, probeMatch: null }), null, 'a non-fatal record and no probe → nothing');
}

// ── panel text for non-policy kinds ─────────────────────────────────────────
{
  const text = ff.describeFatalFailure({ ...sample, kind: 'crash-loop', reason: 'The FlowPad engine exited 5 times in a row without ever becoming healthy.', excerpt: 'Segmentation fault', attempts: 5, server_log: 'C:/log' });
  ok(text.includes('exited 5 times') && text.includes('Segmentation fault') && text.includes('after 5 attempts') && text.includes('C:/log'), 'reason, excerpt, attempts, log');
  ok(text.includes(ff.RETRY_WARNING), 'the retry warning is always there');
  const one = ff.describeFatalFailure({ kind: 'native-missing', fatal: true, reason: 'r', attempts: 1 });
  ok(one.includes('after 1 attempt:'), 'singular');
}

console.log(`fatal-failure.test.js: ${count} assertions passed`);
