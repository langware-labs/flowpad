'use strict';

/*
 * Tests for ./uv-manager.js pure helpers + the broken-install detector.
 * No test runner is wired up for electron/, so this is a self-contained node
 * script: `node electron/uv-manager.test.js` (exits non-zero on failure).
 */

const assert = require('assert');
const UvManager = require('./uv-manager');
const {
  needsShellOnWin, quoteWinCmd, parseNetstatPids, isInstallProgressLine,
  pythonVersionFromPyproject, getPythonVersion, tryPythonVersion, upgradeCommand,
  pythonFloor, maxPythonVersion, isPolicyBlockError, PY_FLOW_ENTRY, policyBlockedError,
  UV_INSTALL_SH, UV_INSTALL_PS1, installFailure, cleanPythonEnv, mktempShimSource, windowsPowerShellModulePath,
} = UvManager;

const IS_WIN = process.platform === 'win32';

// Existing `_uvToolInstallForce` tests must not resolve (and scan) the developer's REAL uv directories:
// default to "no directories" (guard = 240 s cap only, timers unref'd and cleared). Guard tests override it.
const realUvDirs = UvManager.prototype._uvDirs;
UvManager.prototype._uvDirs = async () => null;

// SAFETY NET: no test may run the REAL uv installer or a real `uv tool install` on the machine that
// runs the tests (it rewrites ~/.local/bin/uv and the uv receipt, and would install flowpad into the
// developer's tool dir). Every such call must be stubbed on the instance; one that is not fails
// loudly here instead of quietly touching the machine. (A real one ran once, before this existed.)
{
  const realRunStreaming = UvManager.prototype._runStreaming;
  UvManager.prototype._runStreaming = function guardedRunStreaming(cmd, args, opts) {
    const line = `${cmd} ${(args || []).join(' ')}`;
    if (/astral\.sh|\btool install\b|\btool run\b/.test(line)) {
      throw new Error(`test attempted a REAL install command (stub _runStreaming on the instance): ${line.slice(0, 120)}`);
    }
    return realRunStreaming.call(this, cmd, args, opts);
  };
}

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

// ── PYTHON_VERSION (read from pyproject.toml, never hand-pinned) ────────────
eq(pythonVersionFromPyproject('requires-python = ">=3.11"\n'), '3.11', '>= floor');
eq(pythonVersionFromPyproject('[project]\nname = "x"\nrequires-python = ">=3.12,<3.14"\n'),
  '3.12', 'floor of a bounded range');
eq(pythonVersionFromPyproject('requires-python = ">= 3.11.2"\n'), '3.11',
  'patch component dropped — uv pins a minor');
assert.throws(() => pythonVersionFromPyproject('name = "x"\n'), /no `requires-python`/,
  'missing requires-python is a build error, not a silent default');
assert.throws(() => pythonVersionFromPyproject('requires-python = "==3.11.*"\n'), /no ">=" floor/,
  'a specifier without a >= floor is a build error');
