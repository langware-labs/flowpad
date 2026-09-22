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
  pythonVersionFromPyproject, PYTHON_VERSION,
} = UvManager;

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
  eq(PYTHON_VERSION, pythonVersionFromPyproject(repoToml), 'PYTHON_VERSION == repo requires-python floor');
  ok(/^\d+\.\d+$/.test(PYTHON_VERSION), `PYTHON_VERSION is a bare minor (${PYTHON_VERSION})`);
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
  // The fresh-install leg stubs _run (the `sh -c curl | sh` installer); on
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

  console.log(`uv-manager.test.js: ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
