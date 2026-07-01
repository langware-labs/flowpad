const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');
const { SEMVER_RE, isNewer } = require('./semver');

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PATH_SEP = IS_WIN ? ';' : ':';

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

// Python interpreter flowpad's tool venv must run on. flowpad requires >=3.10,
// but uv would otherwise pick the system default (e.g. 3.12). Pin every
// `uv tool install` to 3.10 so the backend always runs on the supported
// interpreter; uv auto-downloads a managed CPython 3.10 if none is present.
const PYTHON_VERSION = '3.10';

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

class UvManager {
  constructor(log) {
    this.log = log;
    this.isShuttingDown = false;
    this._flowBin = null;
    // Set to true when the uv-generated flow.exe shim is blocked by Windows
    // Device Guard / WDAC. We then route every flow invocation through
    // `uv tool run --from flowpad flow ...` instead, which doesn't go
    // through the unsigned shim.
    this._useUvToolRun = false;
    this._probedShim = false;
  }

  /**
   * Build the spawn command for invoking the flow CLI. When the uv shim
   * is blocked by Device Guard we route through `uv tool run` which
   * launches the venv's signed python directly.
   */
  _flowCmd(args) {
    if (this._useUvToolRun) {
      return { cmd: 'uv', args: ['tool', 'run', '--from', PYPI_PACKAGE, 'flow', ...args] };
    }
    return { cmd: this._flowBin, args };
  }

  /**
   * Probe the flow shim once. On Windows machines with Device Guard / WDAC,
   * `uv tool install` writes an unsigned shim that's blocked from executing.
   * If we detect that here, swap to the `uv tool run` fallback for the rest
   * of this session. No-op on non-Windows.
   *
   * Timeout is deliberately SHORT: a Device Guard / WDAC block fails the
   * process launch *instantly* (the OS rejects CreateProcess), so the only
   * thing we're waiting for is that fast rejection. A shim that's merely slow
   * to print `--help` (cold Python import on first run after install/AV scan)
   * tells us nothing — it works — so there's no reason to wait it out. On
   * timeout we fall through and let the real `flow start` proceed normally.
   * Do NOT widen this to "give --help time to finish": that just re-adds the
   * old multi-second tax to every cold launch for zero detection benefit.
   */
  async _probeFlowBinOnce() {
    if (this._probedShim || !IS_WIN || !this._flowBin) return;
    this._probedShim = true;
    try {
      await this._run(this._flowBin, ['--help'], { timeout: 2000 });
    } catch (err) {
      const stderr = (err.stderr || err.message || '').toString();
      if (/Device Guard|Application Control|blocked by your organization/i.test(stderr)) {
        this.log.warn(
          '[uv] flow shim blocked by Windows Device Guard — falling back to `uv tool run`'
        );
        this._useUvToolRun = true;
      }
      // Other failures will surface naturally on the real call below.
    }
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
    const env = {
      ...process.env,
      PATH: this._enrichedPath(),
      ...options.env,
    };
    this.log.info(`[uv] Running: ${cmd} ${args.join(' ')}`);
    const useShell = needsShellOnWin(cmd);
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
      if (error.stdout) this.log.error(`[uv] stdout: ${error.stdout}`);
      if (error.stderr) this.log.error(`[uv] stderr: ${error.stderr}`);
      throw error;
    }
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

