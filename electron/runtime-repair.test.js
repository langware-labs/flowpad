'use strict';

/*
 * Tests for ./runtime-repair.js — the Windows application-control runtime repair, with
 * every effect faked. Run: `node electron/runtime-repair.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const path = require('path');
const {
  PYTHON_RUNTIME_MANIFEST, REQUIRED_IMPORTS, detectPolicyBlockInLog, createPolicyBlockProbe,
  readRuntimeState, writeRuntimeState, runtimeStatePath, canAttemptRepair, recordAttempt, priorAttempt,
  performRuntimeRepair, describeRuntimeBlock,
} = require('./runtime-repair');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const rejects = async (p, re, m) => { await assert.rejects(p, re, m); passed++; };

// The server log from the field report (FLOWPAD-2231, 2026-10-09), verbatim shape.
const FIELD_LOG = [
  '2026-10-09T17:06:26.743Z [boot] t=0.0s phase=import modules=426 last=flow_sdk.boot_progress',
  'Traceback (most recent call last):',
  '  File "<frozen runpy>", line 198, in _run_module_as_main',
  '  File "C:\\Users\\Nava\\AppData\\Roaming\\uv\\tools\\flowpad\\Lib\\site-packages\\flow_sdk\\server\\run.py", line 46, in <module>',
  '    import uvicorn',
  '  File "C:\\Users\\Nava\\AppData\\Roaming\\uv\\tools\\flowpad\\Lib\\site-packages\\uvicorn\\_subprocess.py", line 17, in <module>',
  '    multiprocessing.allow_connection_pickling()',
  '  File "C:\\Users\\Nava\\AppData\\Roaming\\uv\\python\\cpython-3.11.17-windows-x86_64-none\\Lib\\multiprocessing\\connection.py", line 22, in <module>',
  '    import _multiprocessing',
  'ImportError: DLL load failed while importing _multiprocessing: An Application Control policy has blocked this file.',
].join('\n');

// ── manifest ─────────────────────────────────────────────────────────────────
ok(/^[a-f0-9]{64}$/.test(PYTHON_RUNTIME_MANIFEST.sha256), 'the manifest pins a SHA-256');
ok(PYTHON_RUNTIME_MANIFEST.url.startsWith('https://api.nuget.org/v3-flatcontainer/python/3.11.9/'), 'the runtime is the PSF NuGet build (a zip: no installer, no bootstrapper DLL)');
ok(PYTHON_RUNTIME_MANIFEST.fileName.endsWith('.zip'), 'saved with a .zip name for the extractor');
eq(PYTHON_RUNTIME_MANIFEST.archiveRoot, 'tools', 'the interpreter tree inside the archive');
eq(PYTHON_RUNTIME_MANIFEST.signerSubjectCNs, ['Python Software Foundation', 'Microsoft Windows Software Compatibility Publisher'], 'accepted signers: PSF and the Microsoft runtime DLLs');
eq(PYTHON_RUNTIME_MANIFEST.stripDirs, ['Lib\\site-packages'], 'pip/setuptools (unsigned stubs) are stripped');
eq(PYTHON_RUNTIME_MANIFEST.minor, '3.11', 'the fallback satisfies the engine pin');
ok(REQUIRED_IMPORTS.includes('_multiprocessing') && REQUIRED_IMPORTS.includes('_ssl'), 'the module that broke in the field is validated');

// ── detection ────────────────────────────────────────────────────────────────
{
  const m = detectPolicyBlockInLog(FIELD_LOG);
  ok(m, 'the field traceback is detected');
  eq(m.module, '_multiprocessing', 'the blocked module is named');
  ok(m.file && m.file.endsWith('multiprocessing\\connection.py'), 'the frame that triggered the load is named');
  ok(m.traceback.startsWith('Traceback (most recent call last):') && m.traceback.endsWith('has blocked this file.'), 'the whole traceback is preserved');
  ok(m.line.includes('Application Control policy'), 'the offending line is kept verbatim');
}
eq(detectPolicyBlockInLog('2026-10-09 [boot] phase=import\nStarting Flow server on http://127.0.0.1:9007\n'), null, 'a healthy log is not a block');
eq(detectPolicyBlockInLog(''), null, 'empty log');
eq(detectPolicyBlockInLog('ModuleNotFoundError: No module named flow_sdk'), null, 'a broken install is not a policy block');
{
  const m = detectPolicyBlockInLog('error: Failed to spawn: `flow`\n  Caused by: An Application Control policy has blocked this file. (os error 4551)');
  ok(m && m.module === null && m.line.includes('os error 4551'), 'uv\'s own wording is detected too (no module)');
}
{
  const m = detectPolicyBlockInLog('x\nThis program is blocked by group policy. For more information, contact your system administrator.');
  ok(m, 'the shell\'s group-policy wording is detected (enterprise application control)');
}
{
  // Partially written log: the traceback frames are there but the ImportError line has not been
  // flushed yet — no match until the line that names the block arrives.
  const lines = FIELD_LOG.split('\n');
  const partial = lines.slice(0, -1).join('\n');
  eq(detectPolicyBlockInLog(partial), null, 'a traceback without the policy line is not a block yet');
  eq(detectPolicyBlockInLog(partial + '\n' + lines.at(-1).slice(0, 40)), null, 'a half-written last line is not a block yet');
  ok(detectPolicyBlockInLog(partial + '\n' + lines.at(-1)), 'the complete line makes it a block');
}
{
  // Unrelated import errors and ordinary Python failures must not classify as a policy block.
  for (const text of [
    'Traceback (most recent call last):\n  File "x.py", line 1, in <module>\nModuleNotFoundError: No module named \'flow_sdk\'',
    'ImportError: DLL load failed while importing _ssl: The specified module could not be found.',
    'OSError: [WinError 1455] The paging file is too small for this operation to complete.',
    'PermissionError: [Errno 13] Permission denied: \'C:\\\\Users\\\\x\\\\.flow\\\\flowpad.db\'',
    'RuntimeError: Application Control Center is not a module',
  ]) {
    eq(detectPolicyBlockInLog(text), null, `not a policy block: ${text.split('\n').pop().slice(0, 50)}`);
  }
}
{
  // Several monitor restarts: each restart writes a NEW server log; the probe follows the newest
  // file and reports the block from whichever file carries it, with that file's path.
  let current = { path: 'server/1.log' };
  const texts = { 'server/1.log': FIELD_LOG, 'server/2.log': 'booting…', 'server/3.log': FIELD_LOG };
  const p = createPolicyBlockProbe({ newestLogFile: () => current, fileSize: () => 100, readTail: () => texts[current.path], fileMtimeMs: () => Date.now() });
  ok(p() && p().path === 'server/1.log', 'first attempt: block in log 1');
  current = { path: 'server/2.log' };
  eq(p(), null, 'the monitor restarted the server: a fresh log without the block (yet)');
  current = { path: 'server/3.log' };
  ok(p() && p().path === 'server/3.log', 'third attempt: block again, reported from log 3');
  // Rotated/unreadable: a read error is not a block and does not poison later reads.
  let fail = true;
  const q = createPolicyBlockProbe({ newestLogFile: () => ({ path: 'r.log' }), fileSize: () => 50, readTail: () => { if (fail) throw new Error('EBUSY'); return FIELD_LOG; }, fileMtimeMs: () => Date.now() });
  eq(q(), null, 'an unreadable log is not a block');
  fail = false;
  eq(q(), null, 'still cached: unchanged size → not re-read');
  const q2 = createPolicyBlockProbe({ newestLogFile: () => ({ path: 'r.log' }), fileSize: () => { throw new Error('ENOENT'); }, readTail: () => FIELD_LOG, fileMtimeMs: () => Date.now() });
  eq(q2(), null, 'a log that vanished between discovery and stat is not a block');
}
{
  // The probe reads only when the newest file changes, and remembers the last answer.
  let reads = 0;
  let file = { path: 'a.log' };
  let size = 10;
  let text = 'fine';
  const probe = createPolicyBlockProbe({ newestLogFile: () => file, fileSize: () => size, readTail: () => { reads++; return text; }, fileMtimeMs: () => Date.now() });
  eq(probe(), null, 'no block yet');
  eq(reads, 1, 'read once');
  eq(probe(), null, 'unchanged file is not re-read');
  eq(reads, 1, 'still one read');
  size = 20; text = FIELD_LOG;
  const m = probe();
  ok(m && m.module === '_multiprocessing' && m.path === 'a.log', 'growth triggers a read and the block is found, with the log path');
  eq(probe().module, '_multiprocessing', 'the answer is remembered while the file is unchanged');
  file = { path: 'b.log' }; size = 5; text = 'fresh';
  eq(probe(), null, 'a new newest file (restart) is read afresh');
  eq(createPolicyBlockProbe({ newestLogFile: () => null, fileSize: () => 0, readTail: () => '' })(), null, 'no log at all');
}
{
  // Priming: the previous launch's log (old mtime) must not report its block again.
  let reads = 0;
  let size = 500;
  const stale = createPolicyBlockProbe({
    newestLogFile: () => ({ path: 'old.log' }), fileSize: () => size, readTail: () => { reads++; return FIELD_LOG; },
    fileMtimeMs: () => 1_000_000, now: () => 1_000_000 + 60_000,
  });
  eq(stale(), null, 'a log from a minute ago is not read');
  eq(reads, 0, 'not even opened');
  size = 900;
  ok(stale() && stale().module === '_multiprocessing', 'but if that same file grows (the boot reused it), it is read');
  // A fresh file (written within the last seconds) is the current boot's and is read at once.
  const fresh = createPolicyBlockProbe({
    newestLogFile: () => ({ path: 'new.log' }), fileSize: () => 500, readTail: () => FIELD_LOG,
    fileMtimeMs: () => 1_000_000, now: () => 1_000_000 + 1_500,
  });
  ok(fresh() && fresh().module === '_multiprocessing', 'a log written 1.5 s ago is this boot\'s and is read');
  // A primed stale file followed by a NEW file: the new one is read.
  let current = { path: 'old.log' };
  const p = createPolicyBlockProbe({
    newestLogFile: () => current, fileSize: () => 500, readTail: () => FIELD_LOG,
    fileMtimeMs: () => 1_000_000, now: () => 1_000_000 + 60_000,
  });
  eq(p(), null, 'stale primed file ignored');
  current = { path: 'newer.log' };
  ok(p() && p().path === 'newer.log', 'the next boot\'s file is read and reported');
}

// ── state ────────────────────────────────────────────────────────────────────
{
  const files = {};
  const readFile = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
  const writeFile = (p, t) => { files[p] = t; };
  eq(readRuntimeState(readFile, '/s'), {}, 'no file → empty state');
  files[runtimeStatePath('/s')] = '{not json';
  eq(readRuntimeState(readFile, '/s'), {}, 'corrupt file → empty state');
  writeRuntimeState(writeFile, '/s', { python: 'C:\\p\\python.exe' });
  eq(readRuntimeState(readFile, '/s').python, 'C:\\p\\python.exe', 'round trip');
  eq(path.basename(runtimeStatePath('/s')), 'desktop-runtime.json', 'file name');
}
{
  const v = { appVersion: '0.2.52', engineVersion: '0.2.202' };
  ok(canAttemptRepair({}, v), 'first time: may repair');
  const s = recordAttempt({}, { ...v, at: 't1', result: 'failed', detail: 'install: boom' });
  ok(!canAttemptRepair(s, v), 'one attempt per app+engine version');
  eq(priorAttempt(s, v).detail, 'install: boom', 'the prior attempt is readable');
  ok(canAttemptRepair(s, { appVersion: '0.2.53', engineVersion: '0.2.202' }), 'a new app version may try again');
  ok(canAttemptRepair(s, { appVersion: '0.2.52', engineVersion: '0.2.203' }), 'a new engine version may try again');
  ok(canAttemptRepair({ attempts: 'garbage' }, v), 'a malformed attempts field is tolerated');
}

// ── the repair, with fakes ───────────────────────────────────────────────────
function harness(overrides = {}) {
  const calls = [];
  const saved = [];
  const io = {
    existingPythonOrgInstall: async () => { calls.push('existing'); return null; },
    download: async (url, dest, onProgress) => { calls.push(`download ${path.basename(dest)}`); onProgress(50); return PYTHON_RUNTIME_MANIFEST.sha256; },
    extractRuntime: async (zip, targetDir, manifest) => { calls.push(`extract ${path.basename(targetDir)} root=${manifest.archiveRoot}`); },
    verifyRuntimeSignatures: async (dir, signers) => { calls.push(`verify-sigs ${signers.length}`); return { checked: 32, invalid: [] }; },
    validateInterpreter: async (python, mods) => { calls.push(`validate ${path.basename(python)} ${mods.length}`); },
    stageEngine: async (python) => { calls.push(`stage ${path.basename(path.dirname(python))}`); },
    installEngine: async (python) => { calls.push(`engine ${path.basename(path.dirname(python))}`); },
    rollbackEngine: async () => { calls.push('rollback'); },
    finalizeEngine: async () => { calls.push('finalize'); },
    startBackend: async () => { calls.push('start'); },
    healthCheck: async () => { calls.push('health'); return true; },
    remove: async (p) => { calls.push(`remove ${path.basename(p)}`); },
    ...overrides,
  };
  const progress = [];
  const run = (state = {}) => performRuntimeRepair({
    io,
    paths: { runtimeDir: 'C:\\L\\Flowpad\\runtime', downloadsDir: 'C:\\L\\Flowpad\\runtime\\downloads' },
    versions: { appVersion: '0.2.52', engineVersion: '0.2.202' },
    state,
    saveState: (s) => saved.push(JSON.parse(JSON.stringify(s))),
    onProgress: (m) => progress.push(m),
    log: { info() {}, warn() {}, error() {} },
    now: () => '2026-10-10T00:00:00Z',
  });
  return { io, calls, saved, progress, run };
}

(async () => {
  {
    // Happy path: download → hash → signature → install → validate → engine → persist → start → health.
    const h = harness();
    const r = await h.run();
    ok(r.ok && !r.reused, 'repair succeeds');
    eq(r.python, path.join('C:\\L\\Flowpad\\runtime', 'python-3.11.9', 'python.exe'), 'the interpreter path is the runtime folder\'s python.exe');
    eq(h.calls, ['existing', 'download python.3.11.9.nupkg.zip', 'extract python-3.11.9 root=tools', 'verify-sigs 2', 'validate python.exe 5', 'stage python-3.11.9', 'engine python-3.11.9', 'start', 'health', 'finalize'], 'steps in order: every file signature-checked after extraction, staged before the real install, finalized only after health');
    ok(h.saved.length === 2 && h.saved[0].python === r.python && h.saved[0].source === 'python.org', 'the interpreter is persisted BEFORE the engine starts');
    eq(h.saved[1].attempts[0].result, 'ok', 'the successful attempt is recorded');
    ok(h.progress.some((m) => /50%/.test(m)), 'download progress reaches the panel');
    ok(!h.calls.includes('rollback') && !h.calls.some((c) => c.startsWith('remove')), 'nothing removed, nothing rolled back');
  }
  {
    // An official 3.11 is already there: reused, nothing downloaded or installed.
    const h = harness({ existingPythonOrgInstall: async () => ({ python: 'C:\\Users\\n\\AppData\\Local\\Programs\\Python\\Python311\\python.exe' }) });
    const r = await h.run();
    ok(r.ok && r.reused, 'existing install reused');
    ok(!h.calls.some((c) => c.startsWith('download') || c.startsWith('extract')), 'no download, no extraction');
    eq(h.saved[0].source, 'existing', 'recorded as reused');
  }
  {
    // Hash mismatch: the download is removed and NOTHING is extracted.
    const h = harness({ download: async () => 'deadbeef'.repeat(8) });
    await rejects(h.run(), /does not match the expected SHA-256/, 'hash mismatch rejects');
    ok(h.calls.includes('remove python.3.11.9.nupkg.zip'), 'the bad download is deleted');
    ok(!h.calls.some((c) => c.startsWith('extract') || c.startsWith('engine') || c.startsWith('verify-sigs')), 'no extraction, no signature check, no engine change');
    eq(h.saved.at(-1).attempts[0].result, 'failed', 'the failed attempt is recorded');
    ok(/^verify-hash:/.test(h.saved.at(-1).attempts[0].detail), 'with the step that failed');
  }
  {
    // An unsigned file inside the extracted runtime: the runtime dir is removed, nothing used.
    const h = harness({ verifyRuntimeSignatures: async () => ({ checked: 32, invalid: [{ file: 'DLLs\\_ssl.pyd', status: 'NotSigned', subjectCN: null }] }) });
    await rejects(h.run(), /unsigned or unexpectedly signed files \(DLLs\\_ssl\.pyd: NotSigned\)/, 'an unsigned extracted file rejects');
    ok(h.calls.includes('remove python-3.11.9') && !h.calls.some((c) => c.startsWith('validate') || c.startsWith('engine')), 'runtime removed, interpreter never run');
  }
  {
    // Right status, wrong signer, on one file.
    const h = harness({ verifyRuntimeSignatures: async () => ({ checked: 32, invalid: [{ file: 'python.exe', status: 'Valid', subjectCN: 'Nobody Inc.' }] }) });
    await rejects(h.run(), /python\.exe: Valid \(Nobody Inc\.\)/, 'a valid signature by the wrong signer rejects');
  }
  {
    // Nothing checked at all (empty dir) is a failure, not a pass.
    const h = harness({ verifyRuntimeSignatures: async () => ({ checked: 0, invalid: [] }) });
    await rejects(h.run(), /no files checked/, 'zero files checked rejects');
  }
  {
    // Extraction itself is blocked (enterprise policy on PowerShell, or the archive): no engine change, flagged as policy.
    const h = harness({ extractRuntime: async () => { throw Object.assign(new Error('blocked by group policy'), { policyBlocked: true }); } });
    let caught;
    await h.run().catch((e) => { caught = e; });
    ok(caught && caught.step === 'extract' && caught.policyBlocked === true, 'the extract step reports a policy block');
    ok(!h.calls.some((c) => c.startsWith('engine')) && !h.calls.includes('rollback'), 'the engine was never touched, so nothing to roll back');
    eq(caught.rolledBack, false, 'rolledBack is false');
  }
  {
    // Validation of the new interpreter fails: stop before touching the engine.
    const h = harness({ validateInterpreter: async () => { throw new Error('ImportError: _ssl'); } });
    await rejects(h.run(), /cannot load the engine's native modules: ImportError: _ssl/, 'validation failure rejects');
    ok(!h.calls.some((c) => c.startsWith('engine')), 'engine untouched');
  }
  {
    // Staging fails (the engine does not load on the new interpreter): the current install is untouched.
    const h = harness({ stageEngine: async () => { throw Object.assign(new Error('ImportError: DLL load failed while importing _multiprocessing: An Application Control policy has blocked this file.'), { policyBlocked: true }); } });
    let caught;
    await h.run().catch((e) => { caught = e; });
    ok(caught && caught.step === 'stage' && caught.policyBlocked === true, 'the stage step reports the block');
    ok(!h.calls.some((c) => c.startsWith('engine')) && !h.calls.includes('rollback'), 'the tool venv was never touched');
    eq(caught.rolledBack, false, 'nothing to roll back');
  }
  {
    // Engine reinstall fails: roll back, no interpreter persisted.
    const h = harness({ installEngine: async () => { throw new Error('uv exploded'); } });
    let caught;
    await h.run().catch((e) => { caught = e; });
    ok(caught && caught.step === 'install-engine' && caught.rolledBack === true, 'rolled back after a failed engine install');
    ok(h.calls.includes('rollback'), 'rollbackEngine was called');
    ok(!h.saved.some((s) => s.python), 'no interpreter persisted');
    eq(h.saved.at(-1).attempts[0].result, 'failed', 'attempt recorded as failed');
  }
  {
    // Backend never healthy after the repair: roll back AND forget the persisted interpreter.
    const h = harness({ healthCheck: async () => false });
    let caught;
    await h.run().catch((e) => { caught = e; });
    ok(caught && caught.step === 'health' && caught.rolledBack === true, 'unhealthy → rolled back');
    ok(h.saved[0].python && !h.saved.at(-1).python, 'the interpreter persisted before start is cleared again');
    ok(!h.calls.includes('finalize'), 'the set-aside engine is NOT dropped when the repair did not hold');
  }
  {
    // Rollback itself failing is reported, not hidden.
    const h = harness({ healthCheck: async () => false, rollbackEngine: async () => { throw new Error('no network'); } });
    let caught;
    await h.run().catch((e) => { caught = e; });
    ok(caught && caught.rolledBack === false && caught.step === 'health', 'a failed rollback leaves rolledBack false');
  }
  {
    // One attempt per version: a second run refuses before doing anything.
    const h = harness();
    const state = recordAttempt({}, { appVersion: '0.2.52', engineVersion: '0.2.202', at: 't', result: 'failed' });
    await rejects(h.run(state), /already attempted/, 'second attempt refused');
    eq(h.calls, [], 'and nothing ran');
  }
  {
    // The panel text.
    const m = detectPolicyBlockInLog(FIELD_LOG);
    const t = describeRuntimeBlock(m, { repairable: true });
    ok(t.includes('Windows security blocked a component required by FlowPad'), 'opens with the plain-language cause');
    ok(t.includes('"_multiprocessing"'), 'names the module');
    ok(t.includes('Smart App Control or an organization') && !/^Smart App Control/.test(t), 'does not assume Smart App Control');
    ok(t.includes('without changing Windows security settings') && t.includes('Repair FlowPad'), 'offers the repair');
    ok(t.includes(m.line), 'the offending line is shown verbatim');
    const t2 = describeRuntimeBlock(m, { repairable: false, priorFailure: { at: 't1', result: 'failed', detail: 'install: blocked by group policy' } });
    ok(t2.includes('already attempted') && t2.includes('IT approval') && !t2.includes('Repair FlowPad'), 'after a failed attempt: no button, IT may be needed');
  }
  
// ── 2026-10-10, Smart App Control ON: the launcher's Rich-wrapped output, and a wheel module ──
{
  const { detectPolicyBlockInLog, isInterpreterModule, describeRuntimeBlock, unwrapRichLines } = require('./runtime-repair');
  const wrapped = [
    '│ core\\__init__.py:8 in <module>                                              │',
    '└─────────────────────────────────────────────────────────────────────────────┘',
    'ImportError: DLL load failed while importing _pydantic_core: An Application ',
    'Control policy has blocked this file.',
    '',
  ].join('\n');
  const m = detectPolicyBlockInLog(wrapped);
  ok(m && m.module === '_pydantic_core', 'the Rich-wrapped launcher line is recognised, module extracted');
  ok(/An Application Control policy has blocked this file/.test(m.line), 'the two wrapped halves are re-joined');
  const wrappedModule = 'ImportError: DLL load failed while importing\n_pydantic_core: An Application Control policy has blocked this file.';
  eq(detectPolicyBlockInLog(wrappedModule).module, '_pydantic_core', 'a wrap right after "importing" is re-joined too');
  eq(unwrapRichLines('plain\nlines'), 'plain\nlines', 'unrelated line breaks are untouched');
  ok(isInterpreterModule('_multiprocessing') && isInterpreterModule('_ssl') && isInterpreterModule('select'), 'interpreter modules');
  ok(!isInterpreterModule('_pydantic_core') && !isInterpreterModule('cryptography.hazmat.bindings._rust') && !isInterpreterModule(null), 'wheel modules / unknown');
  const text = describeRuntimeBlock({ line: m.line, module: '_pydantic_core', file: null, traceback: '' }, { repairable: true, priorFailure: null });
  ok(/belongs to a Python package, not to the interpreter, so a runtime repair cannot help/.test(text), 'a wheel module: the panel says repair cannot help');
  ok(!/Click “Repair FlowPad”/.test(text), 'and does not invite the repair');
  ok(/gains reputation/.test(text), 'and explains the reputation window');
  const text2 = describeRuntimeBlock({ line: 'x', module: '_multiprocessing', file: null, traceback: '' }, { repairable: true, priorFailure: null });
  ok(/Click “Repair FlowPad”/.test(text2), 'an interpreter module still offers the repair');
}

console.log(`runtime-repair.test.js: ${passed} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
