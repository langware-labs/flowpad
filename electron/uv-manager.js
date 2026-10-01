const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');
const { SEMVER_RE, isNewer } = require('./semver');
const { createProgressWatchdog } = require('./progress-watchdog');
const { showFailureDialog } = require('./failure-dialog');

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PATH_SEP = IS_WIN ? ';' : ':';

// Astral's installer, fetched to a FILE and run — not `curl … | sh`. In a pipeline sh reads an empty
// stdin when curl fails (offline, DNS, blocked host, curl missing) and exits 0, so the caller only
// ever saw "Failed to install uv: Command failed: uv --version", never the network error. Here curl's
// own stderr is the error (-f: HTTP errors fail; -S: show them), and a 200 that is not a shell script
// (a captive portal or proxy login page) is caught before it is executed.
const UV_INSTALL_SH =
  'set -eu; f="$(mktemp)"; trap \'rm -f "$f"\' EXIT; ' +
  'curl -LsSf https://astral.sh/uv/install.sh -o "$f"; ' +
  'head -n 1 "$f" | grep -q \'^#!\' || { echo "astral.sh did not return the uv installer script (captive portal or proxy login page?)" >&2; exit 1; }; ' +
  'sh "$f"';

// Windows PowerShell 5.1 negotiates TLS 1.0/1.1 by default and astral.sh refuses it, so force 1.2
// first. Full cmdlet names, not the irm/iex aliases (some hosts remove the aliases).
const UV_INSTALL_PS1 =
  '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ' +
  '$ErrorActionPreference = \'Stop\'; ' +
  'Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression';

/** An Error that carries the child's stderr/exit code the way execFile errors do, so the startup panel can show them. */
function installFailure(message, { stderr = '', code = null } = {}) {
  const err = new Error(message);
  err.stderr = stderr;
  err.code = code;
  return err;
}

/** Total bytes of every regular file under `dir` (symlinks not followed). 0 for a missing dir. */
function dirSizeBytes(dir, skip = []) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (skip.includes(e.name)) continue; // top level only: our own mktemp wrapper dir (.bin)
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(full);
      else if (e.isFile()) total += fs.lstatSync(full).size;
    } catch { /* vanished mid-scan: the installer is cleaning up */ }
  }
  return total;
}

// macOS's `mktemp -d` IGNORES $TMPDIR (it uses the per-user temp dir), so on a Mac the installer would
// download into a directory we cannot watch. This wrapper, placed first on the installer's PATH, forces
// template-less calls (`mktemp`, `mktemp -d` — what install.sh uses for the archive) under $TMPDIR, and
// passes anything with an explicit template through unchanged. `realMktemp` is the system tool.
function mktempShimSource(realMktemp) {
  return [
    '#!/bin/sh',
    '# Flowpad: keep the uv installer\'s temp files under $TMPDIR (macOS mktemp -d ignores it) so the',
    '# download can be watched for progress. Explicit templates are passed through untouched.',
    'for a in "$@"; do',
    '  case "$a" in -*) : ;; *) exec ' + JSON.stringify(realMktemp) + ' "$@" ;; esac',
    'done',
    'exec ' + JSON.stringify(realMktemp) + ' "$@" "${TMPDIR%/}/tmp.XXXXXXXXXX"',
    '',
  ].join('\n');
}

// Async twins of the above for sampling during `uv tool install`: a scan of a big directory must not
// block the Electron main process (a full recursive scan of a real 8 GB uv cache took ~9 s of synchronous
// work — measured 2026-09-30 — so the global cache is only ever fingerprinted at its TOP level).
async function dirSizeBytesAsync(dir) {
  let total = 0;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSizeBytesAsync(full);
      else if (e.isFile()) total += (await fs.promises.lstat(full)).size;
    } catch { /* vanished mid-scan */ }
  }
  return total;
}

/**
 * Cheap change-detector for a big directory: the names + mtimes of its TOP level entries, plus the
 * recursive size of the dot-entries (`.tmp*`, `.temp`: where uv keeps downloads that are still in
 * flight). Moves when uv adds/finishes an entry or a download grows. 'none' when the dir is missing.
 */
async function topFingerprintAsync(dir) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 'none'; }
  const parts = [];
  let dot = 0;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      const st = await fs.promises.lstat(full);
      parts.push(`${e.name}:${Math.round(st.mtimeMs)}`);
      if (e.name.startsWith('.')) dot += e.isDirectory() ? await dirSizeBytesAsync(full) : st.size;
    } catch { /* vanished mid-scan */ }
  }
  return `${parts.sort().join('|')}#${dot}`;
}

// Windows PowerShell 5.1's own module search path. A parent that is PowerShell 7 (an app started from a
// pwsh terminal, or from an ssh/pwsh session) leaves PSModulePath pointing at pwsh's modules, and then
// powershell.exe cannot load its built-in ones: the uv installer dies with "The 'Get-ExecutionPolicy'
// command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded",
// and the venv-process drain (Get-CimInstance) silently does nothing. Reproduced on the Windows VM
// 2026-09-30: installer exit 1 with the inherited path, exit 0 with this one.
function windowsPowerShellModulePath(env = process.env) {
  const w = path.win32;
  return [
    w.join(env.USERPROFILE || os.homedir(), 'Documents', 'WindowsPowerShell', 'Modules'),
    w.join(env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell', 'Modules'),
    w.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  ].join(';');
}

// Python settings that break a managed venv's interpreter if a user's shell exports them (a global
// PYTHONHOME/PYTHONPATH makes the venv import the wrong stdlib/site-packages). The app's children —
// uv, the flow CLI, the backend — must never inherit them. UV_* is left alone: that is user config.
const POISONOUS_PYTHON_ENV = ['PYTHONHOME', 'PYTHONPATH'];

function cleanPythonEnv(env, log) {
  for (const key of POISONOUS_PYTHON_ENV) {
    if (key in env) {
      if (log) log.warn(`[uv] not passing ${key} to child processes (it would break the flowpad venv)`);
      delete env[key];
    }
  }
  return env;
}

// What the OS / cmd.exe / uv say when Windows application control (WDAC, Device Guard,
// AppLocker) refuses to run a binary. Three shapes, all seen or documented:
//   * cmd.exe (shell:true):  "This program is blocked by group policy…"
//   * uv:                    "Failed to spawn: `flow` … An Application Control policy has blocked
//                             this file. (os error 4551)"
//   * CreateProcess direct:  Node reports `spawn UNKNOWN` (errno -4094) with no stderr at all.
const POLICY_BLOCK_TEXT =
  /Device Guard|Application Control|blocked by (your organization|group policy|an administrator|your administrator)|os error 4551|policy has blocked|administrator has blocked|This program is blocked/i;

/** True when `err` (from execFile/spawn) reads as an application-control block. */
function isPolicyBlockError(err) {
  if (!err) return false;
  const text = [err.stderr, err.stdout, err.message].filter(Boolean).map(String).join('\n');
  if (POLICY_BLOCK_TEXT.test(text)) return true;
  return err.code === 'UNKNOWN' || /spawn UNKNOWN/.test(text);
}

// `flow` without its console-script exe: the same entry point the exe calls
// (pyproject: flow = "flow_sdk.cli:cli_main"), driven by the venv's python. Used when
// application control blocks the generated flow.exe. No quotes/semicolons-in-args trouble:
// callers run it with shell:false.
const PY_FLOW_ENTRY = 'import sys; sys.argv[0] = "flow"; from flow_sdk.cli import cli_main; cli_main()';

function policyBlockedError(tried) {
  const paths = tried.map((t) => t.path);
  const err = new Error(
    'This computer’s application-control policy (Windows Defender Application Control / Device Guard) ' +
    'blocks the programs Flowpad needs to start its engine.'
  );
  err.policyBlocked = true;
  err.blockedPaths = paths;
  err.tried = tried;
  return err;
}

/**
 * Decide whether to spawn `cmd` through cmd.exe on Windows.
 *
 * shell:true is the broadly-compatible default — cmd.exe handles PATHEXT,
 * App Exec aliases, and uv shims that some AV/AppLocker setups refuse to
 * launch via direct CreateProcess (manifests as "spawn UNKNOWN").
 *
 * The one case where shell:true breaks is an .exe path containing whitespace:
 * cmd.exe splits on the space, so `C:\Users\avi tal\.local\bin\flow.exe`
 * becomes `C:\Users\avi`. For that case only, fall back to shell:false and
 * let Node's CreateProcess handle the path natively.
 */
function needsShellOnWin(cmd) {
  if (!IS_WIN) return false;
  if (!/[\\/]/.test(cmd)) return true;                      // bare name → PATH lookup needs shell
  if (/\.exe$/i.test(cmd) && /\s/.test(cmd)) return false;  // .exe with space → bypass cmd.exe
  return true;
}

/**
 * Quote a Windows command path for safe inclusion in a cmd.exe command line
 * (only relevant when shell:true is in use). For bare names with no spaces
 * this is a no-op.
 */
function quoteWinCmd(cmd) {
  return /\s/.test(cmd) ? `"${cmd}"` : cmd;
}

/**
 * Parse `netstat -ano` output into the PIDs LISTENING on exactly `port`.
 *
 * Pure (no I/O) so it can be unit-tested. Matches the port off the LOCAL
 * address column with an anchored `:<port>$`, NOT a substring scan — a naive
 * `line.includes(':9007')` also matches `:90071`, `:9007x` and the foreign
 * address column, which would taskkill an unrelated listener. Only TCP rows
 * in the LISTENING state are considered; ESTABLISHED/TIME_WAIT/UDP are ignored
 * so we never kill a mere client of the port.
 */
function parseNetstatPids(stdout, port) {
  const pids = new Set();
  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (!/^TCP\b/i.test(line)) continue;       // TCP rows only
    if (!/\bLISTENING\b/i.test(line)) continue; // listeners only
    // netstat -ano columns: Proto  LocalAddr  ForeignAddr  State  PID
    const parts = line.split(/\s+/);
    const local = parts[1] || '';
    const m = local.match(/:(\d+)$/);           // port = digits after final ':'
    if (!m || parseInt(m[1], 10) !== port) continue;
    const pid = parseInt(parts[parts.length - 1], 10);
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

// PyPI package name — `uv tool install flowpad`
const PYPI_PACKAGE = 'flowpad';

// Python interpreter flowpad's tool venv must run on: the `>=` floor of
// `requires-python` in the repo's pyproject.toml (">=3.11" → "3.11"). It is
// READ, not hand-pinned, so the desktop shell can never drift from what the
// package declares — v0.2.44 shipped a hand-pinned 3.10 after the package had
// already moved to 3.11, and uv silently resolved a stale flowpad for it.
// uv would otherwise pick the system default (e.g. 3.12); with the pin it
// auto-downloads a managed CPython of that minor if none is present.
//
// pyproject.toml is bundled as an extraResource (electron-builder.json), so a
// packaged app reads `<resources>/pyproject.toml`; a dev checkout (`electron .`,
// the tests) reads the repo-root file directly.
function pythonFloor(requiresPython) {
  const floor = String(requiresPython || '').match(/>=\s*(\d+\.\d+)/);
  return floor ? floor[1] : null;
}

function pythonVersionFromPyproject(text) {
  const m = text.match(/^\s*requires-python\s*=\s*"([^"]*)"/m);
  if (!m) throw new Error('pyproject.toml has no `requires-python`');
  const floor = pythonFloor(m[1]);
  if (!floor) {
    throw new Error(`pyproject.toml requires-python "${m[1]}" has no ">=" floor to pin uv to`);
  }
  return floor;
}

// The higher of two "<major>.<minor>" Python versions; a null side loses.
function maxPythonVersion(a, b) {
  if (!a || !b) return a || b || null;
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return (bm > am || (bm === am && bn > an)) ? b : a;
}

// Resolved LAZILY, on the first install/upgrade that needs it — never at
// module load. A build that somehow lacks the bundled file is broken, but a
// user whose install is already healthy takes the fast path and needs no pin;
// failing at require() time would stop every launch for a file only the
// installer reads. The failure surfaces where it belongs: as the install
// error (→ the startup panel), with a message that names the build as the
// cause so nobody chases their network.
let _pythonVersion = null;
function getPythonVersion() {
  if (_pythonVersion) return _pythonVersion;
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'pyproject.toml'),
    path.join(__dirname, '..', 'pyproject.toml'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      _pythonVersion = pythonVersionFromPyproject(fs.readFileSync(file, 'utf8'));
      return _pythonVersion;
    }
  }
  throw new Error(
    `This Flowpad build is missing its bundled pyproject.toml (looked in ${candidates.join(', ')}), ` +
    'so the Python version to install cannot be determined. Reinstall the desktop app.'
  );
}

