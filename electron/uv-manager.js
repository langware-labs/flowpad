const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');

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

// PyPI package name — `uv tool install flowpad`
const PYPI_PACKAGE = 'flowpad';

const API_PREFIX = '/api/v1';

// Keychain SERVICE for the per-instance Fernet key that encrypts the sodot
// file. Owning the read in the signed Electron app (now via the bundled
// flow-rs binary, formerly via keytar) means the OS prompt is attributed
// to Flowpad rather than the bundled, unsigned Python process.
//
// The SERVICE matches flow_sdk/instance_settings/base_settings.py:
// SOD_KEY_KEYCHAIN_SERVICE so both code paths address the same logical
// namespace. The ACCOUNT now diverges intentionally: Electron uses
// `<instance>.flow-rs` (see flow-rs-keychain.js::sodKeyAccount) for
// prompt-free migration from any pre-FLOWPAD-1862 keytar entry at the
// bare-`<instance>` account. Python's fallback in _fetch_or_create_sod_key
// still reads from the bare-`<instance>` slot; in Electron-driven flow
// Python never reaches the fallback because it gets the value via
// SOD_KEY env, so the slot divergence has no functional effect.
const SOD_KEY_KEYCHAIN_SERVICE = 'Flowpad.ai.sod_key';

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
   */
  async _probeFlowBinOnce() {
    if (this._probedShim || !IS_WIN || !this._flowBin) return;
    this._probedShim = true;
    try {
      await this._run(this._flowBin, ['--help'], { timeout: 10000 });
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
   * First-time install: `uv tool install flowpad` (latest from PyPI).
   */
  async installLatest() {
    this.log.info(`[uv] Installing latest ${PYPI_PACKAGE} from PyPI...`);
    await this._uv(['tool', 'install', PYPI_PACKAGE, '--force'], { timeout: 120000 });

    this._flowBin = await this._resolveFlowBin();
    this.log.info(`[uv] ${PYPI_PACKAGE} installed, binary at ${this._flowBin}`);
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
          const match = line.match(/v(\d+\.\d+\.\d+)/);
          if (match) return match[1];
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Compare two semver version strings (major.minor.patch).
   * Returns -1 if a < b, 0 if a == b, 1 if a > b.
   */
  _compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na < nb) return -1;
      if (na > nb) return 1;
    }
    return 0;
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

      // Read the per-instance Fernet key from the OS keychain via the signed
      // Electron app — the prompt is attributed to Flowpad. If present, pass
      // it through as SOD_KEY so Python short-circuits its own keychain
      // access. If missing, the React SecretApprovalDialog will fire on first
      // secret use; Python writes the entry then and the next launch finds it.
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
        env.SOD_KEY = sodKey;
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
        const pids = new Set();
        for (const line of stdout.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[parts.length - 1], 10);
            if (pid > 0) pids.add(pid);
          }
        }
        for (const pid of pids) {
          try {
            await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { timeout: 5000 });
            this.log.info(`[uv] Killed PID ${pid} on port ${port}`);
          } catch { /* ignore */ }
        }
      } else {
        try {
          const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`], { timeout: 5000 });
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

  /**
   * Run a background update check after the UI is loaded.
   * Non-blocking — failures are logged and silently ignored.
   * Shows a native OS dialog if an update is available.
   */
  async checkForUpdatesInBackground(mainWindow, { sendStatus, waitForBackend, backendUrl, cloudUrl }) {
    try {
      const upgradeInfo = await this._getUpgradeInfo();
      if (!upgradeInfo || !upgradeInfo.version) return;

      const res = await fetch(`${cloudUrl}${API_PREFIX}/check-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upgradeInfo),
      });

      if (!res.ok) return;
      const data = await res.json();

      if (data.status !== UpdateStatus.REQUIRED || !data.latest_version) return;

      const latest = data.latest_version;
      this.log.info(`[uv] Update available: ${upgradeInfo.version} → ${latest}`);

      if (!mainWindow || mainWindow.isDestroyed()) return;

      const { response } = await require('electron').dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `A new version of FlowPad is available (${latest}).`,
        detail: `You are running version ${upgradeInfo.version}.`,
        buttons: ['Upgrade', 'Later'],
        defaultId: 0,
      });

      if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
        // User chose Upgrade — show loading screen and wait for it to be ready
        const loadingPath = require('path').join(__dirname, 'loading.html');
        await mainWindow.loadFile(loadingPath);

        // Small delay to ensure the renderer's IPC listener is registered
        await new Promise(r => setTimeout(r, 200));

        if (sendStatus) sendStatus('Stopping server');
        await this.stop();
        this.isShuttingDown = false;

        if (sendStatus) sendStatus('Upgrading Flowpad');
        await this.upgrade();

        if (sendStatus) sendStatus('Starting server');
        await this.start();

        if (sendStatus) sendStatus('Waiting for server');
        if (waitForBackend) await waitForBackend();

        if (mainWindow && !mainWindow.isDestroyed() && backendUrl) {
          mainWindow.loadURL(backendUrl);
        }
      }
    } catch (err) {
      this.log.warn(`[uv] Background update check failed: ${err.message}`);
    }
  }

  /**
   * Upgrade flowpad to the latest version via `uv tool install flowpad@latest`.
   */
  async upgrade() {
    this.log.info('[uv] Upgrading flowpad...');
    await this._uv(['tool', 'install', `${PYPI_PACKAGE}@latest`, '--force'], { timeout: 120000 });
    this._flowBin = await this._resolveFlowBin();
    this.log.info('[uv] Upgrade complete');
  }

  /**
   * Read the per-instance Fernet key from the OS keychain via the bundled
   * `flow-rs` binary (replaces the previous keytar path — see
   * flow_sdk/rust/README.md). Account name mirrors flow_sdk's instance-name
   * resolution (FLOW_INSTANCE, default "prod"). Returns null on miss,
   * flow-rs unavailable, or any error — caller treats that as "no key",
   * and the React SecretApprovalDialog handles first-time approval.
   *
   * Uses getKeyRestricted (modern Keychain API) to match the write path
   * in main.js. ACL is bound to the flow-rs binary's code-signing identity,
   * preserving the previous keytar restrictive posture.
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

module.exports = UvManager;
module.exports.SOD_KEY_KEYCHAIN_SERVICE = SOD_KEY_KEYCHAIN_SERVICE;
