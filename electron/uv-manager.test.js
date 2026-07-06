'use strict';

/*
 * Tests for ./uv-manager.js pure helpers + the broken-install detector.
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/uv-manager.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const UvManager = require('./uv-manager');
const { needsShellOnWin, quoteWinCmd, parseNetstatPids } = UvManager;

const IS_WIN = process.platform === 'win32';

let passed = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed++;
}
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

// ── needsShellOnWin ─────────────────────────────────────────────────────────
// The Windows-only branches can only be meaningfully exercised on Windows
// (IS_WIN is captured at module load); on other platforms it must always be
// false so spawn() goes through the native path.
if (IS_WIN) {
  eq(needsShellOnWin('uv'), true, 'bare name → needs shell (PATH lookup)');
  eq(needsShellOnWin('flow.cmd'), true, 'bare .cmd → needs shell');
  eq(needsShellOnWin('C:\\Users\\joe\\.local\\bin\\flow.exe'), true,
    '.exe path without spaces → cmd.exe is fine');
  eq(needsShellOnWin('C:\\Users\\avi tal\\.local\\bin\\flow.exe'), false,
    '.exe path WITH spaces → bypass cmd.exe (it would split on the space)');
  eq(needsShellOnWin('C:\\Users\\avi tal\\.local\\bin\\flow.cmd'), true,
    '.cmd path with spaces still needs the shell (gets quoted)');
} else {
  eq(needsShellOnWin('uv'), false, 'non-Windows → never shell');
  eq(needsShellOnWin('/Users/avi tal/.local/bin/flow'), false, 'non-Windows → never shell (2)');
}

// ── quoteWinCmd ─────────────────────────────────────────────────────────────
eq(quoteWinCmd('uv'), 'uv', 'no whitespace → unchanged');
eq(quoteWinCmd('C:\\bin\\flow.exe'), 'C:\\bin\\flow.exe', 'no whitespace path → unchanged');
eq(quoteWinCmd('C:\\avi tal\\flow.cmd'), '"C:\\avi tal\\flow.cmd"', 'whitespace → quoted');

// ── parseNetstatPids ────────────────────────────────────────────────────────
const netstat = [
  '  TCP    127.0.0.1:9007     0.0.0.0:0         LISTENING       1234',
  '  TCP    0.0.0.0:90071      0.0.0.0:0         LISTENING       5678', // must NOT match 9007
  '  TCP    127.0.0.1:9007     127.0.0.1:55001   ESTABLISHED     9999', // not LISTENING → ignore
  '  TCP    [::]:9007          [::]:0            LISTENING       1234', // ipv6, dup pid
  '  UDP    0.0.0.0:9007       *:*                               4321', // UDP → ignore
].join('\r\n');

eq(parseNetstatPids(netstat, 9007), [1234],
  'only LISTENING TCP rows on the exact local port 9007 (dedup, no :90071, no ESTABLISHED, no UDP)');
eq(parseNetstatPids(netstat, 90071), [5678], 'exact match for 90071 (not greedily matched by 9007)');
eq(parseNetstatPids('', 9007), [], 'empty netstat output → no pids');
eq(parseNetstatPids('garbage\nProto Local Foreign State PID', 9007), [], 'header/garbage → no pids');

// ── isBrokenInstallError (the self-heal trigger) ────────────────────────────
const silentLog = { info() {}, warn() {}, error() {} };
const mgr = new UvManager(silentLog);

ok(mgr.isBrokenInstallError({
  message: "flow start exited with code 1\nstderr:\nModuleNotFoundError: No module named 'flow_sdk'",
}), 'ModuleNotFoundError for flow_sdk in message → broken install');
ok(mgr.isBrokenInstallError({ stderr: "ModuleNotFoundError: No module named 'flow_sdk'" }),
  'same signal carried on error.stderr → broken install');
ok(mgr.isBrokenInstallError({
  message: 'Traceback...\n  File ".../flow_sdk/__init__.py", line 3\nImportError: cannot import name X',
}), 'ImportError whose traceback runs through flow_sdk → broken install');
ok(!mgr.isBrokenInstallError({ message: 'ConnectionRefused: backend port 9007 busy' }),
  'unrelated runtime error → NOT a broken install (no reinstall loop)');
ok(!mgr.isBrokenInstallError({ message: "ModuleNotFoundError: No module named 'requests'" }),
  'a missing module unrelated to flow_sdk (no flow_sdk in text) → NOT treated as broken install');
ok(!mgr.isBrokenInstallError({}), 'empty error object → not broken');
ok(!mgr.isBrokenInstallError(null), 'null error → not broken (no throw)');

// ── isToolDirLockedError (the Windows tool-dir lock that aborts an upgrade) ──
ok(mgr.isToolDirLockedError({
  stderr: "error: failed to remove directory `C:\\Users\\me\\AppData\\Roaming\\uv\\tools\\flowpad\\Scripts`: Access is denied. (os error 5)",
}), 'uv "failed to remove directory …flowpad…: os error 5" → tool dir locked');
ok(mgr.isToolDirLockedError({ message: 'Access is denied. (os error 5)' }),
  'bare "os error 5" → tool dir locked');
ok(!mgr.isToolDirLockedError({ stderr: 'error: Failed to fetch: network unreachable' }),
  'an unrelated network error → NOT a lock (no retry)');
ok(!mgr.isToolDirLockedError({ message: "ModuleNotFoundError: No module named 'flow_sdk'" }),
  'a broken-install error → NOT a tool-dir lock');
ok(!mgr.isToolDirLockedError({}), 'empty error object → not a lock');
ok(!mgr.isToolDirLockedError(null), 'null error → not a lock (no throw)');

// ── _ensureShimOnPath (puts ~/.local/bin on the user's terminal PATH) ───────
// Best-effort: it must call `uv tool update-shell`, and must NEVER throw even
// when uv fails — otherwise a transient PATH-fixer error would abort an
// otherwise-successful install/upgrade.
(async () => {
  const m1 = new UvManager(silentLog);
  let calledWith = null;
  m1._uv = async (args) => { calledWith = args; return { stdout: '', stderr: '' }; };
  await m1._ensureShimOnPath();
  eq(calledWith, ['tool', 'update-shell'], '_ensureShimOnPath runs `uv tool update-shell`');

  const m2 = new UvManager(silentLog);
  m2._uv = async () => { throw new Error('boom'); };
  await m2._ensureShimOnPath(); // must resolve, not reject
  ok(true, '_ensureShimOnPath swallows uv failures (never aborts the install)');

  // ── _pypiUpdateStatus (standalone pre-start check: PyPI vs _version.py) ─────
  // Dependency-free: reads the on-disk version + PyPI directly, so a wedged
  // install that can't run `flow upgrade --info` still gets offered the upgrade.
  {
    const m = new UvManager(silentLog);
    m.getLatestPypiVersion = async () => '0.2.75';
    m.getInstalledVersionSync = () => '0.2.70';
    eq(await m._pypiUpdateStatus(),
      { currentVersion: '0.2.70', latestVersion: '0.2.75', required: true },
      '_pypiUpdateStatus: PyPI newer than installed → offer upgrade');

    m.getInstalledVersionSync = () => null; // broken: _version.py unreadable
    eq(await m._pypiUpdateStatus(),
      { currentVersion: null, latestVersion: '0.2.75', required: true },
      '_pypiUpdateStatus: installed version unknown → offer upgrade (currentVersion null)');

    m.getInstalledVersionSync = () => '0.2.75'; // already at latest
    eq(await m._pypiUpdateStatus(), null,
      '_pypiUpdateStatus: installed == latest → null (no prompt)');

    m.getInstalledVersionSync = () => '0.2.80'; // installed ahead of PyPI (dev/pre-release)
    eq(await m._pypiUpdateStatus(), null,
      '_pypiUpdateStatus: installed newer than PyPI → null (no downgrade prompt)');

    m.getLatestPypiVersion = async () => null; // PyPI unreachable
    m.getInstalledVersionSync = () => null;
    eq(await m._pypiUpdateStatus(), null,
      '_pypiUpdateStatus: PyPI unreachable → null (never prompt offline, even if broken)');
  }

  // ── checkForUpdatesInBackground source selection ───────────────────────────
  // Pre-start decides with the standalone PyPI check (backend down, maybe
  // broken); post-boot uses the cloud `/check-update` policy verdict.
  {
    const make = () => {
      const m = new UvManager(silentLog);
      let pypi = false, cloud = false;
      m._pypiUpdateStatus = async () => { pypi = true; return null; };
      m.getUpdateStatus = async () => { cloud = true; return null; };
      return { m, pypi: () => pypi, cloud: () => cloud };
    };

    const a = make();
    await a.m.checkForUpdatesInBackground(null, { beforeBackendStart: true });
    ok(a.pypi() && !a.cloud(), 'pre-start → standalone PyPI check, not the cloud policy');

    const b = make();
    await b.m.checkForUpdatesInBackground(null, { beforeBackendStart: false });
    ok(b.cloud() && !b.pypi(), 'post-boot → cloud policy, not the standalone PyPI check');
  }

  // ── _uvToolInstallForce (lock-aware install retry) ──────────────────────────
  // Retry ONLY the Windows tool-dir lock; any other error fails fast. Re-kills
  // the holding processes before each attempt.
  {
    // Non-lock error → throw immediately, one attempt, no retry.
    const m = new UvManager(silentLog);
    let uvCalls = 0, kills = 0;
    m._drainVenvProcesses = async () => { kills++; };
    m._uv = async () => { uvCalls++; throw new Error('network unreachable'); };
    let threw = false;
    try { await m._uvToolInstallForce(['tool', 'install', 'flowpad']); } catch { threw = true; }
    ok(threw && uvCalls === 1 && kills === 1,
      '_uvToolInstallForce: non-lock error throws immediately (1 attempt, no retry)');

    // Lock error once, then success → retries and resolves; re-kills each attempt.
    const m2 = new UvManager(silentLog);
    let uv2 = 0, kills2 = 0;
    m2._drainVenvProcesses = async () => { kills2++; };
    m2._uv = async () => {
      uv2++;
      if (uv2 === 1) throw new Error('failed to remove directory flowpad Scripts: Access is denied. (os error 5)');
      return { stdout: '', stderr: '' };
    };
    const res = await m2._uvToolInstallForce(['tool', 'install', 'flowpad']);
    ok(uv2 === 2 && kills2 === 2 && res && typeof res === 'object',
      '_uvToolInstallForce: retries once on a lock error, re-kills, then succeeds');
  }

  console.log(`uv-manager.test.js: ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