// The pin for display (a copy-pasteable command in a dialog): null when the
// build is broken, so the dialog can still render instead of throwing.
function tryPythonVersion() {
  try { return getPythonVersion(); } catch { return null; }
}

// True when a process with this pid exists (signal 0 = existence probe; EPERM = exists,
// owned by someone else).
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The recovery command shown to the user, mirroring installLatest()/upgrade().
function upgradeCommand() {
  const v = tryPythonVersion();
  return `uv tool install ${PYPI_PACKAGE}@latest${v ? ` --python ${v}` : ''} --force`;
}

const API_PREFIX = '/api/v1';


// Working directory for the `flow start` backend. The FS indexer treats its
// CWD as a project root and walks the entire subtree (see
// flow_sdk/fs_store/indexer/roots.py + project_folder_walker.py). If that root
// is the home directory, the walk descends into ~/Desktop, ~/Library/Mobile
// Documents (iCloud), other apps' containers, and the media library — each
// first access trips a macOS TCC prompt attributed to Flowpad. Anchor the
// backend to a dedicated, app-owned folder instead. Mirrors flow_sdk.config's
// "~/Flowpad workspace".
const BACKEND_CWD = path.join(os.homedir(), 'Flowpad workspace');

const UpdateStatus = Object.freeze({
  REQUIRED: 'required',
  NOT_REQUIRED: 'not_required',
});

/**
 * Which `uv tool install` output lines are worth showing on the loading
 * screen. uv (non-TTY) prints one line per step — "Downloading flowpad
 * (34.6MiB)", "Resolved 132 packages in 23.96s", "Building pybars3==0.9.7",
 * "Installed 132 packages in 2.1s" — plus warnings/errors that belong in the
 * log and the failure dialog, not in a one-line status ticker.
 */
const INSTALL_PROGRESS_RE =
  /^(Downloading|Downloaded|Resolved|Prepared|Building|Built|Installing|Installed|Uninstalled|Updating|Updated|Fetching|Fetched|Bytecode compiled)\b/;
function isInstallProgressLine(line) {
  return INSTALL_PROGRESS_RE.test(String(line || '').trim());
}

/**
 * A chunk-to-line adapter for a child's stdout/stderr: buffers partial lines
 * across chunks and calls `onLine` once per complete, trimmed, non-empty line.
 */
function splitLines(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '').trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

class UvManager {
  constructor(log, { stateDir = null } = {}) {
    this.log = log;
    // Where the "install in progress" marker lives. null → marker disabled
    // (unit tests, tools that must not touch the user's home).
    this._stateDir = stateDir;
    // Lets native failure dialogs offer "Share with us" (set by main.js; null in tests → "OK" only).
    this._failureSharer = null;
    this._installing = false;
    this._installChild = null;
    this._installAborted = false;
    this._keepMarker = false;
    this._spawned = false;
    this._progressTickMs = 5000; // elapsed-time line during the uv download (display only)
    // Stall watchdog for the uv download (progress-watchdog.js): 30 s windows, 3 quiet ones in a row.
    // Overridable per instance for tests only.
    this._watchdogWindowMs = undefined;
    this._watchdogStrikes = undefined;
    this._timers = { setInterval, clearInterval, setTimeout, clearTimeout };
    // Wall-clock cap for the uv download ONLY when the stall watchdog cannot be armed (no trustworthy
    // progress signal on this machine). Approved by the user, 2026-09-30: 200 s. Never applies when the
    // watchdog is running — a moving download is not capped at all.
    this._fallbackCapMs = 200 * 1000;
    // Same idea for `uv tool install flowpad` (install/upgrade/reinstall): a wall-clock cap that applies ONLY
    // while the progress signal has not been shown to work. Approved by the user, 2026-09-30: 240 s.
    this._toolInstallCapMs = 240 * 1000;
    this._uvDirsPromise = null;
    this.isShuttingDown = false;
    this._flowBin = null;
    // Set to true when the uv-generated flow.exe shim is blocked by Windows
    // Device Guard / WDAC. We then route every flow invocation through
    // `uv tool run --from flowpad flow ...` instead, which doesn't go
    // through the unsigned shim.
    this._useUvToolRun = false;
    this._probedShim = false;
    // Which way to run `flow`: 'shim' (default), 'uv' (`uv tool run`) or 'python' (the venv's
    // python, no console-script exe) — chosen by _probeFlowBinOnce on machines whose policy
    // blocks the shim. _policyBlocked is set when every way is blocked.
    this._launcher = 'shim';
    this._policyBlocked = null;
  }

  _isWindows() {
    return IS_WIN;
  }

  /** The venv's python.exe (Windows), or null when it is not there. */
  _venvPython() {
    const py = path.join(this._toolVenvDir(), 'Scripts', 'python.exe');
    return fs.existsSync(py) ? py : null;
  }

  /**
   * Build the spawn command for invoking the flow CLI: { cmd, args, shell? }. `shell` is only set
   * when a launcher needs a specific value (the python launcher passes one big -c argument and
   * must NOT go through cmd.exe, which does not quote arguments).
   */
  _flowCmd(args) {
    if (this._launcher === 'python') {
      return { cmd: this._venvPython() || 'python', args: ['-c', PY_FLOW_ENTRY, ...args], shell: false };
    }
    if (this._launcher === 'uv' || this._useUvToolRun) {
      return { cmd: 'uv', args: ['tool', 'run', '--from', PYPI_PACKAGE, 'flow', ...args] };
    }
    return { cmd: this._flowBin, args };
  }

  /**
   * On Windows machines with application control (WDAC / Device Guard / AppLocker), the exe that
   * `uv tool install` generates for `flow` (an unsigned trampoline) can be blocked from running.
   * Find a way that works, once per session, trying in order:
   *   1. the flow shim                      (the normal way)
   *   2. `uv tool run --from flowpad flow`  (uv.exe itself is often allowed — but uv then spawns
   *                                          the SAME entry-point exe, so this can be blocked too)
   *   3. the venv's python.exe running the entry point directly (no generated exe involved)
   * If every way is blocked, `_policyBlocked` is set and start() fails with a clear message
   * instead of a bare "flow start exited with code 2". No-op on non-Windows.
   *
   * Each probe keeps the short budget the original single probe had: a policy block fails the
   * process launch *instantly* (the OS rejects CreateProcess), so the only thing waited for is that
   * fast rejection. A slow `--help` (cold Python import, AV scan) means it works. Do NOT widen it.
   */
  async _probeFlowBinOnce() {
    if (this._probedShim || !this._isWindows() || !this._flowBin) return;
    this._probedShim = true;
    const tried = [];
    // 'ok' | 'slow' (timed out: it runs) | 'blocked' | 'failed' (some other error)
    const attempt = async (launcher, cmd, args, shell) => {
      try {
        await this._run(cmd, args, { timeout: 2000, ...(shell === undefined ? {} : { shell }) });
        return 'ok';
      } catch (err) {
        if (isPolicyBlockError(err)) { tried.push({ launcher, path: cmd, detail: String(err.stderr || err.message).split('\n')[0] }); return 'blocked'; }
        if (err && err.killed && err.signal) return 'slow';
        tried.push({ launcher, path: cmd, detail: String(err && (err.stderr || err.message)).split('\n')[0] });
        return 'failed';
      }
    };

    const shim = await attempt('shim', this._flowBin, ['--help']);
    if (shim !== 'blocked') { tried.length = 0; return; } // works, or fails for a reason the real call will report
    this.log.warn('[uv] flow shim blocked by Windows application control — looking for a launcher that is allowed');

    const viaUv = await attempt('uv tool run', 'uv', ['tool', 'run', '--from', PYPI_PACKAGE, 'flow', '--help']);
    if (viaUv === 'ok' || viaUv === 'slow') {
      this.log.warn('[uv] using `uv tool run` to launch flow');
      this._launcher = 'uv';
      this._useUvToolRun = true;
      return;
    }

    const py = this._venvPython();
    if (py) {
      const viaPython = await attempt('venv python', py, ['-c', 'import sys'], false);
      if (viaPython === 'ok' || viaPython === 'slow') {
        this.log.warn('[uv] using the venv python to launch flow (the flow.exe shim and `uv tool run` are blocked)');
        this._launcher = 'python';
        return;
      }
    }
    this._policyBlocked = { tried };
    this.log.error(`[uv] every way of launching flow is blocked by application control: ${JSON.stringify(tried)}`);
  }

