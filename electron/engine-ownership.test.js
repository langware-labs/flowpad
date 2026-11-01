'use strict';

/*
 * Tests for ./engine-ownership.js and its use in uv-manager.js — the record of who installed
 * the flowpad engine, read by the Windows uninstaller. Run: `node electron/engine-ownership.test.js`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const own = require('./engine-ownership');
const UvManager = require('./uv-manager');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };

// The receipt `uv tool install` wrote for a desktop-installed engine (shape copied from a real one).
const DESKTOP_RECEIPT = [
  '[tool]',
  'requirements = [{ name = "flowpad", specifier = "==0.2.240" }]',
  'python = "3.11"',
  'entrypoints = [',
  '    { name = "flow", install-path = "C:\\\\Users\\\\u\\\\.local\\\\bin\\\\flow.exe", from = "flowpad" },',
  '    { name = "flow-sdk-mcp", install-path = "C:\\\\Users\\\\u\\\\.local\\\\bin\\\\flow-sdk-mcp.exe", from = "flowpad" },',
  ']',
  '',
  '[tool.options]',
  'prerelease = "disallow"',
  'exclude-newer = "2026-10-26T17:57:25Z"',
  'exclude-newer-package = { aiohttp = "2026-08-28T20:50:48Z", flowpad = "2026-10-26T17:57:25Z", zstandard = "2026-08-28T20:50:48Z" }',
  'compile-bytecode = true',
  'no-build-package = ["cryptography"]',
  '',
].join('\n');

// `uv tool install flowpad` typed by hand.
const HAND_RECEIPT = [
  '[tool]',
  'requirements = [{ name = "flowpad" }]',
  'entrypoints = [{ name = "flow", install-path = "/home/u/.local/bin/flow", from = "flowpad" }]',
  '',
  '[tool.options]',
  'exclude-newer-package = {}',
  '',
].join('\n');

// ── receipt parsing and the desktop signature ────────────────────────────────
{
  const r = own.parseReceipt(DESKTOP_RECEIPT);
  eq(r.requirements, [{ name: 'flowpad', specifier: '==0.2.240' }], 'requirements parsed');
  ok(r.compileBytecode, 'compile-bytecode parsed');
  eq(r.noBuildPackage, ['cryptography'], 'no-build-package parsed');
  ok(r.excludeNewerPackages.includes('flowpad') && r.excludeNewerPackages.includes('aiohttp'), 'exclude-newer-package keys parsed');
  ok(own.hasDesktopInstallSignature(r), 'a desktop receipt carries the signature');

  ok(!own.hasDesktopInstallSignature(own.parseReceipt(HAND_RECEIPT)), 'a hand-typed install does not');

  const multiline = DESKTOP_RECEIPT.replace(
    'requirements = [{ name = "flowpad", specifier = "==0.2.240" }]',
    'requirements = [\n    { name = "flowpad", specifier = "==0.2.240" },\n]',
  );
  ok(own.hasDesktopInstallSignature(own.parseReceipt(multiline)), 'a multi-line requirements array parses the same');

  const withExtra = DESKTOP_RECEIPT.replace(
    'requirements = [{ name = "flowpad", specifier = "==0.2.240" }]',
    'requirements = [{ name = "flowpad", specifier = "==0.2.240" }, { name = "rich" }]',
  );
  ok(!own.hasDesktopInstallSignature(own.parseReceipt(withExtra)), 'a `--with` extra breaks the signature (someone customised it)');
  ok(!own.hasDesktopInstallSignature(own.parseReceipt(DESKTOP_RECEIPT.replace('==0.2.240', '>=0.2'))), 'a range specifier is not the desktop pin');
  ok(!own.hasDesktopInstallSignature(own.parseReceipt(DESKTOP_RECEIPT.replace('compile-bytecode = true', 'compile-bytecode = false'))), 'compile-bytecode must be on');
  ok(!own.hasDesktopInstallSignature(own.parseReceipt(DESKTOP_RECEIPT.replace('no-build-package = ["cryptography"]', ''))), 'no-build-package must be there');
  ok(!own.hasDesktopInstallSignature(own.parseReceipt(DESKTOP_RECEIPT.replace(' flowpad = "2026-10-26T17:57:25Z",', ''))), 'flowpad must be in exclude-newer-package');
  ok(!own.hasDesktopInstallSignature(own.parseReceipt('')), 'an empty receipt has no signature');
}

// ── origin ───────────────────────────────────────────────────────────────────
{
  const venv = { exists: true, identity: { volume: '7', fileId: '100' }, receiptSha256: 'aaa' };
  const rec = (origin, extra = {}) => ({ schema: 1, origin, venvVolume: '7', venvFileId: '100', receiptSha256: 'aaa', ...extra });
  eq(own.classifyEngineOrigin({ prior: null, before: { exists: false } }), 'desktop', 'no venv before the install: the desktop made it');
  eq(own.classifyEngineOrigin({ prior: rec('adopted'), before: { exists: false } }), 'desktop', 'even with an old record: a fresh venv is the desktop\'s');
  eq(own.classifyEngineOrigin({ prior: null, before: venv }), 'adopted', 'a venv with no record: adopted');
  eq(own.classifyEngineOrigin({ prior: rec('desktop'), before: venv }), 'desktop', 'the desktop upgrading its own recorded venv stays desktop');
  eq(own.classifyEngineOrigin({ prior: rec('desktop', { venvFileId: '999' }), before: venv }), 'adopted', 'a recreated venv (new identity) is not the recorded one');
  eq(own.classifyEngineOrigin({ prior: rec('desktop', { venvVolume: '8' }), before: venv }), 'adopted', 'another volume is not the recorded one');
  eq(own.classifyEngineOrigin({ prior: rec('desktop', { receiptSha256: 'bbb' }), before: venv }), 'adopted', 'someone reinstalled it since: adopted');
  eq(own.classifyEngineOrigin({ prior: rec('desktop', { receiptSha256: null }), before: { ...venv, receiptSha256: null } }), 'adopted', 'an unreadable receipt proves nothing');
  eq(own.classifyEngineOrigin({ prior: rec('adopted'), before: venv }), 'adopted', 'adopted is sticky');
  eq(own.classifyEngineOrigin({ prior: rec('legacy-inferred'), before: venv }), 'legacy-inferred', 'legacy-inferred is carried forward, not promoted');
  eq(own.classifyEngineOrigin({ prior: rec('weird'), before: venv }), 'adopted', 'an unknown origin value is not trusted');

  eq(own.inferLegacyOrigin({ receiptText: DESKTOP_RECEIPT, desktopManaged: true }), 'legacy-inferred', 'signature + marker: legacy-inferred');
  eq(own.inferLegacyOrigin({ receiptText: DESKTOP_RECEIPT, desktopManaged: false }), 'adopted', 'the signature alone is not enough');
  eq(own.inferLegacyOrigin({ receiptText: HAND_RECEIPT, desktopManaged: true }), 'adopted', 'the marker alone is not enough');
  eq(own.inferLegacyOrigin({ receiptText: null, desktopManaged: true }), 'adopted', 'no receipt: adopted');
}

// ── record I/O and venv identity, on a real temp folder ──────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-ownership-'));
const realIo = {
  statBigint: (p) => fs.statSync(p, { bigint: true }),
  readBytes: (p) => fs.readFileSync(p),
  exists: (p) => fs.existsSync(p),
};
const writeIo = {
  mkdir: (d) => fs.mkdirSync(d, { recursive: true }),
  writeText: (p, t) => fs.writeFileSync(p, t, 'utf8'),
  rename: (a, b) => fs.renameSync(a, b),
};
try {
  const venv = path.join(tmp, 'tools', 'flowpad');
  fs.mkdirSync(venv, { recursive: true });
  fs.writeFileSync(path.join(venv, own.RECEIPT_FILE), DESKTOP_RECEIPT);
  const s1 = own.snapshotVenv(realIo, venv);
  ok(s1.exists && s1.identity && /^\d+$/.test(s1.identity.fileId) && /^[0-9a-f]{64}$/.test(s1.receiptSha256), 'snapshot: identity and receipt hash');

  const moved = `${venv}.pre-repair`;
  fs.renameSync(venv, moved);
  eq(own.snapshotVenv(realIo, moved).identity, s1.identity, 'a rename keeps the directory identity (what the pre-repair fallback relies on)');
  fs.renameSync(moved, venv);

  fs.writeFileSync(path.join(venv, own.RECEIPT_FILE), HAND_RECEIPT);
  ok(own.snapshotVenv(realIo, venv).receiptSha256 !== s1.receiptSha256, 'rewriting the receipt changes its hash');
  eq(own.snapshotVenv(realIo, path.join(tmp, 'nope')), { exists: false, identity: null, receiptSha256: null }, 'a missing venv');

  const recordPath = own.ownershipRecordPath(path.join(tmp, 'Local'));
  eq(path.relative(tmp, recordPath), path.join('Local', 'Flowpad', 'engine-ownership.json'), 'record location');
  const record = own.buildRecord({ origin: 'desktop', venv, snapshot: s1, desktopVersion: '0.2.60', now: () => 'T' });
  own.writeRecord(writeIo, recordPath, record);
  eq(own.readRecord((p) => fs.readFileSync(p, 'utf8'), recordPath), record, 'record round-trips');
  eq(fs.readdirSync(path.dirname(recordPath)), ['engine-ownership.json'], 'no temp file left behind');
  fs.writeFileSync(recordPath, '{ truncated');
  eq(own.readRecord((p) => fs.readFileSync(p, 'utf8'), recordPath), null, 'a corrupt record reads as none');
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, schema: 99 }));
  eq(own.readRecord((p) => fs.readFileSync(p, 'utf8'), recordPath), null, 'an unknown schema reads as none');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── uv-manager: the record follows every desktop install ─────────────────────
(async () => {
  const silent = { info() {}, warn() {}, error() {} };
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvm-ownership-'));
    const m = new UvManager(silent, { stateDir: path.join(dir, '.flow'), appVersion: '0.2.60' });
    const venv = path.join(dir, 'uv', 'tools', 'flowpad');
    const recordPath = path.join(dir, 'Local', 'Flowpad', 'engine-ownership.json');
    m._toolVenvDir = () => venv;
    m._engineOwnershipPath = () => recordPath;
    m._writeInstallMarker = () => {};
    m._clearInstallMarker = () => {};
    const read = () => own.readRecord((p) => fs.readFileSync(p, 'utf8'), recordPath);
    const makeVenv = (receipt = DESKTOP_RECEIPT) => { fs.mkdirSync(venv, { recursive: true }); fs.writeFileSync(path.join(venv, own.RECEIPT_FILE), receipt); };
    return { dir, m, venv, recordPath, read, makeVenv, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };

  {
    // A first install (no venv before): origin desktop, describing the venv uv produced.
    const t = setup();
    try {
      t.m._uvToolInstallForceAttempts = async () => { t.makeVenv(); return 'ok'; };
      eq(await t.m._uvToolInstallForce(['tool', 'install', 'flowpad==0.2.60']), 'ok', 'the install result is passed through');
      const r = t.read();
      ok(r && r.origin === 'desktop' && r.venv === t.venv && r.desktopVersion === '0.2.60', 'first install recorded as desktop');
      eq(r.receiptSha256, own.snapshotVenv(t.m._ownershipFs(), t.venv).receiptSha256, 'with the receipt uv wrote');

      // The desktop upgrading its own venv: still desktop, record follows the new receipt.
      t.m._uvToolInstallForceAttempts = async () => { fs.writeFileSync(path.join(t.venv, own.RECEIPT_FILE), DESKTOP_RECEIPT.replace('0.2.240', '0.2.241')); };
      await t.m._uvToolInstallForce(['tool', 'install', 'flowpad==0.2.61']);
      eq(t.read().origin, 'desktop', 'own upgrade stays desktop');
      ok(t.read().receiptSha256 !== r.receiptSha256, 'and records the new receipt');

      // Someone else reinstalls it outside the desktop, then the desktop installs over it: adopted.
      fs.writeFileSync(path.join(t.venv, own.RECEIPT_FILE), HAND_RECEIPT);
      t.m._uvToolInstallForceAttempts = async () => { fs.writeFileSync(path.join(t.venv, own.RECEIPT_FILE), DESKTOP_RECEIPT); };
      await t.m._uvToolInstallForce(['tool', 'install', 'flowpad==0.2.62']);
      eq(t.read().origin, 'adopted', 'a venv changed behind the desktop\'s back becomes adopted');
      await t.m._uvToolInstallForce(['tool', 'install', 'flowpad==0.2.63']);
      eq(t.read().origin, 'adopted', 'and stays adopted');
    } finally { t.done(); }
  }
  {
    // A venv that existed before the desktop ever installed (no record): adopted.
    const t = setup();
    try {
      t.makeVenv(HAND_RECEIPT);
      t.m._uvToolInstallForceAttempts = async () => { fs.writeFileSync(path.join(t.venv, own.RECEIPT_FILE), DESKTOP_RECEIPT); };
      await t.m._uvToolInstallForce(['tool', 'install', 'flowpad==0.2.60']);
      eq(t.read().origin, 'adopted', 'installing over a pre-existing engine adopts it');
    } finally { t.done(); }
  }
  {
    // The runtime repair sets the live venv aside before reinstalling. The aside copy stands in for
    // it, so an adopted engine is not laundered into a desktop one.
    const t = setup();
    try {
      t.makeVenv(HAND_RECEIPT);
      t.m._uvToolInstallForceAttempts = async () => { fs.writeFileSync(path.join(t.venv, own.RECEIPT_FILE), DESKTOP_RECEIPT); };
      await t.m._uvToolInstallForce(['tool', 'install', 'flowpad==0.2.60']);
      eq(t.read().origin, 'adopted', 'precondition: adopted');
      fs.renameSync(t.venv, `${t.venv}.pre-repair`);
      t.m._uvToolInstallForceAttempts = async () => { t.makeVenv(); };
      await t.m._uvToolInstallForce(['tool', 'install', 'flowpad==0.2.60', '--reinstall']);
      eq(t.read().origin, 'adopted', 'a repair reinstall over an adopted engine stays adopted');
    } finally { t.done(); }
  }
  {
    // A failed install writes nothing; a disabled path (tests, non-Windows) writes nothing.
    const t = setup();
    try {
      t.m._uvToolInstallForceAttempts = async () => { throw new Error('uv failed'); };
      await assert.rejects(t.m._uvToolInstallForce(['tool', 'install', 'flowpad']), /uv failed/); passed++;
      ok(!fs.existsSync(t.recordPath), 'a failed install records nothing');
      t.m._engineOwnershipPath = () => null;
      t.m._uvToolInstallForceAttempts = async () => { t.makeVenv(); };
      await t.m._uvToolInstallForce(['tool', 'install', 'flowpad']);
      ok(!fs.existsSync(t.recordPath), 'no record when ownership is disabled');
    } finally { t.done(); }
    const real = new UvManager(silent, {});
    eq(real._engineOwnershipPath(), null, 'no stateDir (tests, tools): ownership disabled');
  }
  {
    // A record that cannot be written never fails the install.
    const t = setup();
    try {
      t.m._writeOwnershipRecord = () => { throw new Error('disk full'); };
      t.m._uvToolInstallForceAttempts = async () => { t.makeVenv(); return 'ok'; };
      eq(await t.m._uvToolInstallForce(['tool', 'install', 'flowpad']), 'ok', 'an unwritable record does not fail the install');
    } finally { t.done(); }
  }
  {
    // Backfill: once, for an engine installed before records existed.
    const t = setup();
    try {
      t.m.backfillEngineOwnership();
      ok(!fs.existsSync(t.recordPath), 'no venv: nothing to backfill');

      t.makeVenv();
      fs.mkdirSync(path.join(t.dir, '.flow', 'instances', 'prod'), { recursive: true });
      fs.writeFileSync(path.join(t.dir, '.flow', 'instances', 'prod', '.desktop_managed'), '');
      t.m.backfillEngineOwnership();
      eq(t.read().origin, 'legacy-inferred', 'desktop signature + marker: legacy-inferred');

      fs.writeFileSync(t.recordPath, JSON.stringify({ ...t.read(), origin: 'desktop' }));
      t.m.backfillEngineOwnership();
      eq(t.read().origin, 'desktop', 'an existing record is never overwritten by the backfill');
    } finally { t.done(); }
  }
  {
    const t = setup();
    try {
      t.makeVenv();
      t.m.backfillEngineOwnership();
      eq(t.read().origin, 'adopted', 'signature without the desktop marker: adopted');
    } finally { t.done(); }
  }
  {
    const t = setup();
    try {
      t.makeVenv(HAND_RECEIPT);
      fs.mkdirSync(path.join(t.dir, '.flow', 'instances', 'prod'), { recursive: true });
      fs.writeFileSync(path.join(t.dir, '.flow', 'instances', 'prod', '.desktop_managed'), '');
      t.m.backfillEngineOwnership();
      eq(t.read().origin, 'adopted', 'marker without the desktop signature: adopted');
    } finally { t.done(); }
  }

  // ── the desktop's own `flow` calls are marked as the desktop's ─────────────
  {
    const m = new UvManager(silent, {});
    const seen = [];
    m._run = async (cmd, args, options) => { seen.push({ args, env: options.env }); return { stdout: '{}', stderr: '' }; };
    m._flowBin = '/x/flow';
    m._flowCmd = (args) => ({ cmd: '/x/flow', args });
    await m._flowStop();
    await m._getUpgradeInfo();
    eq(seen.map((s) => s.args[0]), ['stop', 'upgrade'], 'both calls ran');
    ok(seen.every((s) => s.env && s.env.FLOWPAD_DESKTOP === '1'), 'flow stop and flow upgrade --info carry FLOWPAD_DESKTOP=1');
  }

  console.log(`engine-ownership.test.js: ${passed} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