  /**
   * Ensure uv is available. If not found, install it automatically.
   * Only called during first-time setup.
   */
  async ensureUv() {
    // Check if uv is already available
    try {
      await this._uv(['--version']);
      this.log.info('[uv] uv is available');
      return;
    } catch {
      this.log.info('[uv] uv not found, installing...');
    }

    // Install uv
    if (IS_WIN) {
      // Must use full PowerShell cmdlet names (not aliases like irm/iex)
      // and spawn powershell.exe directly without shell: true
      await new Promise((resolve, reject) => {
        const ps = spawn('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          'Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression',
        ], {
          shell: false,
          stdio: 'pipe',
          windowsHide: true,
        });

        let stdout = '';
        let stderr = '';

        ps.stdout.on('data', (d) => {
          const text = d.toString();
          stdout += text;
          this.log.info(`[uv] ${text.trim()}`);
        });
        ps.stderr.on('data', (d) => {
          const text = d.toString();
          stderr += text;
          this.log.warn(`[uv] ${text.trim()}`);
        });

        ps.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`uv install failed (exit ${code})\n${stderr}`));
          }
        });

        ps.on('error', reject);

        // Timeout after 120s
        setTimeout(() => {
          try { ps.kill(); } catch {}
          reject(new Error('uv install timed out after 120s'));
        }, 120000);
      });
    } else {
      await this._run('sh', [
        '-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      ], { timeout: 120000 });
    }

    // Verify
    try {
      await this._uv(['--version']);
      this.log.info('[uv] uv installed successfully');
    } catch (error) {
      throw new Error(`Failed to install uv: ${error.message}`);
    }
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
   * Read the desktop instance's server.json (written by the backend monitor).
   * Returns {} if missing/corrupt. The progress-aware startup wait uses this to
   * read the monitor's published boot state — `server_state`
   * ("booting"|"healthy"|"stalled") and `server_progress_iso` (bumped whenever
   * the monitor sees the boot make forward progress) — so it can tell a slow
   * cold boot from a hung one instead of killing it on a blind countdown. The
   * desktop app always targets the prod instance (port 9007).
   */
  getServerInfo() {
    try {
      const p = path.join(os.homedir(), '.flow', 'instances', 'prod', 'server.json');
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return {};
    }
  }

  /**
   * Windows-only: kill any process whose executable lives inside the flowpad
   * uv tool venv, so a `--force`/`--reinstall` install can replace it.
   *
   * `uv tool install … --force` must delete and recreate
   * `…\uv\tools\flowpad\Scripts\`, but Windows refuses to remove a directory
   * that contains a running .exe — "failed to remove directory … Scripts:
   * Access is denied. (os error 5)". The usual culprit is an orphaned backend
   * from a previous session (`python.exe -m flow_sdk.server.launch`) still
   * holding `Scripts\python.exe` open. It may NOT be listening on 9007
   * (crashed/hung mid-boot), so `ensurePortFree`/`_killPort` — which only target
   * the port listener — can't reach it. Match by image path instead and kill the
   * whole tree (`/T`) so spawned workers under the same venv go too.
   *
   * No-op on Unix: unlinking a running executable's file is allowed there, so
   * the tool dir can be replaced while the old backend keeps running.
   */
  async _killStaleToolProcesses() {
    if (!IS_WIN) return;
    const toolDir = path.join(
      os.homedir(), 'AppData', 'Roaming', 'uv', 'tools', PYPI_PACKAGE
    );
    try {
      const escaped = toolDir.replace(/'/g, "''");
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | ` +
        `Where-Object { $_.ExecutablePath -like '${escaped}\\*' } | ` +
        `Select-Object -ExpandProperty ProcessId`,
      ], { timeout: 8000, windowsHide: true });
      const pids = stdout.split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((p) => p > 0);
      for (const pid of pids) {
        try {
          await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
          this.log.info(`[uv] Killed stale tool process PID ${pid} (held ${toolDir})`);
        } catch { /* already gone / not killable — ignore */ }
      }
    } catch (e) {
      this.log.warn(`[uv] _killStaleToolProcesses failed: ${e.message}`);
    }
  }

  /**
   * Run `uv tool install … --force` resiliently against the Windows tool-dir
   * lock. On Windows, `--force` must delete and recreate
   * `…\uv\tools\flowpad\Scripts\`, which fails with "Access is denied (os
   * error 5)" while ANY process under that venv still holds a file open. We
   * kill those processes first, but `taskkill` returns before Windows has
   * actually released the handles, so a same-instant install can still lose
   * the race (observed in the field: a post-boot upgrade aborts here and the
   * app is left stuck on the loading splash).
   *
   * Strategy: kill the stale tool processes, attempt the install, and ONLY on
   * a tool-dir-locked error re-kill and wait a bounded moment for the
   * already-terminating processes to release their handles, then retry — up to
   * MAX_LOCK_RETRIES. This is not a blind retry to paper over a flake: we retry
   * exclusively the "dir is locked by a process we just killed" error, giving
   * the OS time to finish a teardown that is already in progress. Any other
   * failure throws immediately. On Unix the lock can't occur (unlinking a
   * running exe is allowed), so the first attempt always succeeds.
   */
  async _uvToolInstallForce(installArgs) {
    const MAX_LOCK_RETRIES = 3;
    const HANDLE_RELEASE_WAIT_MS = 1500;
    for (let attempt = 1; ; attempt++) {
      await this._killStaleToolProcesses();
      try {
        return await this._uv(installArgs, { timeout: 120000 });
      } catch (err) {
        if (attempt >= MAX_LOCK_RETRIES || !this.isToolDirLockedError(err)) throw err;
        this.log.warn(
          `[uv] tool dir locked (attempt ${attempt}/${MAX_LOCK_RETRIES}) — re-killing ` +
          `holders and waiting ${HANDLE_RELEASE_WAIT_MS}ms for handles to release`
        );
        await new Promise((r) => setTimeout(r, HANDLE_RELEASE_WAIT_MS));
      }
    }
  }

  /**
   * First-time install: `uv tool install flowpad` (latest from PyPI).
   */
  async installLatest() {
    this.log.info(`[uv] Installing latest ${PYPI_PACKAGE} from PyPI...`);
    await this._uvToolInstallForce(['tool', 'install', PYPI_PACKAGE, '--python', PYTHON_VERSION, '--force']);
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
      };
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
      const { cmd: flowCmd, args: flowArgs } = this._flowCmd(['start']);
      const useShell = needsShellOnWin(flowCmd);
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

      let stderr = '';
      let stdout = '';

      child.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        this.log.info(`[flow stdout] ${text.trim()}`);
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        this.log.warn(`[flow stderr] ${text.trim()}`);
      });

      child.on('error', (err) => {
        this.log.error(`[uv] Failed to spawn flow start: ${err.message}`);
      });

      // Wait for the process to exit or give it a short window to fail
      await new Promise((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
          settled = true;
          resolve();
        }, 3000);

        child.once('exit', (code, signal) => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;

          if (code === 0) {
            // flow start completed successfully (spawned monitor and exited)
            resolve();
          } else {
            reject(new Error(
              `flow start exited with code ${code}, signal ${signal}\n` +
              `stdout:\n${stdout.slice(-1000)}\n\nstderr:\n${stderr.slice(-1000)}`
            ));
          }
        });

        child.once('error', (err) => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          reject(err);
        });
      });

      this.log.info('[uv] flow start launched successfully');
    }

  /**
   * Stop the backend: flow stop, then kill all processes on port 9007.
   */
    async stop() {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

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
  async _flowStop() {
    const { cmd, args } = this._flowBin
      ? this._flowCmd(['stop'])
      : { cmd: 'flow', args: ['stop'] };
    try {
      await this._run(cmd, args, { timeout: 10000 });
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
      const { cmd, args } = this._flowCmd(['upgrade', '--info']);
      const { stdout } = await this._run(cmd, args, { timeout: 15000 });
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
    try {
      const res = await fetch(`https://pypi.org/pypi/${PYPI_PACKAGE}/json`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        this.log.warn(`[uv] PyPI version lookup failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      return (data && data.info && data.info.version) || null;
    } catch (err) {
      this.log.warn(`[uv] PyPI version lookup failed: ${err.message}`);
      return null;
    }
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
  async checkForUpdatesInBackground(
    mainWindow,
    { sendStatus, waitForBackend, backendUrl, cloudUrl, beforeBackendStart = false }
  ) {
    try {
      // Pre-start: the backend is down and the install may even be broken, so
      // decide with the standalone PyPI-vs-installed check — no cloud, no CLI,
      // so it behaves the same for healthy, broken, and offline-from-cloud
      // installs (offer the upgrade whenever PyPI is newer). Post-boot: the
      // running backend can answer the cloud `/check-update` policy, so defer
      // to that verdict.
      const status = beforeBackendStart
        ? await this._pypiUpdateStatus()
        : await this.getUpdateStatus(cloudUrl);
      if (!status || !status.required || !status.latestVersion) return false;

      const latest = status.latestVersion;
      this.log.info(`[uv] Update available: ${status.currentVersion || 'unknown'} → ${latest}`);

      if (!mainWindow || mainWindow.isDestroyed()) return false;

      const { response } = await require('electron').dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `A new version of FlowPad is available (${latest}).`,
        detail: status.currentVersion
          ? `You are running version ${status.currentVersion}.`
          : 'Your current installation could not be verified and may be incomplete.',
        buttons: ['Upgrade', 'Later'],
        defaultId: 0,
      });
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
      // a false "failed to start" error.
      if (waitForBackend) await waitForBackend({ maxChecks: 240 });

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
          await require('electron').dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Update failed',
            message: 'FlowPad couldn’t finish updating and couldn’t restart automatically.',
            detail:
              'Please quit and reopen FlowPad. If it keeps happening, run:\n\n' +
              `uv tool install ${PYPI_PACKAGE}@latest --python ${PYTHON_VERSION} --force\n\n` +
              'then reopen FlowPad, or run "flow diagnose".',
            buttons: ['OK'],
            defaultId: 0,
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
      if (waitForBackend) await waitForBackend({ maxChecks: 240 });
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
  async upgrade() {
    this.log.info('[uv] Upgrading flowpad...');
    await this._uvToolInstallForce(['tool', 'install', `${PYPI_PACKAGE}@latest`, '--python', PYTHON_VERSION, '--force']);
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
  async reinstall() {
    this.log.info(`[uv] Repairing ${PYPI_PACKAGE} install (--reinstall --force)...`);
    await this._uvToolInstallForce(['tool', 'install', PYPI_PACKAGE, '--python', PYTHON_VERSION, '--reinstall', '--force']);
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
module.exports.PYTHON_VERSION = PYTHON_VERSION;
// Pure helpers exported for unit testing (electron/uv-manager.test.js).
module.exports.needsShellOnWin = needsShellOnWin;
module.exports.quoteWinCmd = quoteWinCmd;
module.exports.parseNetstatPids = parseNetstatPids;