  /** Throws a clear, actionable error when application control blocks every launcher. */
  _assertNotPolicyBlocked() {
    if (this._policyBlocked) throw policyBlockedError(this._policyBlocked.tried);
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a PATH that includes common locations for uv, uv-installed tool
   * binaries, Python, and Homebrew.
   *
   * Electron launched from Finder/Dock/Start Menu inherits a minimal PATH that
   * misses most of these. We prepend them so our commands are discoverable.
   */
  _enrichedPath() {
    const home = os.homedir();
    const extra = [];

    if (IS_WIN) {
      // uv tool bin dir
      extra.push(path.join(home, '.local', 'bin'));

      // uv itself (cargo install / installer)
      extra.push(path.join(home, '.cargo', 'bin'));

      // pip --user scripts for each minor version (3.10 – 3.14)
      for (let minor = 10; minor <= 14; minor++) {
        extra.push(
          path.join(home, 'AppData', 'Roaming', 'Python', `Python3${minor}`, 'Scripts')
        );
      }

      // python.org installer locations
      const localProgs = path.join(home, 'AppData', 'Local', 'Programs', 'Python');
      for (let minor = 10; minor <= 14; minor++) {
        const pyDir = path.join(localProgs, `Python3${minor}`);
        extra.push(pyDir);
        extra.push(path.join(pyDir, 'Scripts'));
      }

      // Windows Store / App Exec aliases
      extra.push(path.join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps'));
    } else {
      // uv tool bin dir / uv itself
      extra.push(path.join(home, '.local', 'bin'));

      // uv installed via cargo
      extra.push(path.join(home, '.cargo', 'bin'));

      if (IS_MAC) {
        // Homebrew (Apple Silicon + Intel)
        extra.push('/opt/homebrew/bin');
        extra.push('/usr/local/bin');

        // python.org framework installer
        for (let minor = 10; minor <= 14; minor++) {
          extra.push(`/Library/Frameworks/Python.framework/Versions/3.${minor}/bin`);
        }
      } else {
        // Linux
        extra.push('/usr/local/bin');
        extra.push('/usr/bin');
        extra.push('/snap/bin');  // Ubuntu snaps
      }
    }

    const existing = process.env.PATH || '';
    return [...extra, existing].join(PATH_SEP);
  }

  // ---------------------------------------------------------------------------
  // Command execution
  // ---------------------------------------------------------------------------

  /**
   * Run a command and return { stdout, stderr }.
   * Rejects on non-zero exit code.
   *
   * On Windows we use shell: true so .cmd/.bat wrappers and App Exec aliases
   * resolve correctly. On Unix we call the binary directly.
   */
  async _run(cmd, args, options = {}) {
    const env = cleanPythonEnv({
      ...process.env,
      PATH: this._enrichedPath(),
      ...options.env,
    });
    this.log.info(`[uv] Running: ${cmd} ${args.join(' ')}`);
    const useShell = options.shell !== undefined ? options.shell : needsShellOnWin(cmd);
    const cmdToRun = useShell ? quoteWinCmd(cmd) : cmd;
    try {
      const { stdout, stderr } = await execFileAsync(cmdToRun, args, {
        env,
        timeout: options.timeout || 60000,
        cwd: options.cwd || os.homedir(),
        shell: useShell,             // shell only when bare-name or .cmd/.bat
        windowsHide: true,            // don't flash a console window
      });
      if (stdout.trim()) this.log.info(`[uv] ${stdout.trim()}`);
      if (stderr.trim()) this.log.warn(`[uv] ${stderr.trim()}`);
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      this.log.error(`[uv] Command failed: ${cmd} ${args.join(' ')}`);
      // Always record exit code / signal / killed — a fast, empty-stderr failure
      // (e.g. a child killed by a signal: Gatekeeper, OOM, the timeout) is
      // otherwise indistinguishable from a non-zero uv error in the logs.
      this.log.error(
        `[uv] exit code=${error.code} signal=${error.signal} killed=${error.killed}`
      );
      if (error.stdout) this.log.error(`[uv] stdout: ${error.stdout}`);
      if (error.stderr) this.log.error(`[uv] stderr: ${error.stderr}`);
      throw error;
    }
  }

  /**
   * Run a command with NO wall-clock cap, streaming each output line to
   * `options.onLine` as it arrives. Resolves/rejects with the same shape as
   * `_run` ({stdout, stderr} / Error with .code/.signal/.stdout/.stderr and a
   * "Command failed: …" message), so every caller's error classifier
   * (isCorruptEnvError, isToolDirLockedError, main.js's details) is unchanged.
   *
   * This is the runner for `uv tool install`. Its duration is bounded by the
   * user's bandwidth (a first install pulls ~60 MiB: CPython + the flowpad wheel
   * + deps), not by any stall, so a fixed cap on our side can only kill a
   * healthy slow install — which it did (RCA: a 120s cap SIGTERMed a first
   * install on a slow link mid-download, after uv had already resolved and was
   * fetching wheels; stderr showed pure progress and no error). A dead or
   * stalled network is uv's job: it aborts a transfer itself after
   * UV_HTTP_TIMEOUT (default 30s) of *no data* and fails with a real message,
   * which is what we want in the dialog instead of a silent kill.
   */
  _runStreaming(cmd, args, options = {}) {
    const env = cleanPythonEnv({
      ...process.env,
      PATH: this._enrichedPath(),
      ...options.env,
    });
    const useShell = options.shell !== undefined ? options.shell : needsShellOnWin(cmd);
    const cmdToRun = useShell ? quoteWinCmd(cmd) : cmd;
    const onLine = typeof options.onLine === 'function' ? options.onLine : null;
    this.log.info(`[uv] Running (streaming, no cap): ${cmd} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmdToRun, args, {
          env,
          cwd: options.cwd || os.homedir(),
          shell: useShell,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err);
        return;
      }

      if (typeof options.onChild === 'function') options.onChild(child);

      let stdout = '';
      let stderr = '';
      const feed = (isErr) => {
        const lines = splitLines((line) => {
          if (isErr) this.log.warn(`[uv] ${line}`); else this.log.info(`[uv] ${line}`);
          if (onLine) {
            try { onLine(line); } catch { /* a UI hiccup must never fail the install */ }
          }
        });
        return (chunk) => {
          const text = chunk.toString();
          if (isErr) stderr += text; else stdout += text;
          lines(text);
        };
      };
      const onData = typeof options.onData === 'function' ? options.onData : null;
      const feedOut = feed(false);
      const feedErr = feed(true);
      child.stdout.on('data', (c) => { if (onData) onData(c); feedOut(c); });
      child.stderr.on('data', (c) => { if (onData) onData(c); feedErr(c); });

      child.on('error', (err) => {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      });
      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          return;
        }
        // Mirror execFile's error shape so classifiers and the dialog see the
        // same fields they do for `_run`.
        const err = new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`);
        err.code = code;
        err.signal = signal;
        err.killed = false;
        err.stdout = stdout;
        err.stderr = stderr;
        this.log.error(`[uv] Command failed: ${cmd} ${args.join(' ')}`);
        this.log.error(`[uv] exit code=${code} signal=${signal}`);
        reject(err);
      });
    });
  }

  /**
   * Run a `uv` subcommand.
   */
  async _uv(subArgs, options = {}) {
    return this._run('uv', subArgs, options);
  }

  // ---------------------------------------------------------------------------
  // uv bootstrap (first-time install only)
  // ---------------------------------------------------------------------------

  /** Write the mktemp wrapper into `<tmpRoot>/.bin`. Returns its path, or null if no system mktemp is found. */
  _installMktempShim(tmpRoot) {
    const dirs = this._enrichedPath().split(path.delimiter).filter(Boolean);
    const real = dirs.map((d) => path.join(d, 'mktemp')).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } });
    if (!real) return null;
    try {
      const dir = path.join(tmpRoot, '.bin');
      fs.mkdirSync(dir, { recursive: true });
      const shim = path.join(dir, 'mktemp');
      fs.writeFileSync(shim, mktempShimSource(real), { mode: 0o755 });
      fs.chmodSync(shim, 0o755);
      return shim;
    } catch (err) {
      this.log.warn(`[uv] could not write the mktemp wrapper: ${err.message}`);
      return null;
    }
  }

  /**
   * Does the uv installer, started with `env`, put its temp files under `tmpRoot`? Asks the same
   * primitive the installer scripts use (`mktemp -d` on Unix, [IO.Path]::GetTempPath() on Windows).
   * False on any doubt — the caller then leaves the stall watchdog off.
   */
  async _installerHonorsTempDir(tmpRoot, env) {
    try {
      const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
      const root = real(tmpRoot);
      const norm = (p) => (IS_WIN ? p.toLowerCase() : p);
      if (IS_WIN) {
        const { stdout } = await this._run('powershell.exe', ['-NoProfile', '-Command', '[System.IO.Path]::GetTempPath()'], { env, shell: false });
        return norm(real(stdout.trim())).startsWith(norm(root));
      }
      const { stdout } = await this._run('sh', ['-c', 'mktemp -d'], { env });
      const made = stdout.trim();
      const inside = !!made && norm(real(made)).startsWith(norm(root) + path.sep);
      if (made) try { fs.rmSync(made, { recursive: true, force: true }); } catch { /* ignore */ }
      return inside;
    } catch (err) {
      this.log.warn(`[uv] could not verify the installer's temp dir: ${err.message}`);
      return false;
    }
  }

  /**
   * Ensure uv is available. If not found, install it automatically.
   * Only called during first-time setup (and repair).
   *
   * The download has NO wall-clock cap. It used to (120s), which killed a slow-but-working download on
   * a weak link and reported "process was killed (SIGTERM)" — its duration is the user's bandwidth,
   * not something we can bound without also killing good installs. What is bounded is SILENCE: a
   * progress watchdog (progress-watchdog.js) stops it only after 3 consecutive 30 s windows with no new
   * byte (output or downloaded), and any new byte resets it. And it is never invisible or unstoppable:
   *   - the caller's progress line shows the installer's own output plus an elapsed-time tick
   *     (display only — it never aborts anything), so a long download is visibly alive;
   *   - `isInstalling()` covers it, so quitting mid-download asks first, and `abortInstall()` kills the
   *     installer's process tree — the user can always get out;
   *   - a failed download fails FAST with the real cause (see UV_INSTALL_SH): DNS, refused, a login
   *     page — none of those hang, only a stalled-but-open connection does.
   */
  async ensureUv({ onProgress } = {}) {
    // Check if uv is already available
    try {
      await this._uv(['--version']);
      this.log.info('[uv] uv is available');
      return;
    } catch {
      this.log.info('[uv] uv not found, installing...');
    }

    // Install uv. Windows: powershell.exe directly, shell:false (cmd.exe would not quote the -Command
    // script); full cmdlet names, not the irm/iex aliases (see UV_INSTALL_PS1).
    const [cmd, args, shell] = IS_WIN
      ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', UV_INSTALL_PS1], false]
      : ['sh', ['-c', UV_INSTALL_SH], undefined];
    this._installing = true;
    this._installAborted = false;
    const startedAt = Date.now();

    // A private temp dir for the installer. Astral's scripts download the archive (the slow part) into
    // `mktemp -d` / [IO.Path]::GetTempPath() — both honour TMPDIR / TEMP+TMP — SILENTLY (curl -s,
    // WebClient.DownloadFile), so output bytes say nothing about a download in progress; the growth of
    // this directory does. Checked against the real install.sh / install.ps1 (2026-09-30).
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowpad-uv-'));
    const tmpEnv = { TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot };
    if (IS_WIN) {
      tmpEnv.PSModulePath = windowsPowerShellModulePath();
    } else {
      const shimPath = this._installMktempShim(tmpRoot);
      if (shimPath) tmpEnv.PATH = `${path.dirname(shimPath)}${path.delimiter}${this._enrichedPath()}`;
    }
    let outBytes = 0;
    let stall = null;
    const downloaded = () => dirSizeBytes(tmpRoot, ['.bin']); // the installer's files, not our own wrapper
    const sample = () => outBytes + downloaded();
    const tick = onProgress
      ? this._timers.setInterval(() => {
        const got = downloaded();
        onProgress(`still downloading uv (${Math.round((Date.now() - startedAt) / 1000)}s${got ? `, ${(got / 1048576).toFixed(1)} MB` : ''})`);
      }, this._progressTickMs)
      : null;
    if (tick && tick.unref) tick.unref();
    let watchdog = null;
    let capTimer = null;
    let capped = false;
    try {
      // Arm the stall watchdog ONLY if the signal is trustworthy: if this machine's installer would not
      // use our temp dir, a flat directory would look like a stall while the download is healthy — the
      // old 120 s cap's mistake in a new form. Then fall back to "no cap, visible, abortable".
      if (await this._installerHonorsTempDir(tmpRoot, tmpEnv)) {
        watchdog = createProgressWatchdog({
          sample,
          windowMs: this._watchdogWindowMs,
          strikes: this._watchdogStrikes,
          timers: this._timers,
          log: this.log,
          onStall: (info) => {
            stall = info;
            this._killInstallChild(this._installChild, `uv download made no progress for ${info.misses} x ${info.windowMs / 1000}s — stopping it`);
          },
        }).start();
      } else {
        // No signal we can trust, so silence cannot be told from a healthy silent download. Fall back to
        // a plain wall-clock cap (200 s, user-approved) — the only case where one is used.
        this.log.warn(`[uv] the uv installer would not use our temp dir — stall watchdog disabled; using a ${this._fallbackCapMs / 1000}s cap instead`);
        capTimer = this._timers.setTimeout(() => {
          capped = true;
          this._killInstallChild(this._installChild, `uv download exceeded the ${this._fallbackCapMs / 1000}s fallback cap — stopping it`);
        }, this._fallbackCapMs);
        if (capTimer && capTimer.unref) capTimer.unref();
      }
      // An abort asked for while the temp dir was being verified (before any child exists) must still stop us.
      if (this._installAborted) throw new Error('install aborted before the uv download started');
      await this._runStreaming(cmd, args, {
        shell,
        env: tmpEnv,
        onChild: (child) => { this._installChild = child; },
        onData: (chunk) => { outBytes += chunk.length; },
        onLine: (line) => { if (onProgress) onProgress(line); },
      });
    } catch (err) {
      if (capped) {
        const e = installFailure(
          `The uv download did not finish within ${this._fallbackCapMs / 1000} seconds. ` +
          'Check your internet connection, then click Retry.',
          { stderr: '', code: null },
        );
        e.timedOut = true;
        throw e;
      }
      if (stall) {
        const seconds = (stall.misses * stall.windowMs) / 1000;
        const e = installFailure(
          `The uv download stalled: no new data for ${seconds} seconds (${stall.misses} checks of ${stall.windowMs / 1000} s). ` +
          'Check your internet connection, then click Retry.',
          { stderr: '', code: null },
        );
        e.stalled = true;
        throw e;
      }
      throw installFailure(
        `Could not install uv (${err.signal ? `killed by ${err.signal}` : `exit ${err.code}`})`,
        { stderr: err.stderr || err.message, code: err.code },
      );
    } finally {
      if (watchdog) watchdog.stop();
      if (capTimer) this._timers.clearTimeout(capTimer);
      if (tick) this._timers.clearInterval(tick);
      this._installing = false;
      this._installChild = null;
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    // Verify
    try {
      await this._uv(['--version']);
      this.log.info('[uv] uv installed successfully');
    } catch (error) {
      throw new Error(`Failed to install uv: ${error.message}`);
    }

    // Put uv itself on the user's *terminal* PATH now, not only after the
    // flowpad install succeeds. Astral's installer skips its own rc-file edit
    // when the install dir is already on PATH — and it always is here, because
    // _enrichedPath() prepends ~/.local/bin to every command we run. Without
    // this, a first-time setup that dies after this point (e.g. the flowpad
    // install is interrupted) leaves the user with a working ~/.local/bin/uv
    // that `uv` in a fresh terminal can't find, so the recovery command we
    // show them fails with "command not found".
    await this._ensureShimOnPath();
  }

  // ---------------------------------------------------------------------------
  // flow CLI binary resolution
  // ---------------------------------------------------------------------------

  /**
   * Ask uv for its tool bin directory (where entry-point scripts are installed).
   * Falls back to platform-specific defaults.
   */
  async _getUvToolBinDir() {
    try {
      const { stdout } = await this._uv(['tool', 'dir', '--bin']);
      if (stdout && fs.existsSync(stdout)) {
        return stdout;
      }
    } catch {
      // Fall through to defaults
    }

    // Check known default locations
    const home = os.homedir();
    const defaults = IS_WIN
      ? [
          path.join(home, '.local', 'bin'),
        ]
      : [path.join(home, '.local', 'bin')];

    for (const dir of defaults) {
      if (fs.existsSync(dir)) return dir;
    }
    return defaults[0];
  }

  /**
   * Synchronous, filesystem-only check for the flow binary that *we* installed
   * via `uv tool install flowpad`. No subprocess calls — this is the key to
   * instant startup. Returns absolute path if found, null otherwise.
   *
   * We deliberately only look at uv's canonical tool location (and its shim in
   * ~/.local/bin if it resolves back to that venv). Any other `flow` on the
   * system — Homebrew, framework Python, pip --user, an unrelated tool that
   * happens to share the name — is ignored: returning the wrong binary here
   * would launch a completely different process as our backend.
   */
  getInstalledFlowBin() {
    const home = os.homedir();
    const uvVenvRoot = IS_WIN
      ? path.join(home, 'AppData', 'Roaming', 'uv', 'tools', PYPI_PACKAGE)
      : path.join(home, '.local', 'share', 'uv', 'tools', PYPI_PACKAGE);
    const uvVenvBin = IS_WIN
      ? path.join(uvVenvRoot, 'Scripts', 'flow.exe')
      : path.join(uvVenvRoot, 'bin', 'flow');

    if (fs.existsSync(uvVenvBin)) {
      this.log.info(`[uv] Found flowpad binary at canonical uv path: ${uvVenvBin}`);
      return uvVenvBin;
    }

    // uv also drops a shim in ~/.local/bin pointing at the venv binary above.
    // Accept it only if realpath confirms it belongs to the flowpad uv tool.
    const shimDir = path.join(home, '.local', 'bin');
    const names = IS_WIN ? ['flow.exe', 'flow.cmd', 'flow'] : ['flow'];
    for (const name of names) {
      const candidate = path.join(shimDir, name);
      if (!fs.existsSync(candidate)) continue;
      try {
        const resolved = fs.realpathSync(candidate);
        if (resolved === uvVenvBin || resolved.startsWith(uvVenvRoot + path.sep)) {
          this.log.info(`[uv] Found flowpad binary via shim: ${candidate} -> ${resolved}`);
          return candidate;
        }
        this.log.info(`[uv] Ignoring ${candidate}: resolves to ${resolved}, not the flowpad uv tool`);
      } catch {
        // realpath failed (broken symlink, permissions); skip.
      }
    }

    return null;
  }

  /**
   * Get the installed flowpad version by reading _version.py.
   * Resolves the flow binary to find the venv's site-packages.
   * Works across uv tool, pip, and any venv environment.
   * Returns version string (e.g., "0.1.32") or null.
   */
  getInstalledVersionSync(flowBin) {
    const _readVersion = (dir) => {
      const versionFile = path.join(dir, 'flow_sdk', '_version.py');
      if (!fs.existsSync(versionFile)) return null;
      const content = fs.readFileSync(versionFile, 'utf8');
      const match = content.match(/__version__\s*=\s*["']([^"']+)["']/);
      return match ? match[1] : null;
    };

    try {
      // Strategy 1: follow the flow binary symlink to find site-packages
      const bin = flowBin || this._flowBin;
      if (bin) {
        let binDir = path.dirname(bin);
        // Resolve symlinks (e.g., ~/.local/bin/flow -> ~/.local/share/uv/tools/flowpad/bin/flow)
        try { binDir = path.dirname(fs.realpathSync(bin)); } catch { /* use original */ }
        // bin/ -> lib/python3.X/site-packages/
        const venvRoot = path.dirname(binDir);
        const libDir = path.join(venvRoot, 'lib');
        if (fs.existsSync(libDir)) {
          for (const entry of fs.readdirSync(libDir)) {
            if (entry.startsWith('python')) {
              const ver = _readVersion(path.join(libDir, entry, 'site-packages'));
              if (ver) return ver;
            }
          }
        }
        // Windows: Lib/site-packages/ (no python3.X subdirectory)
        const winSitePackages = path.join(venvRoot, 'Lib', 'site-packages');
        const ver = _readVersion(winSitePackages);
        if (ver) return ver;
      }

      // Strategy 2: fallback to known uv tool venv paths
      const home = os.homedir();
      const uvToolDir = IS_WIN
        ? path.join(home, 'AppData', 'Roaming', 'uv', 'tools', PYPI_PACKAGE)
        : path.join(home, '.local', 'share', 'uv', 'tools', PYPI_PACKAGE);
      const venvCandidates = [uvToolDir];

      for (const venv of venvCandidates) {
        // Windows: Lib/site-packages/
        const winVer = _readVersion(path.join(venv, 'Lib', 'site-packages'));
        if (winVer) return winVer;
        // Unix: lib/python3.X/site-packages/
        const libDir = path.join(venv, 'lib');
        if (fs.existsSync(libDir)) {
          for (const entry of fs.readdirSync(libDir)) {
            if (entry.startsWith('python')) {
              const ver = _readVersion(path.join(libDir, entry, 'site-packages'));
              if (ver) return ver;
            }
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Set the flow binary path and start the server.
   * Used by the fast startup path when the binary is already known.
   */
  async startWithBin(flowBin) {
    this._flowBin = flowBin;
    await this.start();
  }

  /**
   * Absolute path to the flowpad uv tool venv. The backend interpreter and every
   * agentic-process worker it spawns run this venv's python, so matching on this
   * path finds the WHOLE tree — the backend and its workers alike.
   */
  _toolVenvDir() {
    return IS_WIN
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'uv', 'tools', PYPI_PACKAGE)
      : path.join(os.homedir(), '.local', 'share', 'uv', 'tools', PYPI_PACKAGE);
  }

  /**
   * Drain every process running under the flowpad uv tool venv — the backend AND
   * the agentic-process workers it spawned — so a `--force`/`--reinstall` install
   * can replace the venv cleanly and the freshly-upgraded backend can boot.
   *
   * Why this must go beyond `_killPort(9007)`: `stop()`/`ensurePortFree` only ever
   * target the process LISTENING on 9007. Workers run under the same venv but are
   * not on the port, so they survive `stop()` and then break the upgrade in two
   * distinct ways:
   *
   *   • Windows — `uv tool install … --force` must delete and recreate
   *     `…\uv\tools\flowpad\Scripts\`, but Windows refuses to remove a directory
   *     that contains a running .exe ("Access is denied. (os error 5)"). A worker
   *     (or an orphaned backend from a previous session) holding `python.exe` open
   *     blocks the reinstall. Match by image path and kill the tree (`/T`).
   *
   *   • macOS/Linux — unlinking a running exe is allowed, so the install itself
   *     won't file-lock; but a surviving worker keeps holding the 9007 socket
   *     and/or a JSONL session lock, so the reinstalled backend never gets healthy
   *     inside the post-upgrade health window and the user lands on the timeout
   *     panel. Match by command line (`pgrep -f <venv>`) and SIGTERM→SIGKILL them.
   *
   * No-op when the venv has no live processes (e.g. first-time install).
   */
  async _drainVenvProcesses() {
    const venvDir = this._toolVenvDir();

    if (IS_WIN) {
      try {
        const escaped = venvDir.replace(/'/g, "''");
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-Command',
          `Get-CimInstance Win32_Process | ` +
          `Where-Object { $_.ExecutablePath -like '${escaped}\\*' } | ` +
          `Select-Object -ExpandProperty ProcessId`,
        ], { timeout: 8000, windowsHide: true, env: { ...process.env, PSModulePath: windowsPowerShellModulePath() } });
        const pids = stdout.split(/\r?\n/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((p) => p > 0);
        for (const pid of pids) {
          try {
            await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
            this.log.info(`[uv] Killed venv process PID ${pid} (held ${venvDir})`);
          } catch { /* already gone / not killable — ignore */ }
        }
      } catch (e) {
        this.log.warn(`[uv] _drainVenvProcesses (win) failed: ${e.message}`);
      }
      return;
    }

    // macOS/Linux: pgrep -f matches the full command line, which carries the venv
    // interpreter path for the backend and every worker it spawned. Exclude our
    // own pid (this Electron process never runs under the venv, but be safe).
    let pids = [];
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', venvDir], { timeout: 5000 });
      pids = stdout.split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((p) => p > 0 && p !== process.pid);
    } catch {
      // pgrep exits 1 when nothing matches — nothing to drain.
      return;
    }
    if (!pids.length) return;

    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        this.log.info(`[uv] Sent SIGTERM to venv process PID ${pid} (under ${venvDir})`);
      } catch (e) {
        if (e.code !== 'ESRCH') this.log.warn(`[uv] Failed to SIGTERM PID ${pid}: ${e.message}`);
      }
    }
    // Give the tree a bounded moment to exit and release its port / session-lock
    // handles, then SIGKILL whatever is still alive (mirrors _killPort).
    await new Promise((r) => setTimeout(r, 2000));
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  }

  /**
   * Move a corrupt/half-written flowpad tool venv aside so the next
   * `uv tool install … --force` rebuilds it from scratch. We rename rather than
   * delete: the corrupt dir is preserved as `…/flowpad.corrupt-<ts>` for
   * diagnosis (an interrupted destructive replace is the usual cause), and a
   * rename is atomic where a recursive delete could itself be interrupted.
   */
  _quarantineToolVenv() {
    const venvDir = this._toolVenvDir();
    try {
      if (!fs.existsSync(venvDir)) return;
      const aside = `${venvDir}.corrupt-${Date.now()}`;
      fs.renameSync(venvDir, aside);
      this.log.info(`[uv] quarantined corrupt tool env → ${aside}`);
    } catch (e) {
      this.log.warn(`[uv] failed to quarantine tool env: ${e.message}`);
    }
  }

  /**
   * Run `uv tool install … --force` resiliently against a live venv. Every
   * attempt first drains the whole venv process tree — backend + workers — via
   * `_drainVenvProcesses()`, so the reinstall isn't fighting a running process
   * (and the upgraded backend can boot without a stale worker holding the port
   * or a session lock). On Windows, `--force` must delete and recreate
   * `…\uv\tools\flowpad\Scripts\`, which fails with "Access is denied (os
   * error 5)" while ANY process under that venv still holds a file open. We
   * drain those processes first, but `taskkill` returns before Windows has
   * actually released the handles, so a same-instant install can still lose
   * the race (observed in the field: a post-boot upgrade aborts here and the
   * app is left stuck on the loading splash).
   *
   * Strategy: drain the venv processes, attempt the install, and retry — up to
   * MAX_RETRIES — ONLY on two specific, self-correctable failures; any other
   * error throws immediately (this is not a blind retry to paper over a flake):
   *
   *   • Tool-dir locked (Windows) — re-drain and wait a bounded moment for the
   *     already-terminating holders to release their handles, then retry. On
   *     Unix the lock can't occur (unlinking a running exe is allowed), so the
   *     first attempt succeeds.
   *   • Corrupt/half-written env — an interrupted destructive replace can leave
   *     `…/flowpad` with `lib/` + `pyvenv.cfg` but no `bin/python`, so `--force`
   *     aborts with "Invalid environment: missing Python executable" instead of
   *     replacing it (otherwise a hard startup failure → the timeout panel; see
   *     RCA fad616fc). We quarantine the corrupt dir aside (renamed, not deleted,
   *     so it survives for diagnosis) and retry, which rebuilds the env clean.
   */
  async _uvToolInstallForce(installArgs, { onProgress } = {}) {
    this._installing = true;
    this._installAborted = false;
    this._keepMarker = false;
    this._spawned = false;
    this._writeInstallMarker(installArgs);
    try {
      return await this._uvToolInstallForceAttempts(installArgs, { onProgress });
    } catch (err) {
      // uv killed from outside (a signal: OOM, AV, Task Manager), or given up on a locked /
      // half-written tool dir: the venv may be half-replaced, so keep the marker.
      if (err && (err.signal || err.killedByGuard || this.isToolDirLockedError(err) || this.isCorruptEnvError(err))) {
        this._keepMarker = true;
      }
      throw err;
    } finally {
      this._installing = false;
      this._installChild = null;
      // A finished install — success OR a clean uv failure — leaves the tool dir in a state
      // uv itself reports on. Only a KILLED install is unknown, and only if uv had started:
      // an abort during the drain, before the spawn, changed nothing.
      const keep = (this._installAborted || this._keepMarker) && this._spawned;
      if (!keep) this._clearInstallMarker();
    }
  }

  async _uvToolInstallForceAttempts(installArgs, { onProgress } = {}) {
    const MAX_RETRIES = 3;
    const HANDLE_RELEASE_WAIT_MS = 1500;
    // Compile the venv's bytecode here, in the install, not on the first boot.
    // uv leaves .py files uncompiled by default, so the first boot after an
    // install compiles ~2,000 modules while importing them — the slowest phase
    // of a cold boot on a weak machine, doubled, and under an AV scanner on
    // Windows far worse. The install is guarded against stalls (see
    // _runToolInstallGuarded) and reports this step ("Bytecode compiled N
    // files in Xs"); the boot has both.
    const args = installArgs.includes('--compile-bytecode')
      ? installArgs
      : [...installArgs, '--compile-bytecode'];
    for (let attempt = 1; ; attempt++) {
      await this._drainVenvProcesses();
      if (this._installAborted) throw new Error('install aborted before uv started');
      try {
        // No wall-clock cap while it makes progress — see _runToolInstallGuarded. Progress lines go
        // to the caller (the loading window) so a long slow install is visibly alive.
        return await this._runToolInstallGuarded(args, {
          onProgress,
          onChild: (child) => { this._installChild = child; this._spawned = true; },
        });
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw err;
        if (this.isCorruptEnvError(err)) {
          this.log.warn(
            `[uv] corrupt tool env (attempt ${attempt}/${MAX_RETRIES}) — ` +
            `quarantining half-written venv and retrying`
          );
          this._quarantineToolVenv();
          continue;
        }
        if (this.isToolDirLockedError(err)) {
          this.log.warn(
            `[uv] tool dir locked (attempt ${attempt}/${MAX_RETRIES}) — re-killing ` +
            `holders and waiting ${HANDLE_RELEASE_WAIT_MS}ms for handles to release`
          );
          await new Promise((r) => setTimeout(r, HANDLE_RELEASE_WAIT_MS));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * uv's cache, python and tool directories (`uv cache dir` etc.) — the places a running `uv tool install`
   * writes to. Memoized. null when they cannot be resolved, or when UV_NO_CACHE is set (uv then works in a
   * throw-away cache we cannot watch): callers treat null as "no trustworthy signal".
   */
  _uvDirs() {
    if (!this._uvDirsPromise) {
      this._uvDirsPromise = (async () => {
        if (process.env.UV_NO_CACHE) return null;
        try {
          const ask = async (sub) => (await this._run('uv', [sub, 'dir'])).stdout.trim();
          const [cache, python, tools] = [await ask('cache'), await ask('python'), await ask('tool')];
          return cache && python && tools ? { cache, python, tools } : null;
        } catch (err) {
          this.log.warn(`[uv] could not resolve uv's directories: ${err.message}`);
          return null;
        }
      })();
    }
    return this._uvDirsPromise;
  }

  /**
   * Run `uv tool install` under a progress guard. There is NO wall-clock cap while it makes progress: a
   * 100 MB install on a slow link is bounded by bandwidth, and a cap kills it every time (the mistake
   * already removed once). What is bounded is SILENCE, and only once the signal has proven itself:
   *
   *  - signal = bytes on uv's output + change in (uv cache dir top level, uv python dir top level, the
   *    flowpad tool venv being built). Each is cheap to sample (top-level fingerprints; one bounded async
   *    scan) — a full scan of a real 8 GB cache would freeze the app for ~9 s, measured.
   *  - the signal is TRUSTED once the directories are seen to move during this install. Only then do
   *    3 quiet 30 s windows (90 s) stop the install; any new byte resets it.
   *  - until it is trusted (or if the dirs cannot be resolved / UV_NO_CACHE) a plain 240 s wall-clock cap
   *    applies instead (user-approved 2026-09-30, the same for install, upgrade and reinstall). The
   *    first observed movement removes that cap: a moving install is never capped.
   *  A wrong "trusted" can only come from ANOTHER process moving those dirs, which only ever delays a
   *  stop; it can never kill a healthy install.
   */
  async _runToolInstallGuarded(args, { onProgress, onChild }) {
    const dirs = await this._uvDirs();
    const startedAt = Date.now();
    let outBytes = 0;
    let stall = null;
    let capped = false;
    let trusted = false;
    let lastDirFp = null;
    let capTimer = null;
    const toolDir = dirs ? path.join(dirs.tools, PYPI_PACKAGE) : null;

    const sample = async () => {
      const dirFp = `${await topFingerprintAsync(dirs.cache)}#${await topFingerprintAsync(dirs.python)}#${await dirSizeBytesAsync(toolDir)}`;
      if (!trusted && lastDirFp !== null && dirFp !== lastDirFp) {
        trusted = true;
        this.log.info('[uv] the install is writing to uv\'s directories — progress signal trusted, wall-clock cap removed');
        if (capTimer) { this._timers.clearTimeout(capTimer); capTimer = null; }
      }
      lastDirFp = dirFp;
      return `${outBytes}|${dirFp}`;
    };

    const tick = onProgress
      ? this._timers.setInterval(() => onProgress(`still installing (${Math.round((Date.now() - startedAt) / 1000)}s)`), this._progressTickMs)
      : null;
    if (tick && tick.unref) tick.unref();
    let watchdog = null;
    try {
      capTimer = this._timers.setTimeout(() => {
        capped = true;
        this._killInstallChild(this._installChild, `flowpad install exceeded the ${this._toolInstallCapMs / 1000}s cap while its progress signal was not trusted — stopping it`);
      }, this._toolInstallCapMs);
      if (capTimer && capTimer.unref) capTimer.unref();
      if (dirs) {
        watchdog = createProgressWatchdog({
          sample,
          canStall: () => trusted,
          windowMs: this._watchdogWindowMs,
          strikes: this._watchdogStrikes,
          timers: this._timers,
          log: this.log,
          onStall: (info) => {
            stall = info;
            this._killInstallChild(this._installChild, `flowpad install made no progress for ${info.misses} x ${info.windowMs / 1000}s — stopping it`);
          },
        }).start();
      } else {
        this.log.warn(`[uv] no directories to watch — the flowpad install is bounded by the ${this._toolInstallCapMs / 1000}s cap only`);
      }
      return await this._runStreaming('uv', args, {
        onChild,
        onData: (chunk) => { outBytes += chunk.length; },
        onLine: (line) => { if (onProgress && isInstallProgressLine(line)) onProgress(line); },
      });
    } catch (err) {
      if (capped || stall) {
        // We killed uv mid-install: its tool venv may be half-replaced. killedByGuard keeps the
        // install-in-progress marker so the next launch repairs it (see _uvToolInstallForce).
        const e = installFailure(
          capped
            ? `The Flowpad install did not finish within ${this._toolInstallCapMs / 1000} seconds. Check your internet connection, then click Retry.`
            : `The Flowpad install stalled: no new data for ${(stall.misses * stall.windowMs) / 1000} seconds (${stall.misses} checks of ${stall.windowMs / 1000} s). Check your internet connection, then click Retry.`,
          { stderr: '', code: null },
        );
        e.killedByGuard = true;
        if (capped) e.timedOut = true; else e.stalled = true;
        throw e;
      }
      throw err;
    } finally {
      if (watchdog) watchdog.stop();
      if (capTimer) this._timers.clearTimeout(capTimer);
      if (tick) this._timers.clearInterval(tick);
    }
  }

  _installMarkerPath() {
    return this._stateDir ? path.join(this._stateDir, 'desktop-install-in-progress.json') : null;
  }

  _writeInstallMarker(installArgs) {
    const file = this._installMarkerPath();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, args: installArgs }));
    } catch (err) {
      this.log.warn(`[uv] could not write the install-in-progress marker: ${err.message}`);
    }
  }

  _clearInstallMarker() {
    const file = this._installMarkerPath();
    if (!file) return;
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }

  /**
   * True when a previous run died (or was told to quit) in the middle of a
   * `uv tool install`: the marker is written before uv starts and removed the
   * moment it finishes, so finding it at launch means the tool venv may be
   * half-replaced and should be repaired before the backend is started.
   */
  hadInterruptedInstall() {
    const file = this._installMarkerPath();
    if (!file || !fs.existsSync(file)) return false;
    // A marker owned by ANOTHER LIVE process is an install in flight, not an interrupted
    // one — repairing now would run a second `uv tool install` over it. (A dead owner's pid
    // that the OS reused reads as alive: we skip the repair until it exits, never race it.)
    try {
      const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pid && pid !== process.pid && isPidAlive(pid)) return false;
    } catch { /* unreadable marker → treat as interrupted */ }
    return true;
  }

  /** True when the install-in-progress marker file exists (whoever wrote it). */
  hasInstallMarker() {
    const file = this._installMarkerPath();
    return !!file && fs.existsSync(file);
  }

  /** True while a `uv tool install` (drain, spawn or retry) is running. */
  isInstalling() {
    return this._installing;
  }

  /**
   * Stop a running install because the app is quitting. The marker is kept, so
   * the next launch repairs the venv. Returns false when nothing was running.
   * No waiting: the child is signalled and the app is free to exit.
   */
  abortInstall() {
    if (!this._installing) return false;
    this._installAborted = true;
    this._killInstallChild(this._installChild, 'aborting the running install');
    return true;
  }

  /** Signal an install child and its tree. No waiting: it is signalled and we move on. */
  _killInstallChild(child, why) {
    if (!child || child.exitCode !== null || !child.pid) return;
    this.log.warn(`[uv] ${why} (pid ${child.pid})`);
    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      } else {
        child.kill('SIGTERM');
      }
    } catch (err) {
      this.log.warn(`[uv] could not signal the install child: ${err.message}`);
    }
  }

  /**
   * Repair a tool venv left half-replaced by an interrupted install (see
   * hadInterruptedInstall). Keeps the marker if the repair itself fails, so the
   * next launch tries again. Returns true when a repair ran.
   */
  async repairIfInterrupted({ onProgress } = {}) {
    if (!this.hadInterruptedInstall()) return false;
    this.log.warn('[uv] previous install was interrupted — repairing the tool environment');
    await this.ensureUv({ onProgress });
    try {
      await this.reinstall({ onProgress });
    } catch (err) {
      this._writeInstallMarker(['repair-failed']);
      throw err;
    }
    return true;
  }

  /**
   * First-time install: `uv tool install flowpad` (latest from PyPI).
   */
  async installLatest({ onProgress } = {}) {
    this.log.info(`[uv] Installing latest ${PYPI_PACKAGE} from PyPI...`);
    const pin = await this._pythonPinForUpgrade();
    await this._uvToolInstallForce(
      ['tool', 'install', PYPI_PACKAGE, '--python', pin, '--force'],
      { onProgress },
    );
    await this._ensureShimOnPath();

    this._flowBin = await this._resolveFlowBin();
    this.log.info(`[uv] ${PYPI_PACKAGE} installed, binary at ${this._flowBin}`);
  }

  /**
   * Ensure uv's tool-bin dir (~/.local/bin) is on the user's *shell* PATH, so
   * `flow` resolves in a fresh terminal — not just inside this app (which finds
   * it via _enrichedPath()). Without this, a clean install leaves `flow` working
   * in-app but "not recognized" when the user types it in a terminal.
   *
   * `uv tool update-shell` is uv's own cross-platform PATH-fixer: it edits the
   * User PATH (registry) on Windows and the shell profile (.zshrc/.bashrc/
   * .profile) on macOS/Linux, and is idempotent (won't double-append). Best
   * effort — never block install/upgrade if it fails; we log and move on.
   *
   * NOTE: like any PATH edit, it only takes effect in terminals opened *after*
   * this runs — an already-open shell won't see `flow` until restarted.
   */
  async _ensureShimOnPath() {
    try {
      await this._uv(['tool', 'update-shell'], { timeout: 30000 });
      this.log.info('[uv] Ensured uv tool-bin dir is on user PATH');
    } catch (err) {
      this.log.warn(
        `[uv] update-shell failed; flow may not be on terminal PATH: ${err.message}`
      );
    }
  }

  /**
   * Locate the `flow` binary after uv tool install.
   *
   * 1. Check uv tool bin dir for the binary directly
   * 2. Try running `flow --help` from the enriched PATH
   *
   * Returns an absolute path (or bare 'flow' if found on PATH).
   */
  async _resolveFlowBin() {
    const binDir = await this._getUvToolBinDir();

    // On Windows uv may create flow.exe or flow.cmd
    const names = IS_WIN ? ['flow.exe', 'flow.cmd', 'flow'] : ['flow'];

    for (const name of names) {
      const candidate = path.join(binDir, name);
      if (fs.existsSync(candidate)) {
        this.log.info(`[uv] Found flow binary: ${candidate}`);
        return candidate;
      }
    }

    // Fallback: try PATH (enriched PATH includes ~/.local/bin etc.)
    try {
      await this._run('flow', ['--help']);
      this.log.info('[uv] flow is available on PATH');
      return 'flow';
    } catch {
      // Not found
    }

    throw new Error(
      `flow CLI binary not found in ${binDir} or on PATH.\n` +
      `uv tool install may have failed — check the logs above.`
    );
  }

  // ---------------------------------------------------------------------------
  // Version management
  // ---------------------------------------------------------------------------

  /**
   * Get the currently installed flowpad version via `uv tool list`.
   * Returns the version string (e.g., "0.1.15") or null if not installed.
   */
  async _getInstalledVersion() {
    try {
      const { stdout } = await this._uv(['tool', 'list'], { timeout: 15000 });
      // uv tool list output format: "flowpad v0.1.35" (one tool per line)
      for (const line of stdout.split('\n')) {
        if (line.startsWith(PYPI_PACKAGE)) {
          // Shared SEMVER_RE so an "extra" tag (e.g. "0.2.40-local") is kept,
          // not silently dropped. m[0] is the full matched version string.
          const match = line.match(SEMVER_RE);
          if (match) return match[0];
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the backend server via `flow start`.
   * Sets environment variables for desktop mode.
   */
    async start() {
      if (!this._flowBin) {
        throw new Error('flow binary not set — call startWithBin() or installLatest() first');
      }

      this.isShuttingDown = false;
      this.log.info('[uv] Starting backend via flow start...');

      // On Windows, probe whether the uv shim is blocked by Device Guard.
      // If so, _useUvToolRun gets set and _flowCmd() routes around it.
      await this._probeFlowBinOnce();
      this._assertNotPolicyBlocked();

      // Ensure port 9007 is free before starting
      await this.ensurePortFree(9007);

      // Read the per-instance Fernet sod-key from the OS keychain via the
      // bundled, signed flow-rs binary. If present (i.e. a previous launch
      // or the SecretApprovalDialog has already provisioned it), pass it
      // through as SOD_ENC_KEY so Python's `sod_key` property short-circuits
      // and never touches the keychain itself — keeping the entry's ACL
      // trust list flow-rs-only (no python3.x ownership). If absent, the
      // React SecretApprovalDialog fires on first secret use, mints via
      // flow-rs (provision-sod-key IPC), and seeds the running backend via
      // /secrets/seed-key.
      const sodKey = await this._loadSodKey();

      const env = {
        ...process.env,
        PATH: this._enrichedPath(),
        DEPLOY_ENV: 'desktop',
        MINIHUB_HOST: '127.0.0.1',
        LOCAL_SERVER_PORT: '9007',
        MINIHUB_RELOAD: 'false',
        FLOWPAD_NO_BROWSER: '1',
        FLOWPAD_DESKTOP: '1',
        // `flow start` reports its boot phases on stdout (flow_sdk/boot_progress.py)
        // so the startup gate can tell a slow launcher from a hung one. The CLI
        // consumes the variable; nothing it spawns inherits it.
        FLOWPAD_BOOT_PROGRESS: '1',
      };
      cleanPythonEnv(env, this.log);
      if (sodKey) {
        // Matches flow_sdk/instance_settings/base_settings.py:ENV_SOD_ENC_KEY.
        // Python's `sod_key` property reads this and short-circuits any
        // keychain access — no Python-keyring touch on subsequent launches.
        env.SOD_ENC_KEY = sodKey;
      }

      if (IS_WIN) {
        env.USERPROFILE = env.USERPROFILE || os.homedir();
      } else {
        env.HOME = os.homedir();
        env.USER = process.env.USER || process.env.LOGNAME || '';
        env.LOGNAME = process.env.LOGNAME || process.env.USER || '';
        env.SHELL = process.env.SHELL || '/bin/bash';
        env.LANG = process.env.LANG || 'en_US.UTF-8';
      }

      // shell:true on Windows breaks paths with spaces (e.g.
      // "C:\Users\avi tal\…\flow.exe" gets split on the space). Use shell
      // only when actually needed — see needsShellOnWin().
      const { cmd: flowCmd, args: flowArgs, shell: flowShell } = this._flowCmd(['start']);
      const useShell = flowShell !== undefined ? flowShell : needsShellOnWin(flowCmd);
      const cmdToRun = useShell ? quoteWinCmd(flowCmd) : flowCmd;
      // Ensure the app-owned workspace exists so spawn() doesn't ENOENT on the
      // cwd, and so the backend never falls back to walking the home tree.
      try {
        fs.mkdirSync(BACKEND_CWD, { recursive: true });
      } catch (e) {
        this.log.warn(`[uv] could not create backend cwd ${BACKEND_CWD}: ${e.message}`);
      }
      const child = spawn(cmdToRun, flowArgs, {
        env,
        cwd: BACKEND_CWD,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true,   // don't flash a console window
      });

      this._backendProcess = child;

      // The launch handle: what `flow start` has said so far, and whether it
      // has exited. The startup gate (main.js waitForBackend) reads it — a line
      // on this pipe is evidence that the launcher stage (CLI import, migrations,
      // monitor spawn) is still moving, and a non-zero exit ends the wait at once
      // with the launcher's own words. No fixed window here: the old 3s "give it
      // a chance to fail" was a wait that hid a slow CLI import behind it.
      const TAIL_CHARS = 4000;
      const launch = {
        startedAt: Date.now(),
        lines: 0,
        lastLine: '',
        lastLineAt: null,
        exit: null, // { code, signal } once the process has ended
        stdout: '',
        stderr: '',
        tail: () => `stdout:\n${launch.stdout.slice(-1000)}\n\nstderr:\n${launch.stderr.slice(-1000)}`,
      };
      const feed = (isErr) => splitLines((line) => {
        launch.lines += 1;
        launch.lastLine = line;
        launch.lastLineAt = Date.now();
        if (isErr) {
          launch.stderr = (launch.stderr + line + '\n').slice(-TAIL_CHARS);
          this.log.warn(`[flow stderr] ${line}`);
        } else {
          launch.stdout = (launch.stdout + line + '\n').slice(-TAIL_CHARS);
          this.log.info(`[flow stdout] ${line}`);
        }
      });
      child.stdout.on('data', feed(false));
      child.stderr.on('data', feed(true));
      child.on('error', (err) => {
        this.log.error(`[uv] flow start error: ${err.message}`);
      });
      launch.exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
          launch.exit = { code, signal };
          if (code === 0) {
            this.log.info('[uv] flow start exited 0 (monitor spawned)');
          } else {
            this.log.error(`[uv] flow start exited with code ${code}, signal ${signal}\n${launch.tail()}`);
          }
          resolve(launch.exit);
        });
      });
      this._lastLaunch = launch;

      // A spawn failure (ENOENT, EACCES) is known at once and is an error, not
      // something to wait out; everything slower than that is the gate's job.
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });

      this.log.info('[uv] flow start launched');
      return launch;
    }

    /** The handle of the most recent `flow start` (see start()), or null. */
    lastLaunch() {
      return this._lastLaunch || null;
    }

  /**
   * Stop the backend: flow stop, then kill all processes on port 9007.
   */
    stop() {
      // Re-entrant: a second caller (e.g. quit while the startup-timeout panel's
      // fire-and-forget stop is still running) awaits the SAME in-flight stop
      // instead of returning immediately and exiting mid-`flow stop`. Not an
      // `async` method on purpose — that would wrap the shared promise in a new
      // one per call.
      if (this._stopPromise) return this._stopPromise;
      if (this.isShuttingDown) return Promise.resolve();
      this.isShuttingDown = true;
      this._stopPromise = this._doStop().finally(() => {
        this._stopPromise = null;
      });
      return this._stopPromise;
    }

    async _doStop() {
      this.log.info('[uv] Stopping backend...');

      // Kill the flow start CLI process if still running
      if (this._backendProcess && !this._backendProcess.killed) {
        try {
          this._backendProcess.kill('SIGTERM');
        } catch (e) {
          this.log.warn(`[uv] Failed to SIGTERM backend: ${e.message}`);
        }
      }

      // 1. Run flow stop
      await this._flowStop();

      // 2. Kill any remaining processes on port 9007
      await this._killPort(9007);

      this._backendProcess = null;
    }

  /**
   * Run `flow stop`. Swallows errors.
   */
  /** True once start() has spawned `flow start` — before that there is nothing of ours to stop. */
  hasLaunchedBackend() {
    return !!(this._backendProcess || this._lastLaunch);
  }

  async _flowStop() {
    const { cmd, args, shell } = this._flowBin
      ? this._flowCmd(['stop'])
      : { cmd: 'flow', args: ['stop'] };
    try {
      await this._run(cmd, args, { timeout: 10000, ...(shell === undefined ? {} : { shell }) });
      this.log.info('[uv] flow stop completed');
    } catch (error) {
      this.log.warn(`[uv] flow stop failed: ${error.message}`);
    }
  }

  /**
   * Check if port 9007 is in use, and if so run flow stop + kill the port.
   * Called before starting the backend.
   */
  async ensurePortFree(port = 9007) {
    const inUse = await this._isPortInUse(port);
    if (!inUse) {
      this.log.info(`[uv] Port ${port} is free`);
      return;
    }

    this.log.info(`[uv] Port ${port} is in use, cleaning up...`);

    // 1. Run flow stop
    await this._flowStop();

    // 2. Kill any remaining processes on the port
    await this._killPort(port);
  }

  /**
   * Check if a port is in use by attempting a connection.
   */
  async _isPortInUse(port) {
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { resolve(false); });
      socket.connect(port, '127.0.0.1');
    });
  }

  /**
   * Kill all processes using the given port.
   * Uses lsof on Unix, netstat/taskkill on Windows.
   */
  async _killPort(port) {
    this.log.info(`[uv] Killing all processes on port ${port}...`);
    try {
      if (IS_WIN) {
        const { stdout } = await execFileAsync('netstat', ['-ano'], { timeout: 5000 });
        const pids = parseNetstatPids(stdout, port);
        for (const pid of pids) {
          try {
            await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { timeout: 5000 });
            this.log.info(`[uv] Killed PID ${pid} on port ${port}`);
          } catch { /* ignore */ }
        }
      } else {
        try {
          // -sTCP:LISTEN restricts to the listening socket so we don't also
          // SIGKILL processes that merely hold a client connection to the port
          // (mirrors the LISTENING-only filter in the Windows branch above).
          const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { timeout: 5000 });
          const pids = stdout.trim().split('\n').map(p => parseInt(p, 10)).filter(p => p > 0);
          for (const pid of pids) {
            try {
              process.kill(pid, 'SIGTERM');
              this.log.info(`[uv] Sent SIGTERM to PID ${pid} (port ${port})`);
            } catch (e) {
              if (e.code !== 'ESRCH') {
                this.log.warn(`[uv] Failed to kill PID ${pid}: ${e.message}`);
              }
            }
          }
          if (pids.length > 0) {
            await new Promise(r => setTimeout(r, 2000));
            for (const pid of pids) {
              try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
            }
          }
        } catch {
          // lsof exits with 1 if no processes found — that's fine
        }
      }
    } catch (e) {
      this.log.warn(`[uv] _killPort error: ${e.message}`);
    }
  }

  /**
   * Restart the backend.
   */
  async restart() {
    this.log.info('[uv] Restarting backend...');
    await this.stop();
    this.isShuttingDown = false;
    await this.start();
  }

  /**
   * Whether we believe the backend is still running.
   */
  isRunning() {
    return !this.isShuttingDown;
  }

  // ---------------------------------------------------------------------------
  // Background update check
  // ---------------------------------------------------------------------------

  /**
   * Get upgrade info from `flow upgrade --info` (includes status fields + version_hash).
   * Returns parsed JSON object or null.
   */
  async _getUpgradeInfo() {
    try {
      const { cmd, args, shell } = this._flowCmd(['upgrade', '--info']);
      const { stdout } = await this._run(cmd, args, { timeout: 15000, ...(shell === undefined ? {} : { shell }) });
      return JSON.parse(stdout);
    } catch (err) {
      this.log.warn(`[uv] _getUpgradeInfo failed: ${err.message}`);
      return null;
    }
  }

  // There are deliberately TWO update checks, for two different moments:
  //
  //   getLatestPypiVersion / isUpgradeAvailable  → asks PyPI directly. No
  //     backend and no cloud needed. Used during the desktop-upgrade window,
  //     where the local flow backend is stopped/not-yet-started.
  //
  //   getUpdateStatus → asks the cloud `/check-update` for its policy verdict
  //     (whether an upgrade is *required*). Used by the background prompt while
  //     the app is already running.

  /**
   * Latest published flowpad version on PyPI, or null on any failure. Hits
   * pypi.org only — works even when the local backend is down.
   */
  async getLatestPypiVersion() {
    const info = await this._getLatestPypiInfo();
    return (info && info.version) || null;
  }

  /** `info` block of the latest flowpad release on PyPI, or null on any failure. */
  async _getLatestPypiInfo() {
    try {
      const res = await fetch(`https://pypi.org/pypi/${PYPI_PACKAGE}/json`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        this.log.warn(`[uv] PyPI version lookup failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      return (data && data.info) || null;
    } catch (err) {
      this.log.warn(`[uv] PyPI version lookup failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Interpreter minor to pin an upgrade to: the higher of the bundled pin
   * (this desktop build's pyproject.toml) and the `requires_python` floor of
   * the latest PyPI release. A desktop older than the release it installs
   * would otherwise pin an interpreter the release refuses to run on
   * ("flowpad==X depends on Python>=3.11", uv exits non-zero).
   */
  /** PyPI `info` of ONE release (requires_python, yanked, …), or null when unknown (offline, 404). */
  async _getPypiVersionInfo(version) {
    try {
      const res = await fetch(`https://pypi.org/pypi/${PYPI_PACKAGE}/${encodeURIComponent(version)}/json`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        this.log.warn(`[uv] PyPI lookup of ${PYPI_PACKAGE} ${version} failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      return (data && data.info) || null;
    } catch (err) {
      this.log.warn(`[uv] PyPI lookup of ${PYPI_PACKAGE} ${version} failed: ${err.message}`);
      return null;
    }
  }

  /**
   * The engine release to install when the user already agreed to a SPECIFIC version (saved when the
   * update was offered). That version may have been yanked since — `uv` would still install it when
   * pinned with `==` — so ask PyPI; a yanked version is replaced by the latest release. When PyPI cannot
   * be reached the requested version is used as is (the install needs the network anyway, and the
   * Python pin then falls back to the bundled one).
   * @returns {Promise<{version: string, info: object|null}>}
   */
  async _resolveEngineTarget(version) {
    const info = await this._getPypiVersionInfo(version);
    if (info && info.yanked === true) {
      this.log.warn(`[uv] ${PYPI_PACKAGE} ${version} was yanked on PyPI${info.yanked_reason ? ` (${info.yanked_reason})` : ''} — installing the latest release instead`);
      const latest = await this._getLatestPypiInfo();
      if (latest && latest.version) return { version: latest.version, info: latest };
    }
    return { version, info };
  }

  async _pythonPinForUpgrade(release) {
    // `release` undefined → the latest release's metadata; null → unknown (bundled pin only); else that release's.
    const info = release === undefined ? await this._getLatestPypiInfo() : release;
    const remote = pythonFloor(info && info.requires_python);
    const pin = maxPythonVersion(tryPythonVersion(), remote);
    if (!pin) return getPythonVersion(); // broken build and no PyPI answer: throws, naming the build
    if (remote && pin === remote && pin !== tryPythonVersion()) {
      this.log.info(`[uv] Latest ${PYPI_PACKAGE} needs Python >=${remote}; pinning ${pin} instead of the bundled ${tryPythonVersion()}`);
    }
    return pin;
  }

  /**
   * True if PyPI has a newer flowpad than `installedVersion`. Returns false
   * (don't upgrade) when either version can't be determined, so an offline /
   * indeterminate result never forces a needless reinstall. Backend-independent.
   */
  async isUpgradeAvailable(installedVersion) {
    if (!installedVersion) return false;
    const latest = await this.getLatestPypiVersion();
    if (!latest) return false;
    const available = isNewer(installedVersion, latest);
    this.log.info(
      available
        ? `[uv] flowpad upgrade available: ${installedVersion} → ${latest}`
        : `[uv] flowpad is up to date (installed=${installedVersion}, latest=${latest})`
    );
    return available;
  }

  /**
   * Ask the cloud `/check-update` endpoint for its verdict. Returns
   * { currentVersion, latestVersion, required } or null when the version can't
   * be read or the check fails — callers treat null as "no update".
   */
  async getUpdateStatus(cloudUrl) {
    const upgradeInfo = await this._getUpgradeInfo();
    if (!upgradeInfo || !upgradeInfo.version) return null;
    try {
      const res = await fetch(`${cloudUrl}${API_PREFIX}/check-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upgradeInfo),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        currentVersion: upgradeInfo.version,
        latestVersion: data.latest_version || null,
        required: data.status === UpdateStatus.REQUIRED,
      };
    } catch (err) {
      this.log.warn(`[uv] update check failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Standalone, dependency-free update verdict for the pre-start prompt: just
   * compare the installed version to the latest on PyPI.
   *
   * This is the PRIMARY check before the backend boots, where the cloud
   * `/check-update` and `flow upgrade --info` paths are both unavailable or
   * unreliable. It needs neither: `getInstalledVersionSync` reads `_version.py`
   * as text (no Python, so it works even on a venv that can't import
   * `flow_sdk`), and `getLatestPypiVersion` hits PyPI directly. So it behaves
   * identically for healthy, broken, and offline-from-cloud installs.
   *
   * `required` is true when PyPI is strictly newer, or when the installed
   * version can't be read at all (a partial/corrupt install worth repairing by
   * upgrade). Returns null when PyPI is unreachable, so an offline machine
   * never shows a prompt it can't act on.
   */
  async _pypiUpdateStatus() {
    const latestVersion = await this.getLatestPypiVersion();
    if (!latestVersion) return null;
    const currentVersion = this.getInstalledVersionSync() || null;
    const required = !currentVersion || isNewer(currentVersion, latestVersion);
    if (!required) return null;
    this.log.info(
      `[uv] Pre-start update check: installed=${currentVersion || 'unknown'}, ` +
      `latest=${latestVersion} → offering upgrade`
    );
    return { currentVersion, latestVersion, required: true };
  }

  /**
   * Run a background update check after the UI is loaded.
   * Non-blocking — failures are logged and silently ignored.
   * Shows a native OS dialog if an update is required.
   */
  /**
   * Remember that the user answered "Later" to `version` (from any dialog), so
   * the periodic check does not re-offer it this session.
   */
  deferPackageVersion(version) {
    if (version) this._deferredPackageVersion = version;
  }

  /** @param {((text: string) => Promise<{ok: boolean, error?: string}>)|null} fn */
  setFailureSharer(fn) {
    this._failureSharer = typeof fn === 'function' ? fn : null;
  }

  /** Version offered by the package dialog currently on screen, or null. */
  openPackageDialogVersion() {
    return this._packageDialog ? this._packageDialog.version : null;
  }

  /** Close the open package dialog as if the user chose "Later" (a newer release supersedes it). */
  supersedePackageDialog() {
    if (this._packageDialog) this._packageDialog.abort.abort();
  }

  async checkForUpdatesInBackground(
    mainWindow,
    { sendStatus, waitForBackend, backendUrl, cloudUrl, beforeBackendStart = false, compareWithPypi = beforeBackendStart }
  ) {
    try {
      // Pre-start: the backend is down and the install may even be broken, so
      // decide with the standalone PyPI-vs-installed check — no cloud, no CLI,
      // so it behaves the same for healthy, broken, and offline-from-cloud
      // installs (offer the upgrade whenever PyPI is newer). Post-boot: the
      // running backend can answer the cloud `/check-update` policy, so defer
      // to that verdict — unless the caller asks for the plain PyPI comparison
      // (`compareWithPypi`, used by the hourly check so a newer release is
      // offered even when the cloud policy would not *require* it).
      const status = compareWithPypi
        ? await this._pypiUpdateStatus()
        : await this.getUpdateStatus(cloudUrl);
      if (!status || !status.required || !status.latestVersion) return false;

      const latest = status.latestVersion;
      // The user already answered "Later" for this exact version in this
      // session — don't ask again every hour. A new release, or the next launch
      // (fresh process), asks again.
      if (latest === this._deferredPackageVersion) {
        this.log.info(`[uv] Update ${latest} available but deferred by the user earlier this session`);
        return false;
      }
      this.log.info(`[uv] Update available: ${status.currentVersion || 'unknown'} → ${latest}`);

      if (!mainWindow || mainWindow.isDestroyed()) return false;

      // Abortable: a newer release found while this is on screen closes it (as
      // "Later") via supersedePackageDialog(), so only one dialog, for the latest
      // version, is ever shown.
      this._packageDialog = { version: latest, abort: new AbortController() };
      let response;
      try {
        ({ response } = await require('electron').dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Update Available',
          message: `A new version of FlowPad is available (${latest}).`,
          detail: status.currentVersion
            ? `You are running version ${status.currentVersion}.`
            : 'Your current installation could not be verified and may be incomplete.',
          buttons: ['Upgrade', 'Later'],
          defaultId: 0,
          cancelId: 1, // Esc / close = Later, never an implicit Upgrade
          signal: this._packageDialog.abort.signal,
        }));
      } finally {
        this._packageDialog = null;
      }
      if (response !== 0) this._deferredPackageVersion = latest;
      if (response !== 0 || !mainWindow || mainWindow.isDestroyed()) return false;
      // User chose Upgrade — show loading screen and wait for its IPC listener.
      const loadingPath = require('path').join(__dirname, 'loading.html');
      await mainWindow.loadFile(loadingPath);
      await new Promise(r => setTimeout(r, 200));

      // Pre-start: nothing is running yet, so skip the stop. Post-boot: stop the
      // live backend before reinstalling over it.
      if (!beforeBackendStart) {
        if (sendStatus) sendStatus('Stopping server');
        await this.stop();
        this.isShuttingDown = false;
      }

      if (sendStatus) sendStatus('Upgrading Flowpad');
      await this.upgrade();

      // Pre-start: hand back to startApp's normal start path to boot the
      // upgraded backend — calling start()/loadURL here would double-start the
      // backend and load the main UI prematurely.
      if (beforeBackendStart) return true;

      if (sendStatus) sendStatus('Starting server');
      await this.start();

      if (sendStatus) sendStatus('Waiting for server');
      // 120s window — matches the upgrade() subprocess ceiling and gives
      // the freshly-installed backend room to boot before the user sees
      // a false "failed to start" error. A backend that never gets healthy is
      // a failed upgrade: fall into the recovery path below instead of loading
      // a dead URL.
      if (waitForBackend && !(await waitForBackend({ maxChecks: 240 }))) {
        throw new Error('upgraded backend did not become healthy');
      }

      if (mainWindow && !mainWindow.isDestroyed() && backendUrl) {
        mainWindow.loadURL(backendUrl);
      }
      return true;
    } catch (err) {
      this.log.warn(`[uv] Background update/upgrade failed: ${err.message}`);
      // Pre-start failures fall through to startApp's own start path (which
      // handles broken installs), so there's nothing to restore here. Post-boot
      // we have ALREADY stopped the backend and swapped the window to the
      // loading splash, so returning here would strand the user on "Upgrading
      // Flowpad…" forever with a dead backend (no timeout screen — that only
      // exists in the startup path). Restore the running app instead.
      if (!beforeBackendStart) {
        const restored = await this._recoverRunningBackendAfterFailedUpgrade(
          mainWindow, { waitForBackend, backendUrl, sendStatus }
        );
        if (!restored && mainWindow && !mainWindow.isDestroyed()) {
          await showFailureDialog({
            dialog: require('electron').dialog,
            parent: mainWindow,
            type: 'error',
            title: 'Update failed',
            message: 'FlowPad couldn’t finish updating and couldn’t restart automatically.',
            detail:
              `${err && err.message ? `Cause: ${err.message}\n\n` : ''}` +
              'Please quit and reopen FlowPad. If it keeps happening, run:\n\n' +
              `${upgradeCommand()}\n\n` +
              'then reopen FlowPad, or run "flow diagnose".',
            share: this._failureSharer,
            log: this.log,
          });
        }
      }
      return false;
    }
  }

  /**
   * Bring the desktop UI back to a working state after a POST-BOOT upgrade
   * attempt failed. By the time `upgrade()` throws we have already stopped the
   * running backend and shown the loading splash, so without this the user is
   * stranded on "Upgrading Flowpad…" with a dead backend. We restart the
   * still-installed (old) version — repairing it if the failed `--force` left
   * the tool dir partially removed — and reload the UI, so the user keeps using
   * the current version. The upgrade is retried automatically on the next
   * launch's pre-start check, when nothing holds the tool dir open.
   *
   * Returns true if the app was restored, false if recovery itself failed (the
   * caller then surfaces a real error instead of a frozen splash).
   */
  async _recoverRunningBackendAfterFailedUpgrade(mainWindow, { waitForBackend, backendUrl, sendStatus }) {
    try {
      if (sendStatus) sendStatus('Update failed — restoring Flowpad');
      this.isShuttingDown = false;
      // The failed `--force` may have left the tool dir partially removed.
      this._flowBin = this.getInstalledFlowBin() || this._flowBin;
      if (!this._flowBin) {
        this.log.warn('[uv] flow binary missing after failed upgrade — repairing install…');
        await this.reinstall();
        this._flowBin = this.getInstalledFlowBin() || this._flowBin;
      }
      try {
        await this.start();
      } catch (startErr) {
        if (!this.isBrokenInstallError(startErr)) throw startErr;
        this.log.warn('[uv] Existing install broken after failed upgrade — repairing…');
        await this.reinstall();
        await this.start();
      }
      if (waitForBackend && !(await waitForBackend({ maxChecks: 240 }))) {
        throw new Error('restored backend did not become healthy');
      }
      if (mainWindow && !mainWindow.isDestroyed() && backendUrl) {
        mainWindow.loadURL(backendUrl);
      }
      this.log.info('[uv] Restored the running version after a failed upgrade; will retry the upgrade next launch.');
      return true;
    } catch (recoverErr) {
      this.log.error(`[uv] Recovery after failed upgrade failed: ${recoverErr.message}`);
      return false;
    }
  }

  /**
   * Upgrade flowpad to the latest version via `uv tool install flowpad@latest`.
   */
  async upgrade({ onProgress, version } = {}) {
    // `version`: the exact release the user agreed to (update offered earlier) instead of "whatever is latest now".
    let spec = `${PYPI_PACKAGE}@latest`;
    let pin;
    if (version) {
      const target = await this._resolveEngineTarget(version);
      spec = `${PYPI_PACKAGE}==${target.version}`;
      pin = await this._pythonPinForUpgrade(target.info); // that release's own requires_python
      this.log.info(`[uv] Upgrading flowpad to ${target.version}${target.version !== version ? ` (${version} was withdrawn)` : ''}...`);
    } else {
      pin = await this._pythonPinForUpgrade();
      this.log.info('[uv] Upgrading flowpad...');
    }
    await this._uvToolInstallForce(
      ['tool', 'install', spec, '--python', pin, '--force'],
      { onProgress },
    );
    await this._ensureShimOnPath();
    this._flowBin = await this._resolveFlowBin();
    this.log.info('[uv] Upgrade complete');
  }

  /**
   * Repair a corrupt install: a `flow.exe`/`flow` shim exists on disk (so the
   * fast path tries it) but its env can't `import flow_sdk` — the package
   * never finished installing into site-packages, or was quarantined/removed.
   * `--reinstall` recreates the tool venv and reinstalls every package (not
   * just a metadata refresh), then we re-resolve the freshly written shim.
   */
  async reinstall({ onProgress } = {}) {
    this.log.info(`[uv] Repairing ${PYPI_PACKAGE} install (--reinstall --force)...`);
    const pin = await this._pythonPinForUpgrade();
    await this._uvToolInstallForce(
      ['tool', 'install', PYPI_PACKAGE, '--python', pin, '--reinstall', '--force'],
      { onProgress },
    );
    await this._ensureShimOnPath();
    this._flowBin = await this._resolveFlowBin();
    this.log.info(`[uv] Repair complete, binary at ${this._flowBin}`);
  }

  /**
   * True when an error from `flow start` indicates the install itself is
   * broken — the interpreter runs but can't import the package. The canonical
   * symptom is `ModuleNotFoundError: No module named 'flow_sdk'` (the wheel's
   * own top-level module is missing), which means a `--reinstall` will fix it.
   * Deliberately narrow: a generic crash or a runtime error in working code
   * must NOT trigger a reinstall loop.
   */
  isBrokenInstallError(error) {
    const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`;
    // Order-independent: a Python traceback prints the flow_sdk file frames
    // FIRST and the `ModuleNotFoundError/ImportError:` line LAST, so we can't
    // assume the keyword precedes "flow_sdk". Trigger when the package's own
    // top-level module is missing, OR any import error occurs in flowpad's own
    // code (its traceback mentions flow_sdk — e.g. a missing transitive dep).
    const importFailure = /\b(ModuleNotFoundError|ImportError)\b/.test(text);
    return /No module named ['"]flow_sdk/.test(text)
      || (importFailure && /flow_sdk/.test(text));
  }

  /**
   * True when a `uv tool install … --force` failed because the flowpad tool
   * dir is locked by a still-running process (Windows): uv can't remove
   * `…\flowpad\Scripts` while a file under it is held open. The canonical
   * symptom is `failed to remove directory …flowpad…: Access is denied. (os
   * error 5)`. Deliberately narrow — a normal install/network error must NOT
   * trigger the lock-retry loop. Windows-only signature; never matches on the
   * Unix path (where the lock can't happen).
   */
  isToolDirLockedError(error) {
    const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`;
    return (/failed to remove directory/i.test(text) && /flowpad/i.test(text))
      || /\bos error 5\b/i.test(text)
      || (/access is denied/i.test(text) && /flowpad/i.test(text));
  }

  /**
   * True when `uv tool install … --force` aborted because the flowpad tool env
   * is corrupt/half-written — an interrupted destructive replace left `…/flowpad`
   * with `lib/` + `pyvenv.cfg` but no `bin/python`, so uv reports
   * "Invalid environment: missing Python executable at …/flowpad/bin/python3"
   * and refuses to replace it (rather than a lock or a network error). Narrow by
   * design: require the flowpad tool path so a generic uv message never triggers
   * the quarantine-and-rebuild. See RCA fad616fc.
   */
  isCorruptEnvError(error) {
    const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`;
    const corrupt = /invalid environment/i.test(text)
      || /missing python executable/i.test(text);
    return corrupt && /flowpad/i.test(text);
  }

  /**
   * Read the per-instance Fernet sod-key from the OS keychain via the
   * bundled `flow-rs` binary. Reads from the same flow-rs binary that
   * wrote the entry (see main.js::secrets:provision-sod-key) succeed
   * without an ACL prompt; flow-rs is a no-op for fresh installs where
   * the entry doesn't exist yet. Returns null on miss, flow-rs binary
   * unavailable, or any error — caller treats that as "no key", and the
   * React SecretApprovalDialog handles first-time approval.
   */
  async _loadSodKey() {
    let flowRs;
    try {
      flowRs = require('./flow-rs-keychain');
    } catch (err) {
      this.log.warn(`[uv] flow-rs-keychain not available: ${err.message}`);
      return null;
    }
    const account = flowRs.sodKeyAccount();
    try {
      const key = await flowRs.getKeyRestricted(SOD_KEY_KEYCHAIN_SERVICE, account);
      if (key) {
        this.log.info(`[uv] Loaded Flowpad sod_key from keychain (${account})`);
        return key;
      }
    } catch (err) {
      this.log.warn(`[uv] keychain read failed: ${err.message}`);
    }
    this.log.info('[uv] No sod_key in keychain — SecretApprovalDialog will fire on first secret use');
    return null;
  }
}

// Keychain SERVICE for the per-instance Fernet sod-key. Matches
// flow_sdk/instance_settings/base_settings.py:SOD_KEY_KEYCHAIN_SERVICE so
// both code paths address the same logical namespace. The ACCOUNT diverges
// intentionally between Electron (`<instance>.flow-rs`, see
// flow-rs-keychain.js::sodKeyAccount) and Python's fallback path (bare
// `<instance>`); under Electron-driven flow Python never reaches its
// fallback (it gets the value via SOD_ENC_KEY env or the /secrets/seed-key
// endpoint), so the slot divergence has no functional effect.
const SOD_KEY_KEYCHAIN_SERVICE = 'Flowpad.ai.sod_key';

module.exports = UvManager;
module.exports.SOD_KEY_KEYCHAIN_SERVICE = SOD_KEY_KEYCHAIN_SERVICE;
// PyPI package + pinned interpreter, exported so main.js can surface the exact
// `uv tool install` command to the user in the startup-timeout dialog.
module.exports.PYPI_PACKAGE = PYPI_PACKAGE;
module.exports.getPythonVersion = getPythonVersion;
module.exports.tryPythonVersion = tryPythonVersion;
module.exports.upgradeCommand = upgradeCommand;
module.exports.pythonVersionFromPyproject = pythonVersionFromPyproject;
module.exports.pythonFloor = pythonFloor;
module.exports.dirSizeBytes = dirSizeBytes;
module.exports.topFingerprintAsync = topFingerprintAsync;
module.exports.dirSizeBytesAsync = dirSizeBytesAsync;
module.exports.mktempShimSource = mktempShimSource;
module.exports.windowsPowerShellModulePath = windowsPowerShellModulePath;
module.exports.UV_INSTALL_SH = UV_INSTALL_SH;
module.exports.UV_INSTALL_PS1 = UV_INSTALL_PS1;
module.exports.installFailure = installFailure;
module.exports.cleanPythonEnv = cleanPythonEnv;
module.exports.isPolicyBlockError = isPolicyBlockError;
module.exports.PY_FLOW_ENTRY = PY_FLOW_ENTRY;
module.exports.policyBlockedError = policyBlockedError;
module.exports.maxPythonVersion = maxPythonVersion;
// Pure helpers exported for unit testing (electron/uv-manager.test.js).
module.exports.needsShellOnWin = needsShellOnWin;
module.exports.quoteWinCmd = quoteWinCmd;
module.exports.parseNetstatPids = parseNetstatPids;
module.exports.isInstallProgressLine = isInstallProgressLine;
module.exports.splitLines = splitLines;