passed += 2;
{
  // The runtime value must be whatever the repo's pyproject.toml declares —
  // the whole point is that the shell cannot drift from the package.
  const repoToml = require('fs').readFileSync(require('path').join(__dirname, '..', 'pyproject.toml'), 'utf8');
  const floor = pythonVersionFromPyproject(repoToml);
  eq(getPythonVersion(), floor, 'getPythonVersion() == repo requires-python floor');
  ok(/^\d+\.\d+$/.test(floor), `pin is a bare minor (${floor})`);
  eq(tryPythonVersion(), floor, 'tryPythonVersion() returns the pin when the file exists');
  eq(upgradeCommand(), `uv tool install flowpad@latest --python ${floor} --force`,
    'recovery command mirrors the install with the pin');
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

  // ── ensureUv → PATH repair right after a FRESH uv install ──────────────────
  // Astral's installer skips its rc-file edit when ~/.local/bin is already on
  // PATH — which it always is under _enrichedPath(). So a fresh install must be
  // followed by `uv tool update-shell` immediately, or a first-time setup that
  // dies later leaves `uv` unreachable from the user's terminal. An already-
  // present uv must NOT trigger the repair (no rc-file edit on every launch).
  // The fresh-install leg stubs _runStreaming (the installer script); on
  // Windows ensureUv spawns powershell.exe directly, which would really
  // download uv — so that leg is Unix-only.
  if (!IS_WIN) {
    // Fresh install: `uv --version` fails once (not installed), the installer
    // runs, then `uv --version` passes → update-shell must follow.
    const m = new UvManager(silentLog);
    const calls = [];
    let versionCalls = 0;
    m._uv = async (args) => {
      calls.push(args);
      if (args[0] === '--version' && versionCalls++ === 0) throw new Error('not found');
      return { stdout: '', stderr: '' };
    };
    m._run = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' }; };
    m._runStreaming = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' }; };
    await m.ensureUv();
    ok(calls.some((c) => c[0] === 'tool' && c[1] === 'update-shell'),
      'ensureUv runs `uv tool update-shell` right after installing uv');
    const installIdx = calls.findIndex((c) => c[0] !== '--version' && c[0] !== 'tool');
    const shellIdx = calls.findIndex((c) => c[0] === 'tool' && c[1] === 'update-shell');
    ok(installIdx === -1 || installIdx < shellIdx,
      'update-shell runs AFTER the installer, not before');
  }
  {
    // uv already present: no installer, no update-shell.
    const m3 = new UvManager(silentLog);
    const calls3 = [];
    m3._uv = async (args) => { calls3.push(args); return { stdout: '', stderr: '' }; };
    await m3.ensureUv();
    eq(calls3, [['--version']], 'ensureUv with uv present only probes --version (no PATH edit)');
  }

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
    m._runStreaming = async () => { uvCalls++; throw new Error('network unreachable'); };
    let threw = false;
    try { await m._uvToolInstallForce(['tool', 'install', 'flowpad']); } catch { threw = true; }
    ok(threw && uvCalls === 1 && kills === 1,
      '_uvToolInstallForce: non-lock error throws immediately (1 attempt, no retry)');

    // Lock error once, then success → retries and resolves; re-kills each attempt.
    const m2 = new UvManager(silentLog);
    let uv2 = 0, kills2 = 0;
    m2._drainVenvProcesses = async () => { kills2++; };
    m2._runStreaming = async () => {
      uv2++;
      if (uv2 === 1) throw new Error('failed to remove directory flowpad Scripts: Access is denied. (os error 5)');
      return { stdout: '', stderr: '' };
    };
    const res = await m2._uvToolInstallForce(['tool', 'install', 'flowpad']);
    ok(uv2 === 2 && kills2 === 2 && res && typeof res === 'object',
      '_uvToolInstallForce: retries once on a lock error, re-kills, then succeeds');
  }

  // ── isCorruptEnvError (half-written tool env detector) ──────────────────────
  // Matches uv's "Invalid environment / missing Python executable" ONLY for the
  // flowpad tool path; a generic uv message, a network error, or a lock error
  // (which belongs to isToolDirLockedError) must not trigger a rebuild.
  {
    const m = new UvManager(silentLog);
    const err = (s) => ({ stderr: s });
    ok(m.isCorruptEnvError(err(
      'error: Invalid environment at `~/.local/share/uv/tools/flowpad`: ' +
      'missing Python executable at `.../flowpad/bin/python3`')),
      'isCorruptEnvError: matches "Invalid environment / missing Python executable" for flowpad');
    ok(!m.isCorruptEnvError(err('Invalid environment: missing Python executable at /other/tool/bin/python3')),
      'isCorruptEnvError: does NOT match a non-flowpad tool env');
    ok(!m.isCorruptEnvError(err('error: failed to fetch: network unreachable')),
      'isCorruptEnvError: does NOT match a network error');
    ok(!m.isCorruptEnvError({ message: 'failed to remove directory flowpad Scripts: os error 5' }),
      'isCorruptEnvError: does NOT match a lock error');
  }

  // ── _uvToolInstallForce: quarantine + rebuild on a corrupt env ──────────────
  // A corrupt-env error → move the half-written venv aside and retry (rebuild).
  {
    const m = new UvManager(silentLog);
    let uv = 0, drains = 0, quarantines = 0;
    m._drainVenvProcesses = async () => { drains++; };
    m._quarantineToolVenv = () => { quarantines++; };
    m._runStreaming = async () => {
      uv++;
      if (uv === 1) throw new Error('Invalid environment: missing Python executable at .../flowpad/bin/python3');
      return { stdout: '', stderr: '' };
    };
    const res = await m._uvToolInstallForce(['tool', 'install', 'flowpad']);
    ok(uv === 2 && quarantines === 1 && drains === 2 && res && typeof res === 'object',
      '_uvToolInstallForce: quarantines the corrupt env once, then rebuilds and succeeds');
  }

  // ── upgrade() pins the higher of bundled Python and the release's floor ─────
  eq(pythonFloor('>=3.12,<3.14'), '3.12', 'pythonFloor: floor of a range');
  eq(pythonFloor(null), null, 'pythonFloor: missing requires_python → null');
  eq(maxPythonVersion('3.11', '3.12'), '3.12', 'maxPythonVersion: newer wins');
  eq(maxPythonVersion('3.12', '3.9'), '3.12', 'maxPythonVersion: numeric, not lexical');
  eq(maxPythonVersion('3.11', null), '3.11', 'maxPythonVersion: null loses');
  {
    const bundled = tryPythonVersion();
    const m = new UvManager(silentLog);
    let seen = null;
    m._uvToolInstallForce = async (args) => { seen = args; };
    m._ensureShimOnPath = async () => {};
    m._resolveFlowBin = async () => null;
    m._getLatestPypiInfo = async () => ({ version: '9.9.9', requires_python: '>=99.1' });
    await m.upgrade();
    eq(seen, ['tool', 'install', 'flowpad@latest', '--python', '99.1', '--force'],
      'upgrade: release needs newer Python than the bundle → pin the release floor');
    m._getLatestPypiInfo = async () => null; // PyPI unreachable
    await m.upgrade();
    eq(seen, ['tool', 'install', 'flowpad@latest', '--python', bundled, '--force'],
      'upgrade: no PyPI answer → bundled pin');
  }

  {
    // Pin selection: never below the bundled pin, never below the release floor.
    const m = new UvManager(silentLog);
    const bundled = tryPythonVersion();
    m._getLatestPypiInfo = async () => ({ version: '9.9.9', requires_python: '>=3.8' });
    eq(await m._pythonPinForUpgrade(), bundled, 'pin: release floor below the bundle → bundled pin');
    m._getLatestPypiInfo = async () => ({ version: '9.9.9', requires_python: `>=${bundled}` });
    eq(await m._pythonPinForUpgrade(), bundled, 'pin: release floor equals the bundle → same pin');
    m._getLatestPypiInfo = async () => ({ version: '9.9.9' }); // no requires_python
    eq(await m._pythonPinForUpgrade(), bundled, 'pin: release without requires_python → bundled pin');
  }

  // ── upgrade({version}): install the release the user already agreed to, not "latest" ──
  {
    const mk = (over = {}) => {
      const m = new UvManager(silentLog);
      m.args = null;
      m._uvToolInstallForce = async (a) => { m.args = a; };
      m._ensureShimOnPath = async () => {};
      m._resolveFlowBin = async () => null;
      Object.assign(m, over);
      return m;
    };
    const bundled = tryPythonVersion();

    // The exact version, with THAT release's Python floor (not the latest's).
    let m = mk({
      _getPypiVersionInfo: async (v) => ({ version: v, requires_python: '>=99.1', yanked: false }),
      _getLatestPypiInfo: async () => { throw new Error('latest must not be consulted for a healthy pinned version'); },
    });
    await m.upgrade({ version: '0.2.180' });
    eq(m.args, ['tool', 'install', 'flowpad==0.2.180', '--python', '99.1', '--force'], 'upgrade({version}): flowpad==X, pinned to X\'s own requires_python');

    // Without a version it is still "@latest" (the periodic / engine-only path).
    m = mk({ _getLatestPypiInfo: async () => ({ version: '9.9.9', requires_python: '>=99.2' }) });
    await m.upgrade();
    eq(m.args, ['tool', 'install', 'flowpad@latest', '--python', '99.2', '--force'], 'upgrade(): unchanged, still @latest');

    // The agreed version was yanked since: installing it would be deliberate self-harm — take the latest release.
    m = mk({
      _getPypiVersionInfo: async () => ({ version: '0.2.180', requires_python: '>=3.11', yanked: true, yanked_reason: 'crashes on start' }),
      _getLatestPypiInfo: async () => ({ version: '0.2.181', requires_python: '>=99.3' }),
    });
    await m.upgrade({ version: '0.2.180' });
    eq(m.args, ['tool', 'install', 'flowpad==0.2.181', '--python', '99.3', '--force'], 'a yanked agreed version is replaced by the latest release (and its floor)');

    // Yanked and the latest cannot be fetched: nothing better is known, so the agreed version is used.
    m = mk({
      _getPypiVersionInfo: async () => ({ version: '0.2.180', requires_python: '>=99.4', yanked: true }),
      _getLatestPypiInfo: async () => null,
    });
    await m.upgrade({ version: '0.2.180' });
    eq(m.args.slice(2), ['flowpad==0.2.180', '--python', '99.4', '--force'], 'yanked + PyPI unreachable for the latest: falls back to the agreed version');

    // PyPI unreachable altogether: install the agreed version with the bundled pin.
    m = mk({ _getPypiVersionInfo: async () => null });
    await m.upgrade({ version: '0.2.180' });
    eq(m.args, ['tool', 'install', 'flowpad==0.2.180', '--python', bundled, '--force'], 'offline: the agreed version, bundled pin');

    // Release without requires_python metadata: bundled pin.
    m = mk({ _getPypiVersionInfo: async (v) => ({ version: v, yanked: false }) });
    await m.upgrade({ version: '0.2.180' });
    eq(m.args[3] + ' ' + m.args[4], `--python ${bundled}`, 'no requires_python on the release: bundled pin');

    // _getPypiVersionInfo itself: URL, failures.
    const realFetch = global.fetch; const urls = [];
    try {
      global.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => ({ info: { version: '0.2.180', yanked: false } }) }; };
      eq((await new UvManager(silentLog)._getPypiVersionInfo('0.2.180')).version, '0.2.180', '_getPypiVersionInfo returns the release info');
      eq(urls, ['https://pypi.org/pypi/flowpad/0.2.180/json'], 'asks PyPI for THAT release');
      global.fetch = async () => ({ ok: false, status: 404 });
      eq(await new UvManager(silentLog)._getPypiVersionInfo('0.0.0'), null, 'an unknown release (404) → null');
      global.fetch = async () => { throw new Error('offline'); };
      eq(await new UvManager(silentLog)._getPypiVersionInfo('0.2.180'), null, 'a network failure → null');
    } finally { global.fetch = realFetch; }
  }

  // ── every install path pins Python (installLatest / reinstall too) ──────────
  {
    const seen = [];
    const mk = () => {
      const m = new UvManager(silentLog);
      m._uvToolInstallForce = async (args) => { seen.push(args); };
      m._ensureShimOnPath = async () => {};
      m._resolveFlowBin = async () => null;
      m._getLatestPypiInfo = async () => ({ version: '9.9.9', requires_python: '>=99.1' });
      return m;
    };
    await mk().installLatest();
    eq(seen[0], ['tool', 'install', 'flowpad', '--python', '99.1', '--force'],
      'installLatest: pins the release floor when it is above the bundled pin');
    await mk().reinstall();
    eq(seen[1], ['tool', 'install', 'flowpad', '--python', '99.1', '--reinstall', '--force'],
      'reinstall: pins the release floor when it is above the bundled pin');
  }

  // ── interrupted install: marker, abort, repair ──────────────────────────────
  {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvm-marker-'));
    const marker = path.join(dir, 'desktop-install-in-progress.json');
    const mk = () => {
      const m = new UvManager(silentLog, { stateDir: dir });
      m._drainVenvProcesses = async () => {};
      return m;
    };
    try {
      // Marker exists WHILE uv runs, is gone after success.
      let during = null;
      let m = mk();
      m._runStreaming = async () => { during = fs.existsSync(marker); return { stdout: '', stderr: '' }; };
      eq(m.isInstalling(), false, 'isInstalling: false before an install');
      await m._uvToolInstallForce(['tool', 'install', 'flowpad']);
      eq(during, true, 'marker: written before uv starts');
      eq(fs.existsSync(marker), false, 'marker: cleared after a successful install');
      eq(m.isInstalling(), false, 'isInstalling: false after an install');

      // A clean uv failure also clears it (uv reports its own state).
      m = mk();
      m._runStreaming = async () => { throw new Error('No solution found when resolving dependencies'); };
      await m._uvToolInstallForce(['tool', 'install', 'flowpad']).then(
        () => { throw new Error('should have thrown'); },
        (e) => eq(/No solution/.test(e.message), true, 'a clean uv failure still propagates'),
      );
      eq(fs.existsSync(marker), false, 'marker: cleared after a clean uv failure');

      // Abort mid-install: child signalled, marker KEPT, hadInterruptedInstall true.
      m = mk();
      let killed = null;
      const child = { pid: 4242, exitCode: null, kill: (sig) => { killed = sig; } };
      let release;
      m._runStreaming = (_c, _a, opts) => new Promise((resolve, reject) => {
        opts.onChild(child);
        release = () => reject(new Error('killed'));
      });
      const running = m._uvToolInstallForce(['tool', 'install', 'flowpad']).catch(() => {});
      await new Promise((r) => setImmediate(r));
      eq(m.isInstalling(), true, 'isInstalling: true while uv runs');
      eq(m.abortInstall(), true, 'abortInstall: reports a running install');
      if (process.platform !== 'win32') eq(killed, 'SIGTERM', 'abortInstall: signals the child');
      release();
      await running;
      eq(fs.existsSync(marker), true, 'marker: kept after an aborted install');
      eq(m.hadInterruptedInstall(), true, 'hadInterruptedInstall: true after an abort');
      eq(m.abortInstall(), false, 'abortInstall: nothing running afterwards');

      // repairIfInterrupted: reinstalls once and clears the marker.
      let reinstalls = 0;
      m = mk();
      m.ensureUv = async () => {};
      m.reinstall = async () => { reinstalls++; };
      eq(await m.repairIfInterrupted(), true, 'repairIfInterrupted: repairs when the marker exists');
      eq(reinstalls, 1, 'repairIfInterrupted: reinstall ran once');

      // A failed repair keeps the marker for the next launch.
      m.reinstall = async () => { throw new Error('offline'); };
      fs.writeFileSync(marker, '{}');
      await m.repairIfInterrupted().then(() => { throw new Error('should have thrown'); }, () => {});
      eq(m.hadInterruptedInstall(), true, 'repairIfInterrupted: failed repair keeps the marker');

      // No marker → no-op.
      fs.rmSync(marker, { force: true });
      reinstalls = 0;
      m.reinstall = async () => { reinstalls++; };
      eq(await m.repairIfInterrupted(), false, 'repairIfInterrupted: no marker → no-op');
      eq(reinstalls, 0, 'repairIfInterrupted: no reinstall without a marker');

      // uv killed from OUTSIDE (a signal) after it started → the venv may be half-replaced → keep.
      fs.rmSync(marker, { force: true });
      m = mk();
      m._runStreaming = async (_c, _a, opts) => {
        opts.onChild({ pid: 1, exitCode: null, kill() {} });
        const e = new Error('uv was killed'); e.signal = 'SIGKILL'; throw e;
      };
      await m._uvToolInstallForce(['tool', 'install', 'flowpad']).catch(() => {});
      eq(fs.existsSync(marker), true, 'marker: kept when uv is killed by a signal');
      eq(m.hasInstallMarker(), true, 'hasInstallMarker: true while the marker file exists');

      // ...but an ordinary uv failure after it started leaves a state uv reports → clear.
      fs.rmSync(marker, { force: true });
      m = mk();
      m._runStreaming = async (_c, _a, opts) => {
        opts.onChild({ pid: 1, exitCode: null, kill() {} });
        throw new Error('No solution found when resolving dependencies');
      };
      await m._uvToolInstallForce(['tool', 'install', 'flowpad']).catch(() => {});
      eq(fs.existsSync(marker), false, 'marker: cleared on an ordinary uv failure even after it started');

      // Abort BEFORE uv started (during the drain) changed nothing → no repair next launch.
      m = mk();
      let spawnedUv = false;
      let releaseDrain;
      m._drainVenvProcesses = () => new Promise((r) => { releaseDrain = r; });
      m._runStreaming = async () => { spawnedUv = true; return { stdout: '', stderr: '' }; };
      const early = m._uvToolInstallForce(['tool', 'install', 'flowpad']).then(() => 'done', (e) => e.message);
      await new Promise((r) => setImmediate(r));
      eq(m.abortInstall(), true, 'abortInstall during the drain reports a running install');
      releaseDrain();
      eq(await early, 'install aborted before uv started', 'aborted before spawn: the install stops');
      eq(spawnedUv, false, 'aborted before spawn: uv was never started');
      eq(fs.existsSync(marker), false, 'aborted before spawn: marker cleared (nothing was touched)');

      // A marker owned by another LIVE process is an install in flight, not an interrupted one.
      fs.writeFileSync(marker, JSON.stringify({ pid: process.ppid }));
      eq(mk().hadInterruptedInstall(), false, 'marker owned by a live foreign pid → not interrupted');
      const dead = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
      fs.writeFileSync(marker, JSON.stringify({ pid: Number(dead.stdout) }));
      eq(mk().hadInterruptedInstall(), true, 'marker owned by a dead pid → interrupted');
      fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }));
      eq(mk().hadInterruptedInstall(), true, 'marker owned by this process (stale) → interrupted');
      fs.writeFileSync(marker, 'not json');
      eq(mk().hadInterruptedInstall(), true, 'unreadable marker → interrupted');

      // A successful repair through the REAL reinstall/_uvToolInstallForce clears the marker.
      fs.writeFileSync(marker, JSON.stringify({ pid: 999999999 }));
      m = mk();
      m.ensureUv = async () => {};
      m._getLatestPypiInfo = async () => null;
      m._ensureShimOnPath = async () => {};
      m._resolveFlowBin = async () => null;
      m._runStreaming = async (_c, _a, opts) => { opts.onChild({ pid: 1, exitCode: null, kill() {} }); return { stdout: '', stderr: '' }; };
      eq(await m.repairIfInterrupted(), true, 'repair through the real reinstall runs');
      eq(fs.existsSync(marker), false, 'repair success: the marker is gone');

      // stateDir null → marker disabled (the default; tests and tools stay out of $HOME).
      const off = new UvManager(silentLog);
      eq(off.hadInterruptedInstall(), false, 'marker disabled without a stateDir');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── application control (WDAC / Device Guard): detect the block, find a launcher that runs ──
  {
    const blockedCmd = Object.assign(new Error('Command failed'), { stderr: 'This program is blocked by group policy. For more information, contact your system administrator.' });
    const blockedUv = Object.assign(new Error('Command failed'), { stderr: 'error: Failed to spawn: `flow`\n  Caused by: An Application Control policy has blocked this file. (os error 4551)' });
    const blockedSpawn = Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' });
    const deviceGuard = Object.assign(new Error("'flow.exe' was blocked by your organization's Device Guard policy"), {});
    for (const [name, e] of [['cmd.exe group policy', blockedCmd], ['uv os error 4551', blockedUv], ['spawn UNKNOWN', blockedSpawn], ['Device Guard', deviceGuard]]) {
      eq(isPolicyBlockError(e), true, `isPolicyBlockError: ${name}`);
    }
    for (const [name, e] of [
      ['ENOENT', Object.assign(new Error('spawn flow ENOENT'), { code: 'ENOENT' })],
      ['a timeout', Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' })],
      ['a normal failure', Object.assign(new Error('Command failed'), { code: 1, stderr: 'error: No solution found when resolving dependencies' })],
      ['nothing', null],
    ]) {
      eq(isPolicyBlockError(e), false, `isPolicyBlockError: ${name} is not a policy block`);
    }

    // Probe sequence, driven by a fake _run. `outcomes` maps a launcher's command to what it does.
    const mk = (outcomes) => {
      const m = new UvManager(silentLog);
      m._isWindows = () => true;
      m._flowBin = 'C:\\u\\.local\\bin\\flow.exe';
      m._venvPython = () => 'C:\\u\\uv\\tools\\flowpad\\Scripts\\python.exe';
      m.ran = [];
      m._run = async (cmd, args, opts) => {
        m.ran.push({ cmd, args, shell: opts && opts.shell });
        const o = outcomes[cmd.includes('flow.exe') ? 'shim' : cmd === 'uv' ? 'uv' : 'python'];
        if (o === 'ok') return { stdout: '', stderr: '' };
        throw o;
      };
      return m;
    };
    const TIMEOUT = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });

    let m = mk({ shim: 'ok' });
    await m._probeFlowBinOnce();
    eq([m._launcher, m.ran.length, m._policyBlocked], ['shim', 1, null], 'shim works → nothing else is tried');
    eq(m._flowCmd(['start']), { cmd: m._flowBin, args: ['start'] }, 'shim launcher: the plain shim command');

    m = mk({ shim: TIMEOUT });
    await m._probeFlowBinOnce();
    eq([m._launcher, m.ran.length], ['shim', 1], 'a slow shim is not a policy verdict → no fallbacks tried');

    m = mk({ shim: blockedCmd, uv: 'ok' });
    await m._probeFlowBinOnce();
    eq(m._launcher, 'uv', 'shim blocked, uv allowed → `uv tool run`');
    eq(m._flowCmd(['start']).cmd, 'uv', 'uv launcher command');

    m = mk({ shim: blockedCmd, uv: blockedUv, python: 'ok' });
    await m._probeFlowBinOnce();
    eq(m._launcher, 'python', 'shim and uv blocked (uv spawns the same exe), python allowed → the venv python');
    const pyCmd = m._flowCmd(['start']);
    eq([pyCmd.cmd, pyCmd.args, pyCmd.shell], ['C:\\u\\uv\\tools\\flowpad\\Scripts\\python.exe', ['-c', PY_FLOW_ENTRY, 'start'], false],
      'python launcher: -c entry point, args after it, and shell:false (cmd.exe would mangle the -c argument)');
    ok(/from flow_sdk\.cli import cli_main/.test(PY_FLOW_ENTRY) && /cli_main\(\)/.test(PY_FLOW_ENTRY), 'the entry point is the console script\'s target');
    eq(m.ran[m.ran.length - 1].shell, false, 'the python probe itself also runs without a shell');

    m = mk({ shim: blockedCmd, uv: Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }), python: 'ok' });
    await m._probeFlowBinOnce();
    eq(m._launcher, 'python', 'uv missing (not a policy block, but not usable) → still tries python');

    m = mk({ shim: blockedCmd, uv: blockedUv, python: blockedSpawn });
    await m._probeFlowBinOnce();
    eq(m._launcher, 'shim', 'nothing worked: launcher unchanged');
    eq(m._policyBlocked.tried.map((t) => t.launcher), ['shim', 'uv tool run', 'venv python'], 'every blocked launcher is recorded');
    let thrown = null;
    try { m._assertNotPolicyBlocked(); } catch (e) { thrown = e; }
    ok(thrown && thrown.policyBlocked === true, 'start() would fail with a policyBlocked error');
    eq(thrown.blockedPaths.length, 3, 'the error carries the blocked paths for the panel');

    m = mk({ shim: 'ok' });
    m._isWindows = () => false;
    await m._probeFlowBinOnce();
    eq(m.ran.length, 0, 'not Windows → no probing at all');

    m = mk({ shim: 'ok' });
    await m._probeFlowBinOnce(); await m._probeFlowBinOnce();
    eq(m.ran.length, 1, 'the probe runs once per session');
  }

  // ── first install: the uv bootstrap reports the real cause ─────────────────
  {
    // The Unix installer script, run for real against local files in place of astral.sh. (Skipped
    // where sh/curl are missing — Windows uses the PowerShell path below.)
    const { spawnSync } = require('child_process');
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const haveShCurl = !IS_WIN && spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).status === 0;
    if (!haveShCurl) {
      console.log('  (sh/curl not available: skipped the uv installer script runs)');
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvsh-'));
      try {
        const run = (url) => spawnSync('sh', ['-c', UV_INSTALL_SH.replace('https://astral.sh/uv/install.sh', url)], { encoding: 'utf8' });
        const good = path.join(dir, 'good.sh'); fs.writeFileSync(good, '#!/bin/sh\necho installer-ran\n');
        let r = run(`file://${good}`);
        eq([r.status, r.stdout.trim()], [0, 'installer-ran'], 'uv installer script: a real script is fetched and run');

        const html = path.join(dir, 'portal.html'); fs.writeFileSync(html, '<html><body>Sign in to the network</body></html>');
        r = run(`file://${html}`);
        ok(r.status !== 0 && /did not return the uv installer script/.test(r.stderr) && !/installer-ran/.test(r.stdout),
          'a captive-portal page is refused with an explanation, never executed');

        r = run(`file://${path.join(dir, 'missing.sh')}`);
        ok(r.status !== 0, 'a failed download FAILS the step (the old `curl | sh` exited 0 here)');
        ok(/curl:/.test(r.stderr), `curl's own error reaches stderr: ${r.stderr.trim().split('\n')[0]}`);

        const oldStyle = spawnSync('sh', ['-c', `curl -LsSf file://${path.join(dir, 'missing.sh')} | sh`], { encoding: 'utf8' });
        eq(oldStyle.status, 0, 'baseline: the previous `curl … | sh` really did exit 0 on a failed download');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    ok(/Tls12/.test(UV_INSTALL_PS1) && UV_INSTALL_PS1.indexOf('Tls12') < UV_INSTALL_PS1.indexOf('Invoke-RestMethod'), 'PowerShell installer forces TLS 1.2 before the download');
    ok(/Invoke-RestMethod/.test(UV_INSTALL_PS1) && /Invoke-Expression/.test(UV_INSTALL_PS1) && !/\b(irm|iex)\b/.test(UV_INSTALL_PS1), 'full cmdlet names, no irm/iex aliases');
    ok(/ErrorActionPreference = 'Stop'/.test(UV_INSTALL_PS1), 'a failed download stops the script (non-zero exit)');

    const f = installFailure('uv install failed (exit 1)\nboom', { stderr: 'boom', code: 1 });
    eq([f.stderr, f.code, f.message.split('\n')[0]], ['boom', 1, 'uv install failed (exit 1)'], 'installFailure carries stderr/code so the panel can show them');
    ok(/boom/.test(require('./startup-error').describeStartupFailure(f)), 'and the startup panel shows the installer\'s stderr');
  }

  // ── Windows PowerShell 5.1 gets its OWN module path, not the pwsh 7 one it inherits ──
  {
    const p = windowsPowerShellModulePath({ USERPROFILE: 'C:\\Users\\Tzahi', ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' });
    eq(p.split(';'), [
      'C:\\Users\\Tzahi\\Documents\\WindowsPowerShell\\Modules',
      'C:\\Program Files\\WindowsPowerShell\\Modules',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    ], 'the three Windows PowerShell 5.1 module directories, none of them pwsh 7\'s');
    ok(!/\\PowerShell\\Modules/.test(p.replace(/WindowsPowerShell/g, '')), 'no PowerShell 7 module directory');
    eq(windowsPowerShellModulePath({ windir: 'D:\\Win' }).split(';')[2], 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\Modules', 'falls back to windir when SystemRoot is missing');
  }

  // ── children never inherit a PYTHONHOME/PYTHONPATH that would break the venv ──
  {
    const seen = [];
    const env = cleanPythonEnv({ PATH: '/bin', PYTHONHOME: '/x', PYTHONPATH: '/y', UV_PYTHON_INSTALL_MIRROR: 'm', HOME: '/h' }, { warn: (l) => seen.push(l) });
    eq(Object.keys(env).sort(), ['HOME', 'PATH', 'UV_PYTHON_INSTALL_MIRROR'], 'PYTHONHOME/PYTHONPATH removed; UV_* (user config) and the rest kept');
    eq(seen.length, 2, 'each removal is logged');
    eq(cleanPythonEnv({ PATH: '/bin' }), { PATH: '/bin' }, 'a clean env is untouched');

    let seenEnv = null;
    const m = new UvManager(silentLog);
    m._enrichedPath = () => '/p';
    const origHome = process.env.PYTHONHOME;
    process.env.PYTHONHOME = '/user/global/python';
    try {
      m._runStreaming = UvManager.prototype._runStreaming;
      await m._run(process.execPath, ['-e', 'process.stdout.write(process.env.PYTHONHOME || "unset")'], { timeout: 5000, shell: false })
        .then((r) => { seenEnv = r.stdout; });
    } finally {
      if (origHome === undefined) delete process.env.PYTHONHOME; else process.env.PYTHONHOME = origHome;
    }
    eq(seenEnv, 'unset', 'a real child process started through _run does not see the parent\'s PYTHONHOME');
  }

  // ── retry only stops a backend a previous attempt launched ─────────────────
  {
    const m = new UvManager(silentLog);
    eq(m.hasLaunchedBackend(), false, 'a fresh manager has launched nothing (first-install retry must not `flow stop` / kill the port)');
    m._lastLaunch = { startedAt: 1 };
    eq(m.hasLaunchedBackend(), true, 'after start() has spawned flow start, stopping is legitimate');
  }

  // ── the uv download has no wall-clock cap, but is visible and stoppable ─────
  if (!IS_WIN) {
    const mkFresh = () => {
      const m = new UvManager(silentLog);
      let n = 0;
      m._uv = async (args) => { if (args[0] === '--version' && n++ === 0) throw new Error('not found'); return { stdout: '', stderr: '' }; };
      m._ensureShimOnPath = async () => {};
      // `mktemp -d` under the private TMPDIR the installer is given (what _installerHonorsTempDir asks).
      m._run = async (_cmd, _args, o) => {
        const d = require('fs').mkdtempSync(require('path').join(o.env.TMPDIR, 'tmp.'));
        return { stdout: d + '\n', stderr: '' };
      };
      return m;
    };

    // No timeout is passed to the runner (a cap kills slow-but-working downloads on weak links).
    let m = mkFresh(); let opts0 = null;
    m._runStreaming = async (_c, _a, o) => { opts0 = o; return { stdout: '', stderr: '' }; };
    await m.ensureUv();
    ok(opts0 && !('timeout' in opts0), 'ensureUv passes NO timeout to the installer run');

    // The installer's own lines and an elapsed-time tick reach the caller; the tick stops afterwards.
    m = mkFresh(); m._progressTickMs = 10;
    const shown = [];
    m._runStreaming = async (_c, _a, o) => {
      o.onLine('downloading uv 0.9.9 aarch64-apple-darwin');
      await new Promise((r) => setTimeout(r, 60));
      return { stdout: '', stderr: '' };
    };
    await m.ensureUv({ onProgress: (l) => shown.push(l) });
    ok(shown.includes('downloading uv 0.9.9 aarch64-apple-darwin'), "the installer's own output is forwarded");
    ok(shown.some((l) => /^still downloading uv \(\d+s\)$/.test(l)), 'a "still downloading" elapsed tick is shown while it runs');
    const count = shown.length;
    await new Promise((r) => setTimeout(r, 40));
    eq(shown.length, count, 'the tick stops when the download ends (no leaked timer)');

    // Covered by the quit guard, and abortable: the user can always get out.
    m = mkFresh();
    let killed = null; let release;
    const child = { pid: 4242, exitCode: null, kill: (sig) => { killed = sig; } };
    m._runStreaming = (_c, _a, o) => new Promise((_res, rej) => { o.onChild(child); release = () => rej(Object.assign(new Error('killed'), { signal: 'SIGTERM' })); });
    const running = m.ensureUv().then(() => 'done', (e) => e);
    while (!release) await new Promise((r) => setImmediate(r)); // the installer child now exists
    eq(m.isInstalling(), true, 'isInstalling() is true during the uv download, so quitting mid-download asks first');
    eq(m.abortInstall(), true, 'abortInstall() reports a running download');
    eq(killed, 'SIGTERM', 'and signals the installer process');
    release();
    const err = await running;
    ok(err instanceof Error && /killed by SIGTERM/.test(err.message), `the abort surfaces as a clear error: ${err.message}`);
    eq(m.isInstalling(), false, 'not installing any more');

    // ── progress watchdog: 3 x 30 s of silence stops it; any new byte resets; never without a trustworthy signal ──
    const fs2 = require('fs'); const path2 = require('path');
    const fakeTimers = () => {
      let now = 0; const jobs = [];
      return {
        setInterval(fn, ms) { const j = { fn, ms, next: now + ms, dead: false, unref() {} }; jobs.push(j); return j; },
        clearInterval(j) { if (j) j.dead = true; },
        setTimeout(fn, ms) { const j = { fn, ms, next: now + ms, dead: false, once: true, unref() {} }; jobs.push(j); return j; },
        clearTimeout(j) { if (j) j.dead = true; },
        advance(ms) { const end = now + ms; for (;;) { const due = jobs.filter((j) => !j.dead && j.next <= end).sort((a, b) => a.next - b.next)[0]; if (!due) break; now = due.next; if (due.once) due.dead = true; else due.next += due.ms; due.fn(); } now = end; },
      };
    };
    // A manager on fake time whose installer we control. `ctl.finish()` ends the install, `ctl.killed` records signals.
    const mkWatched = () => {
      const m = mkFresh();
      const timers = fakeTimers();
      m._timers = timers;
      const ctl = { timers, tmp: null, env: null, killed: [], child: null, started: null, runs: 0 };
      let started; ctl.started = new Promise((r) => { started = r; });
      m._runStreaming = (_c, _a, o) => new Promise((resolve, reject) => {
        ctl.runs++; ctl.env = o.env; ctl.tmp = o.env.TMPDIR; ctl.onData = o.onData;
        ctl.child = { pid: 99, exitCode: null, kill: (sig) => { ctl.killed.push(sig); reject(Object.assign(new Error('killed'), { signal: sig })); } };
        o.onChild(ctl.child);
        ctl.finish = () => resolve({ stdout: '', stderr: '' });
        started();
      });
      return { m, ctl, timers };
    };
    const S = 1000;

    // No new byte: not stopped at 60 s or 89 s, stopped at 90 s; the error says why and is retryable text.
    {
      const { m, ctl, timers } = mkWatched();
      const p2 = m.ensureUv().then(() => 'done', (e) => e);
      await ctl.started;
      timers.advance(60 * S); eq(ctl.killed.length, 0, 'watchdog: silent for 60 s is not a stall yet');
      timers.advance(29 * S); eq(ctl.killed.length, 0, 'watchdog: nor at 89 s');
      timers.advance(1 * S); eq(ctl.killed, ['SIGTERM'], 'watchdog: 3 quiet windows (90 s) -> the installer is stopped');
      const e = await p2;
      ok(e.stalled === true && /no new data for 90 seconds \(3 checks of 30 s\)/.test(e.message) && /click Retry/.test(e.message), `the stall error is clear: ${e.message}`);
      eq(m.isInstalling(), false, 'not installing after a stall');
      eq(fs2.existsSync(ctl.tmp), false, 'the private temp dir is removed after a stall');
    }

    // A silent-on-stdout download that GROWS the temp dir is progress (this is the real curl -s case).
    {
      const { m, ctl, timers } = mkWatched();
      const p2 = m.ensureUv().then(() => 'done', (e) => e);
      await ctl.started;
      const file = path2.join(ctl.tmp, 'input.tar.gz');
      for (let i = 0; i < 40; i++) { fs2.appendFileSync(file, Buffer.alloc(1024)); timers.advance(25 * S); } // 1000 s, a byte-slow download
      eq(ctl.killed.length, 0, 'watchdog: a download that keeps growing its temp file is never stopped (1000 s here)');
      ctl.finish();
      eq(await p2, 'done', 'and it completes normally');
      eq(fs2.existsSync(ctl.tmp), false, 'temp dir removed after success');
    }

    // Output bytes are progress too.
    {
      const { m, ctl, timers } = mkWatched();
      const p2 = m.ensureUv().then(() => 'done', (e) => e);
      await ctl.started;
      for (let i = 0; i < 20; i++) { ctl.onData(Buffer.from('x')); timers.advance(25 * S); }
      eq(ctl.killed.length, 0, 'watchdog: bytes on the installer\'s output count as progress');
      ctl.finish(); await p2;
    }

    // A byte during the 3rd quiet window resets to three fresh windows.
    {
      const { m, ctl, timers } = mkWatched();
      const p2 = m.ensureUv().then(() => 'done', (e) => e);
      await ctl.started;
      timers.advance(60 * S);                       // 2 quiet windows
      ctl.onData(Buffer.from('y')); timers.advance(30 * S); // byte in the 3rd -> reset
      eq(ctl.killed.length, 0, 'watchdog: a byte in the 3rd window resets instead of stopping');
      timers.advance(60 * S); eq(ctl.killed.length, 0, 'watchdog: two quiet windows after the reset: still running');
      timers.advance(30 * S); eq(ctl.killed.length, 1, 'watchdog: three fresh quiet windows after the reset: stopped');
      await p2;
    }

    // The mktemp wrapper: on macOS the real `mktemp -d` ignores TMPDIR, so without it the download lands
    // somewhere we cannot watch (found by running the real installer, 2026-09-30).
    {
      const { spawnSync: sp } = require('child_process');
      const dir = fs2.mkdtempSync(path2.join(require('os').tmpdir(), 'shimtest-'));
      try {
        const m0 = new UvManager(silentLog);
        const shim = m0._installMktempShim(dir);
        ok(shim && fs2.existsSync(shim) && (fs2.statSync(shim).mode & 0o111) !== 0, 'the mktemp wrapper is written and executable');
        const inDir = (p) => fs2.realpathSync(p).startsWith(fs2.realpathSync(dir) + path2.sep);
        const env = { ...process.env, TMPDIR: dir };
        let r = sp(shim, ['-d'], { env, encoding: 'utf8' });
        ok(r.status === 0 && inDir(r.stdout.trim()) && fs2.statSync(r.stdout.trim()).isDirectory(), '`mktemp -d` (what install.sh runs for the archive) lands under TMPDIR');
        r = sp(shim, [], { env, encoding: 'utf8' });
        ok(r.status === 0 && inDir(r.stdout.trim()) && fs2.statSync(r.stdout.trim()).isFile(), '`mktemp` with no args makes a file under TMPDIR');
        const explicit = path2.join(dir, 'elsewhere.XXXXXX');
        r = sp(shim, ['-d', explicit], { env: { ...process.env, TMPDIR: '/nonexistent' }, encoding: 'utf8' });
        ok(r.status === 0 && r.stdout.trim().startsWith(path2.join(dir, 'elsewhere.')), 'an explicit template is passed through untouched');
        ok(/^#!\/bin\/sh/.test(mktempShimSource('/usr/bin/mktemp')) && mktempShimSource('/a b/mktemp').includes('"/a b/mktemp"'), 'the real mktemp path is quoted into the wrapper');
      } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
    }

    // ...and ensureUv puts that wrapper first on the installer's PATH.
    {
      const { m, ctl } = mkWatched();
      const p2 = m.ensureUv();
      await ctl.started;
      const first = ctl.env.PATH.split(path2.delimiter)[0];
      ok(first === path2.join(ctl.tmp, '.bin') && fs2.existsSync(path2.join(first, 'mktemp')), 'the installer\'s PATH starts with the private dir\'s wrapper');
      ctl.finish(); await p2;
    }

    // The installer runs with the private temp dir (all three variables), which exists while it runs.
    {
      const { m, ctl, timers } = mkWatched();
      const p2 = m.ensureUv();
      await ctl.started;
      ok(ctl.env.TMPDIR && ctl.env.TMPDIR === ctl.env.TEMP && ctl.env.TEMP === ctl.env.TMP, 'TMPDIR/TEMP/TMP all point at the private dir');
      ok(fs2.existsSync(ctl.tmp) && ctl.tmp.includes('flowpad-uv-'), 'the private dir exists while the installer runs');
      ctl.finish(); await p2;
    }

    // NEVER arm the stall watchdog without a trustworthy signal: a flat temp dir would look like a stall
    // while a healthy, silent download runs. In that case ONLY, a 200 s wall-clock cap applies instead.
    for (const [name, runStub] of [
      ['the installer would use a different temp dir', async () => ({ stdout: '/somewhere/else/tmp.abc\n', stderr: '' })],
      ['the temp-dir check itself fails', async () => { throw new Error('sh: mktemp: not found'); }],
    ]) {
      {
        const { m, ctl, timers } = mkWatched();
        m._run = runStub;
        const p2 = m.ensureUv().then(() => 'done', (e) => e);
        await ctl.started;
        timers.advance(199 * S);
        eq(ctl.killed.length, 0, `fallback (${name}): not stopped at 199 s, and NOT by the stall watchdog (silent for 199 s)`);
        timers.advance(1 * S);
        eq(ctl.killed, ['SIGTERM'], `fallback (${name}): the 200 s cap stops it`);
        const e = await p2;
        ok(e.timedOut === true && !e.stalled && /did not finish within 200 seconds/.test(e.message) && /click Retry/.test(e.message), `the cap error is clear: ${e.message}`);
      }
      {
        const { m, ctl, timers } = mkWatched();
        m._run = runStub;
        const p2 = m.ensureUv().then(() => 'done', (e) => e);
        await ctl.started;
        timers.advance(150 * S);
        ctl.finish();
        eq(await p2, 'done', `fallback (${name}): a download that finishes inside 200 s completes`);
        timers.advance(1000 * S);
        eq(ctl.killed.length, 0, 'and the cap timer is cleared (nothing fires afterwards)');
      }
    }

    // While the stall watchdog IS armed there is no wall-clock cap at all.
    {
      const { m, ctl, timers } = mkWatched();
      const p2 = m.ensureUv().then(() => 'done', (e) => e);
      await ctl.started;
      const file = path2.join(ctl.tmp, 'input.tar.gz');
      for (let i = 0; i < 30; i++) { fs2.appendFileSync(file, Buffer.alloc(64)); timers.advance(20 * S); } // 600 s > 200 s
      eq(ctl.killed.length, 0, 'watchdog armed: a moving download runs past 200 s untouched (600 s here)');
      ctl.finish(); await p2;
    }

    // An abort asked for before the installer child exists (during the temp-dir check) is honoured.
    {
      const { m, ctl } = mkWatched();
      let releaseCheck;
      m._run = () => new Promise((res) => { releaseCheck = () => res({ stdout: '/x\n', stderr: '' }); });
      const p2 = m.ensureUv().then(() => 'done', (e) => e);
      while (!releaseCheck) await new Promise((r) => setImmediate(r));
      eq(m.abortInstall(), true, 'abort during the temp-dir check reports a running install');
      releaseCheck();
      const e = await p2;
      ok(e instanceof Error && /Could not install uv/.test(e.message), 'the aborted install fails');
      eq(ctl.runs, 0, 'and the installer was never started');
    }

    // A failed download reports the real cause and carries stderr for the panel.
    m = mkFresh();
    m._runStreaming = async () => { throw Object.assign(new Error('Command failed: sh -c ...'), { code: 6, stderr: 'curl: (6) Could not resolve host: astral.sh' }); };
    const failure = await m.ensureUv().then(() => null, (e) => e);
    ok(failure && /exit 6/.test(failure.message) && /Could not resolve host/.test(failure.stderr), 'a failed download: short message + curl\'s stderr');
    ok(!/sh -c/.test(failure.message), 'the panel never shows the raw installer command line');
  }

  // Guard against a cap creeping back in: ensureUv must contain no timer-driven abort / timeout option.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'uv-manager.js'), 'utf8');
    const body = src.slice(src.indexOf('  async ensureUv('), src.indexOf('  // flow CLI binary resolution'));
    const code = body.replace(/\/\/.*$/gm, '');
    ok(!/(^|[^.\w])setTimeout\s*\(|timeout\s*:|\.kill\(/.test(code), 'ensureUv has no bare setTimeout, timeout option or kill of its own');
    eq((code.match(/_timers\.setTimeout/g) || []).length, 1, 'the ONLY wall-clock timer in ensureUv is the fallback cap (used when the stall watchdog cannot be armed)');
    ok(/this\._fallbackCapMs\b/.test(code) && /_fallbackCapMs = 200 \* 1000/.test(src), 'and its value is the approved 200 s');
  }

  // ── `uv tool install flowpad`: progress guard (no cap while moving; 90 s of silence once the signal is trusted; 240 s cap until then) ──
  {
    const fs3 = require('fs'); const os3 = require('os'); const path3 = require('path');
    const S = 1000;
    const fakeT = () => {
      let now = 0; const jobs = [];
      return {
        setInterval(fn, ms) { const j = { fn, ms, next: now + ms, dead: false, unref() {} }; jobs.push(j); return j; },
        clearInterval(j) { if (j) j.dead = true; },
        setTimeout(fn, ms) { const j = { fn, ms, next: now + ms, dead: false, once: true, unref() {} }; jobs.push(j); return j; },
        clearTimeout(j) { if (j) j.dead = true; },
        advance(ms) { const end = now + ms; for (;;) { const due = jobs.filter((j) => !j.dead && j.next <= end).sort((a, b) => a.next - b.next)[0]; if (!due) break; now = due.next; if (due.once) due.dead = true; else due.next += due.ms; due.fn(); } now = end; },
      };
    };
    const settle = () => new Promise((r) => setTimeout(r, 25)); // the samplers are async fs scans
    const tmpBase = fs3.mkdtempSync(path3.join(os3.tmpdir(), 'toolguard-'));
    let seq = 0;
    // A manager whose uv we control; `dirs` = real temp dirs standing in for uv's cache/python/tool dirs.
    const mkTool = ({ withDirs = true, stateDir = null } = {}) => {
      const base = path3.join(tmpBase, `t${seq++}`);
      const dirs = { cache: path3.join(base, 'cache'), python: path3.join(base, 'python'), tools: path3.join(base, 'tools') };
      for (const d of [dirs.cache, dirs.python, path3.join(dirs.tools, 'flowpad')]) fs3.mkdirSync(d, { recursive: true });
      const m = new UvManager(silentLog, stateDir ? { stateDir } : {});
      const timers = fakeT(); m._timers = timers;
      m._uvDirs = async () => (withDirs ? dirs : null);
      m._drainVenvProcesses = async () => {};
      m._pythonPinForUpgrade = async () => '3.11'; m._pythonPinForUpgradeUnused = true;
      m._ensureShimOnPath = async () => {}; m._resolveFlowBin = async () => null;
      m._getLatestPypiInfo = async () => null;
      const ctl = { killed: [], runs: 0, dirs, timers };
      ctl.started = new Promise((res) => { ctl.markStarted = res; });
      m._runStreaming = (_c, _a, o) => new Promise((resolve, reject) => {
        ctl.runs++; ctl.onData = o.onData;
        ctl.child = { pid: 77, exitCode: null, kill: (sig) => { ctl.killed.push(sig); reject(Object.assign(new Error('killed'), { signal: sig })); } };
        o.onChild(ctl.child); ctl.finish = () => resolve({ stdout: '', stderr: '' }); ctl.markStarted();
      });
      // one virtual step: advance, then let the async samplers finish
      ctl.step = async (sec) => { timers.advance(sec * S); await settle(); };
      ctl.download = (n = 512) => fs3.appendFileSync(path3.join(dirs.cache, '.tmp-download'), Buffer.alloc(n)); // an in-flight download growing
      return { m, ctl };
    };
    const run = (m) => m._uvToolInstallForce(['tool', 'install', 'flowpad']).then(() => 'done', (e) => e);

    // A moving install is never stopped — not by the watchdog, and not by the 240 s cap (600 s here).
    {
      const { m, ctl } = mkTool(); const p2 = run(m); await ctl.started; await settle();
      for (let i = 0; i < 30; i++) { ctl.download(); await ctl.step(20); }
      eq(ctl.killed.length, 0, 'tool install: a download that keeps growing runs 600 s untouched (no watchdog stall, no 240 s cap)');
      ctl.finish(); eq(await p2, 'done', 'and completes');
    }

    // Trusted, then silent: 3 quiet 30 s windows stop it. Movement at 20 s -> trusted at the 30 s check; then 60/90/120 quiet.
    {
      const { m, ctl } = mkTool(); const p2 = run(m); await ctl.started; await settle();
      await ctl.step(20); ctl.download(); await ctl.step(10);       // t=30: the dirs moved -> trusted
      await ctl.step(30); await ctl.step(30); await ctl.step(29);    // one window per step (an async scan can't overlap the next tick in real time): t=119
      eq(ctl.killed.length, 0, 'tool install: not stopped before the 3rd quiet window ends (t=119)');
      await ctl.step(1);
      eq(ctl.killed, ['SIGTERM'], 'tool install: 3 quiet windows after the signal proved itself -> stopped (t=120)');
      const e = await p2;
      ok(e.stalled === true && e.killedByGuard === true && /Flowpad install stalled: no new data for 90 seconds \(3 checks of 30 s\)/.test(e.message) && /click Retry/.test(e.message), `clear stall error: ${e.message}`);
    }

    // Output bytes are progress too.
    {
      const { m, ctl } = mkTool(); const p2 = run(m); await ctl.started; await settle();
      await ctl.step(20); ctl.download(); await ctl.step(10);       // trusted
      for (let i = 0; i < 12; i++) { ctl.onData(Buffer.from('x')); await ctl.step(25); } // only uv's output moves for 300 s
      eq(ctl.killed.length, 0, 'tool install: bytes on uv\'s output keep a trusted install alive');
      ctl.finish(); await p2;
    }

    // Signal never seen moving -> silence proves nothing -> NO 90 s stop; only the 240 s cap.
    {
      const { m, ctl } = mkTool(); const p2 = run(m); await ctl.started; await settle();
      await ctl.step(200);
      eq(ctl.killed.length, 0, 'tool install: a signal that never moved cannot declare a stall (silent for 200 s)');
      await ctl.step(39);
      eq(ctl.killed.length, 0, 'not at 239 s');
      await ctl.step(1);
      eq(ctl.killed, ['SIGTERM'], 'the 240 s cap stops it');
      const e = await p2;
      ok(e.timedOut === true && !e.stalled && e.killedByGuard === true && /did not finish within 240 seconds/.test(e.message), `clear cap error: ${e.message}`);
    }

    // Movement removes the cap: a install that started moving at 10 s is not cut at 240 s.
    {
      const { m, ctl } = mkTool(); const p2 = run(m); await ctl.started; await settle();
      await ctl.step(10); ctl.download(); await ctl.step(20);       // trusted at t=30 -> cap cleared
      for (let i = 0; i < 20; i++) { ctl.download(); await ctl.step(20); } // to t=430 s
      eq(ctl.killed.length, 0, 'tool install: once trusted, the 240 s cap is gone (430 s here)');
      ctl.finish(); await p2;
    }

    // Directories not resolvable -> cap only, and it is 240 s.
    {
      const { m, ctl } = mkTool({ withDirs: false }); const p2 = run(m); await ctl.started; await settle();
      await ctl.step(239); eq(ctl.killed.length, 0, 'no dirs: not stopped at 239 s');
      await ctl.step(1); eq(ctl.killed, ['SIGTERM'], 'no dirs: the 240 s cap applies');
      ok((await p2).timedOut === true, 'reported as a timeout');
    }

    // A finished install leaves nothing armed.
    {
      const { m, ctl } = mkTool(); const p2 = run(m); await ctl.started; await settle();
      await ctl.step(60); ctl.finish(); await p2;
      await ctl.step(2000);
      eq(ctl.killed.length, 0, 'after completion no timer fires (cap, watchdog and progress tick are all cleared)');
    }

    // A kill by the guard leaves the install marker: the tool venv may be half-replaced.
    for (const scenario of ['cap', 'stall']) {
      const stateDir = path3.join(tmpBase, `state-${scenario}`);
      const { m, ctl } = mkTool({ withDirs: scenario === 'stall', stateDir }); const p2 = run(m); await ctl.started; await settle();
      if (scenario === 'stall') { await ctl.step(20); ctl.download(); await ctl.step(10); await ctl.step(30); await ctl.step(30); await ctl.step(30); } else { await ctl.step(240); }
      const e = await p2;
      ok(e instanceof Error && e.killedByGuard, `${scenario}: uv was stopped by the guard`);
      eq(m.hasInstallMarker(), true, `${scenario}: the install-in-progress marker is KEPT (next launch repairs the venv)`);
      eq(m.hadInterruptedInstall(), true, `${scenario}: hadInterruptedInstall() is true afterwards`);
    }

    // install, upgrade and reinstall all get the same guard (they share _uvToolInstallForce).
    for (const name of ['installLatest', 'upgrade', 'reinstall']) {
      const { m, ctl } = mkTool({ withDirs: false });
      const p2 = m[name]().then(() => 'done', (e) => e);
      await ctl.started; await settle();
      await ctl.step(239); eq(ctl.killed.length, 0, `${name}: not stopped at 239 s`);
      await ctl.step(1);
      const e = await p2;
      ok(ctl.killed.length === 1 && e.timedOut === true, `${name}: the same 240 s cap applies`);
    }

    // _uvDirs itself: resolves once, and refuses to guess when uv works in a throw-away cache.
    {
      const m1 = new UvManager(silentLog); m1._uvDirs = realUvDirs;
      const asked = [];
      m1._run = async (_c, a) => { asked.push(a.join(' ')); return { stdout: `/uv/${a[0]}\n`, stderr: '' }; };
      eq(await m1._uvDirs(), { cache: '/uv/cache', python: '/uv/python', tools: '/uv/tool' }, '_uvDirs asks uv for cache/python/tool dirs');
      await m1._uvDirs(); eq(asked.length, 3, '_uvDirs is memoized (uv asked once each)');
      const m2 = new UvManager(silentLog); m2._uvDirs = realUvDirs;
      m2._run = async () => { throw new Error('uv not found'); };
      eq(await m2._uvDirs(), null, '_uvDirs: uv unavailable -> null (cap only)');
      const m3 = new UvManager(silentLog); m3._uvDirs = realUvDirs; let called = false;
      m3._run = async () => { called = true; return { stdout: '/x', stderr: '' }; };
      const saved = process.env.UV_NO_CACHE; process.env.UV_NO_CACHE = '1';
      try { eq(await m3._uvDirs(), null, '_uvDirs: UV_NO_CACHE set -> null (uv would use a temp cache we cannot watch)'); }
      finally { if (saved === undefined) delete process.env.UV_NO_CACHE; else process.env.UV_NO_CACHE = saved; }
      eq(called, false, 'and uv is not even asked');
    }

    // The samplers themselves.
    {
      const d = path3.join(tmpBase, 'fp'); fs3.mkdirSync(path3.join(d, 'archive-v0', 'pkg'), { recursive: true }); fs3.mkdirSync(path3.join(d, '.tmpA'), { recursive: true });
      const { topFingerprintAsync: fp, dirSizeBytesAsync: sz } = UvManager;
      const a = await fp(d);
      fs3.appendFileSync(path3.join(d, '.tmpA', 'download'), Buffer.alloc(100));
      const b = await fp(d);
      ok(a !== b, 'the fingerprint moves when a download in a dot-dir grows');
      fs3.mkdirSync(path3.join(d, 'archive-v0', 'new-entry'));
      ok(await fp(d) !== b, 'a new entry directly under a top-level cache dir DOES move it (that dir\'s mtime)');
      const c = await fp(d);
      fs3.appendFileSync(path3.join(d, 'archive-v0', 'pkg', 'deep-file'), Buffer.alloc(100));
      eq(await fp(d), c, 'a change two levels down is NOT scanned (cheap by design; the dot-dirs and the tool venv cover in-flight work)');
      eq(await fp(path3.join(tmpBase, 'missing')), 'none', 'a missing dir fingerprints as "none"');
      eq(await sz(path3.join(d, '.tmpA')), 100, 'async recursive size');
    }
    fs3.rmSync(tmpBase, { recursive: true, force: true });
  }

  // ── _uvToolInstallForce compiles bytecode in the install, not on first boot ─
  {
    const m = new UvManager(silentLog);
    let seenArgs = null;
    m._drainVenvProcesses = async () => {};
    m._runStreaming = async (_cmd, args) => { seenArgs = args; return { stdout: '', stderr: '' }; };
    await m._uvToolInstallForce(['tool', 'install', 'flowpad', '--force']);
    eq(seenArgs, ['tool', 'install', 'flowpad', '--force', '--compile-bytecode'],
      '_uvToolInstallForce: every install/upgrade/reinstall passes --compile-bytecode');
    await m._uvToolInstallForce(['tool', 'install', 'flowpad', '--compile-bytecode']);
    eq(seenArgs.filter((a) => a === '--compile-bytecode').length, 1,
      '_uvToolInstallForce: never doubled when the caller already passed it');
  }

  // ── isInstallProgressLine (what the loading-screen ticker shows) ────────────
  ok(isInstallProgressLine('Downloading flowpad (34.6MiB)'), 'progress: Downloading');
  ok(isInstallProgressLine('Resolved 132 packages in 23.96s'), 'progress: Resolved');
  ok(isInstallProgressLine('Building pybars3==0.9.7'), 'progress: Building');
  ok(isInstallProgressLine('Installed 132 packages in 2.1s'), 'progress: Installed');
  ok(!isInstallProgressLine('warning: Failed to patch the install name of the dynamic library'),
    'progress: a warning is NOT ticker material');
  ok(!isInstallProgressLine('error: Failed to download cpython-3.10'), 'progress: an error is NOT ticker material');
  ok(!isInstallProgressLine(''), 'progress: empty line → false');
  ok(!isInstallProgressLine(null), 'progress: null → false (no throw)');
  ok(isInstallProgressLine('Bytecode compiled 6013 files in 1.47s'),
    'progress: the --compile-bytecode step is ticker material (it can take a while on a weak machine)');

  // ── splitLines (chunk → line adapter for a child's pipes) ──────────────────
  {
    const lines = [];
    const feed = UvManager.splitLines((l) => lines.push(l));
    feed(Buffer.from('Resolved 1 pack'));
    feed(Buffer.from('ages\r\n\n  Downloading x\nleft'));
    eq(lines, ['Resolved 1 packages', 'Downloading x'], 'splitLines: joins chunks, strips CR, drops blanks, holds the partial tail');
    feed(Buffer.from('over\n'));
    eq(lines[2], 'leftover', 'splitLines: the held tail completes on the next chunk');
  }

  // ── _runStreaming (uncapped, line-streaming runner for `uv tool install`) ───
  // Real child processes (node itself). Lines must reach onLine in order as they
  // arrive; the resolve/reject shape must match _run so error classifiers and
  // the startup dialog keep working unchanged.
  {
    const m = new UvManager(silentLog);
    const script = "process.stderr.write('Downloading a (1MiB)\\nwarning: x\\n');" +
      "process.stdout.write('out-line\\n');" +
      "process.stderr.write('Installed 2 packages in 0.1s\\n');";
    const lines = [];
    const res = await m._runStreaming(process.execPath, ['-e', script], { onLine: (l) => lines.push(l) });
    // stdout and stderr are separate pipes, so only per-stream order is defined.
    eq(lines.filter((l) => l !== 'out-line'),
      ['Downloading a (1MiB)', 'warning: x', 'Installed 2 packages in 0.1s'],
      '_runStreaming: every stderr line is streamed, trimmed, in order');
    ok(lines.includes('out-line'), '_runStreaming: stdout lines are streamed too');
    ok(res.stderr.includes('Downloading a (1MiB)') && res.stdout === 'out-line',
      '_runStreaming: resolves with {stdout, stderr} like _run');

    // Non-zero exit → rejects with execFile's error shape (.code/.stderr/.stdout,
    // "Command failed: …" message carrying stderr) so main.js's dialog and the
    // lock/corrupt classifiers see exactly what they see from _run.
    const m2 = new UvManager(silentLog);
    let err = null;
    try {
      await m2._runStreaming(process.execPath,
        ['-e', "process.stderr.write('error: boom\\n'); process.exit(3)"]);
    } catch (e) { err = e; }
    ok(err && err.code === 3 && /error: boom/.test(err.stderr) && /^Command failed: /.test(err.message)
      && err.message.includes('error: boom') && err.killed === false,
      '_runStreaming: non-zero exit → Error with .code, .stderr, "Command failed:" message, not killed');

    // A throwing onLine must never fail the install.
    const m3 = new UvManager(silentLog);
    const res3 = await m3._runStreaming(process.execPath,
      ['-e', "process.stderr.write('Downloading z\\n')"], { onLine: () => { throw new Error('ui'); } });
    ok(res3 && typeof res3 === 'object', '_runStreaming: a throwing onLine callback is swallowed');
  }

  // ── _uvToolInstallForce: uncapped + progress filtering ──────────────────────
  // The install goes through _runStreaming (never the capped _run/_uv) with NO
  // timeout option, and only uv progress lines reach onProgress — warnings and
  // errors stay in the log/dialog.
  {
    const m = new UvManager(silentLog);
    m._drainVenvProcesses = async () => {};
    let capturedOpts = null, cmd = null, viaUv = 0;
    m._uv = async () => { viaUv++; return { stdout: '', stderr: '' }; };
    m._run = async () => { viaUv++; return { stdout: '', stderr: '' }; };
    m._runStreaming = async (c, args, opts) => {
      cmd = c; capturedOpts = opts;
      for (const l of ['Downloading flowpad (34.6MiB)', 'warning: Failed to patch', 'Built pybars3==0.9.7']) opts.onLine(l);
      return { stdout: '', stderr: '' };
    };
    const shown = [];
    await m._uvToolInstallForce(['tool', 'install', 'flowpad'], { onProgress: (l) => shown.push(l) });
    eq(cmd, 'uv', '_uvToolInstallForce runs uv through _runStreaming');
    ok(viaUv === 0, '_uvToolInstallForce never goes through the capped _run/_uv');
    ok(capturedOpts && !('timeout' in capturedOpts),
      '_uvToolInstallForce passes NO timeout — the install is bounded by bandwidth, not by us');
    eq(shown, ['Downloading flowpad (34.6MiB)', 'Built pybars3==0.9.7'],
      '_uvToolInstallForce forwards only progress lines to onProgress (warnings filtered)');

    // No onProgress → still runs, no throw.
    const m4 = new UvManager(silentLog);
    m4._drainVenvProcesses = async () => {};
    m4._runStreaming = async (c, a, opts) => { opts.onLine('Downloading q'); return { stdout: '', stderr: '' }; };
    await m4._uvToolInstallForce(['tool', 'install', 'flowpad']);
    ok(true, '_uvToolInstallForce without onProgress is fine');
  }

  {
    // stop(): re-entrant. A second caller while a stop is in flight awaits the
    // SAME stop (quit from the startup-timeout panel must not exit mid-`flow stop`);
    // after completion a further call is a no-op.
    const m = new UvManager(silentLog);
    let flowStops = 0, killPorts = 0, release;
    m._flowStop = () => new Promise((r) => { flowStops++; release = r; });
    m._killPort = async () => { killPorts++; };
    const p1 = m.stop();
    const p2 = m.stop();
    ok(p1 === p2, 'stop: concurrent second call returns the in-flight promise');
    ok(m._stopPromise === p1, 'stop: in-flight promise is tracked');
    release();
    await p1; await p2;
    eq(flowStops, 1, 'stop: flow stop ran once');
    eq(killPorts, 1, 'stop: port kill ran once');
    ok(m._stopPromise === null, 'stop: in-flight promise cleared after completion');
    await m.stop();
    eq(flowStops, 1, 'stop: a call after completion is a no-op (already shutting down)');
  }

  {
    // deferPackageVersion: the periodic check must not re-offer a version the
    // user already answered "Later" to (from any dialog).
    const m = new UvManager(silentLog);
    m.deferPackageVersion('0.2.99');
    eq(m._deferredPackageVersion, '0.2.99', 'deferPackageVersion: stored');
    m.deferPackageVersion(null);
    eq(m._deferredPackageVersion, '0.2.99', 'deferPackageVersion: falsy input ignored');
  }

  {
    // Post-boot upgrade: a backend that never becomes healthy after the upgrade
    // is a FAILED upgrade → recovery runs (instead of loading a dead URL and
    // reporting success). Uses a fake `electron` module for the dialog.
    const electronId = require.resolve('electron');
    const savedElectron = require.cache[electronId];
    require.cache[electronId] = { id: electronId, filename: electronId, loaded: true,
      exports: { dialog: { showMessageBox: async () => ({ response: 0 }) } } };
    try {
      const m = new UvManager(silentLog);
      const calls = [];
      m._pypiUpdateStatus = async () => ({ currentVersion: '0.2.1', latestVersion: '0.2.2', required: true });
      m.stop = async () => { calls.push('stop'); };
      m.upgrade = async () => { calls.push('upgrade'); };
      m.start = async () => { calls.push('start'); };
      m._recoverRunningBackendAfterFailedUpgrade = async () => { calls.push('recover'); return true; };
      const loads = [];
      const mainWindow = { isDestroyed: () => false, loadFile: async () => {}, loadURL: (u) => loads.push(u) };
      const res = await m.checkForUpdatesInBackground(mainWindow, {
        sendStatus: () => {}, waitForBackend: async () => false, backendUrl: 'http://localhost:9007',
        cloudUrl: 'https://x', compareWithPypi: true,
      });
      eq(res, false, 'post-boot upgrade: unhealthy backend after upgrade reports failure');
      ok(calls.includes('recover'), 'post-boot upgrade: recovery path ran');
      eq(loads.length, 0, 'post-boot upgrade: dead backend URL was NOT loaded');

      // Recovery ALSO failed: the "Update failed" dialog offers Share, then the in-app panel replaces the stuck
      // "Upgrading Flowpad…" splash (onUnrecovered) — the user is never left on a splash that cannot finish.
      {
        const shown = [];
        require.cache[electronId].exports.dialog.showMessageBox = async (_w, opts) => { shown.push(opts); return { response: 0 }; };
        const mu = new UvManager(silentLog);
        mu._pypiUpdateStatus = m._pypiUpdateStatus; mu.stop = m.stop; mu.start = m.start;
        mu.upgrade = async () => { throw new Error('uv failed: locked'); };
        mu._recoverRunningBackendAfterFailedUpgrade = async () => false;
        mu.setFailureSharer(async () => ({ ok: true }));
        const unrecovered = [];
        // First dialog is "Update Available" (Upgrade = 0), the next is the failure dialog.
        const resU = await mu.checkForUpdatesInBackground(mainWindow, {
          sendStatus: () => {}, waitForBackend: async () => true, backendUrl: 'http://localhost:9007',
          cloudUrl: 'https://x', compareWithPypi: true, onUnrecovered: async (e) => { unrecovered.push(e.message); },
        });
        eq(resU, false, 'unrecovered upgrade reports failure');
        const failure = shown.find((o) => o.title === 'Update failed');
        ok(failure && failure.buttons.includes('Share with us'), 'the Update failed dialog offers Share with us');
        ok(/uv failed: locked/.test(failure.detail), 'and names the cause');
        eq(unrecovered, ['uv failed: locked'], 'onUnrecovered is called so the splash is replaced');
      }

      // Healthy backend → success and the URL is loaded.
      calls.length = 0;
      const m2 = new UvManager(silentLog);
      m2._pypiUpdateStatus = m._pypiUpdateStatus; m2.stop = m.stop; m2.upgrade = m.upgrade; m2.start = m.start;
      const res2 = await m2.checkForUpdatesInBackground(mainWindow, {
        sendStatus: () => {}, waitForBackend: async () => true, backendUrl: 'http://localhost:9007',
        cloudUrl: 'https://x', compareWithPypi: true,
      });
      eq(res2, true, 'post-boot upgrade: healthy backend reports success');
      eq(loads.length, 1, 'post-boot upgrade: backend URL loaded once');

      // "Later" (and Esc, which maps to the same index via cancelId) defers the version.
      require.cache[electronId].exports.dialog.showMessageBox = async (_w, opts) => {
        ok(opts.cancelId === 1, 'package dialog: cancelId is Later (Esc never upgrades)');
        return { response: opts.cancelId };
      };
      const m3 = new UvManager(silentLog);
      m3._pypiUpdateStatus = m._pypiUpdateStatus;
      let upgraded = false; m3.upgrade = async () => { upgraded = true; };
      eq(await m3.checkForUpdatesInBackground(mainWindow, { compareWithPypi: true }), false, 'package dialog: Later returns false');
      ok(!upgraded, 'package dialog: Later does not upgrade');
      eq(m3._deferredPackageVersion, '0.2.2', 'package dialog: Later remembers the version');
      eq(await m3.checkForUpdatesInBackground(mainWindow, { compareWithPypi: true }), false, 'package dialog: deferred version is not re-offered');
    } finally {
      if (savedElectron) require.cache[electronId] = savedElectron; else delete require.cache[electronId];
    }
  }

  {
    // Package dialog supersession: while the "Update Available" dialog for X is open,
    // supersedePackageDialog() closes it as "Later" (X deferred), and a fresh check
    // offers the newer version.
    const electronId = require.resolve('electron');
    const savedElectron = require.cache[electronId];
    require.cache[electronId] = { id: electronId, filename: electronId, loaded: true,
      exports: { dialog: { showMessageBox: (_w, opts) => new Promise((resolve) => {
        opts.signal.addEventListener('abort', () => resolve({ response: opts.cancelId }));
      }) } } };
    try {
      const m = new UvManager(silentLog);
      let latest = '0.2.160';
      m._pypiUpdateStatus = async () => ({ currentVersion: '0.2.150', latestVersion: latest, required: true });
      const mainWindow = { isDestroyed: () => false, loadFile: async () => {}, loadURL: () => {} };
      eq(m.openPackageDialogVersion(), null, 'no package dialog open initially');
      const first = m.checkForUpdatesInBackground(mainWindow, { compareWithPypi: true });
      await new Promise((r) => setTimeout(r, 0));
      eq(m.openPackageDialogVersion(), '0.2.160', 'dialog for 0.2.160 is open');
      latest = '0.2.161';
      m.supersedePackageDialog();
      eq(await first, false, 'superseded dialog resolves as Later');
      eq(m.openPackageDialogVersion(), null, 'dialog closed');
      eq(m._deferredPackageVersion, '0.2.160', 'old version recorded as deferred');
      const second = m.checkForUpdatesInBackground(mainWindow, { compareWithPypi: true });
      await new Promise((r) => setTimeout(r, 0));
      eq(m.openPackageDialogVersion(), '0.2.161', 'fresh check offers the newer version');
      m.supersedePackageDialog(); await second;
    } finally {
      if (savedElectron) require.cache[electronId] = savedElectron; else delete require.cache[electronId];
    }
  }

  // ── close(): a quit refuses every later start/install ────────────────────
  // The startup chain keeps running after the user quits. Before close(), a
  // start that resumed after the quit's `flow stop` launched `flow start` anyway,
  // and its detached monitor + server outlived the app.
  {
    const m = new UvManager(silentLog);
    m._flowBin = '/nonexistent/flow';
    let probed = false;
    m._probeFlowBinOnce = async () => { probed = true; };
    m.close();
    eq(m.isClosed(), true, 'close() marks the manager closed');
    const err = await m.start().then(() => null, (e) => e);
    ok(err && err.quitInProgress, 'start() after close() is refused with a QuitInProgressError');
    eq(probed, false, 'a refused start does no work at all');
    eq(m.hasLaunchedBackend(), false, 'nothing was launched');
  }
  {
    // The quit lands while start() is between its awaits: the spawn must still not happen.
    const m = new UvManager(silentLog);
    m._flowBin = '/nonexistent/flow';
    m._probeFlowBinOnce = async () => {};
    m.ensurePortFree = async () => { m.close(); };
    m._loadSodKey = async () => null;
    const err = await m.start().then(() => null, (e) => e);
    ok(err && err.quitInProgress, 'a quit during start() refuses the spawn that follows it');
    eq(m.hasLaunchedBackend(), false, 'no flow start was spawned after the quit');
  }
  {
    const m = new UvManager(silentLog);
    let attempted = false;
    m._uvToolInstallForceAttempts = async () => { attempted = true; };
    m.close();
    const err = await m._uvToolInstallForce(['tool', 'install', 'flowpad']).then(() => null, (e) => e);
    ok(err && err.quitInProgress, 'an install after close() is refused');
    eq(attempted, false, 'the refused install never reached uv');
    eq(m.isInstalling(), false, 'a refused install does not mark the manager as installing');
  }
  {
    // close() during an install aborts it (the same abort the old "Quit anyway" ran).
    const m = new UvManager(silentLog);
    m._installing = true;
    m.close();
    eq(m._installAborted, true, 'close() aborts a running install');
  }
  if (!IS_WIN) {
    // The stop signals a still-running `flow start` BEFORE `flow stop` runs, so a
    // monitor it spawned is already there for flow stop's monitor scan.
    const { spawn } = require('child_process');
    const m = new UvManager(silentLog);
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    m._backendProcess = child;
    let signalledBeforeFlowStop = null;
    m._flowStop = async () => { signalledBeforeFlowStop = child.killed; };
    m._killPort = async () => {};
    await m.stop();
    eq(signalledBeforeFlowStop, true, 'flow start is signalled before flow stop runs');
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  console.log(`uv-manager.test.js: ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
