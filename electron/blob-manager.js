// ============================================================================
// DRAFT — NOT TESTED IN ELECTRON. For review. Wire in behind FLOWPAD_USE_BLOB=1.
// ============================================================================
// BlobManager: drop-in alternative to UvManager. Delivers the flowpad backend as
// a PyInstaller-frozen blob (downloaded from a GitHub release) instead of
// `uv tool install flowpad@latest`. ~2,800 files vs ~12,200 → ~4x faster
// write+scan on Windows (Defender per-file tax).
//
// Versioned dirs + atomic `current` pointer: upgrades write a NEW dir and flip a
// pointer, never overwriting the running exe → the Windows file-lock problem
// (uv-manager's --force + lock-retry) cannot occur. Old version kept for rollback.
//
// Interface parity: implements every uvManager.* method main.js calls. The env
// block, _enrichedPath and _loadSodKey are copied from UvManager verbatim so the
// backend starts with an identical environment. NOTE(review): extract those into
// a shared electron/backend-env.js so the two managers can't drift.
// ============================================================================

const { spawn, execFile } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PATH_SEP = IS_WIN ? ';' : ':';
const SOD_KEY_KEYCHAIN_SERVICE = 'Flowpad.ai.sod_key';   // must match uv-manager

const RELEASE_REPO = 'langware-labs/flowpad';
const PLATFORM_TAG = IS_WIN ? 'win-x64' : (IS_MAC ? 'mac-arm64' : 'linux-x64');
const EXE_NAME = IS_WIN ? 'flowpad-backend.exe' : 'flowpad-backend';
const BACKEND_PORT = '9007';

class BlobManager {
  constructor(log) {
    this.log = log;
    this.root = path.join(os.homedir(), '.flow', 'backend');
    this._backendProcess = null;
    this.isShuttingDown = false;
    this._flowBin = null;               // parity: main.js reads uvManager._flowBin
  }

  /**
   * Path to the frozen backend BUNDLED inside the installer via electron-builder
   * extraResources (resources/flowpad-backend), or null if not bundled. When
   * present, install is a local copy from the signed installer — no download,
   * and the files inherit the installer's Mark-of-the-Web. Only meaningful in a
   * packaged app (process.resourcesPath is undefined in dev).
   */
  static bundledBlobPath() {
    const rp = process.resourcesPath;
    if (!rp) return null;
    const p = path.join(rp, 'flowpad-backend');
    return fs.existsSync(path.join(p, EXE_NAME)) ? p : null;
  }

  // ---- version / install-state (no subprocess) ------------------------------

  _versionsDir() { return path.join(this.root, 'versions'); }
  _currentFile() { return path.join(this.root, 'current'); }
  _versionDir(v) { return path.join(this._versionsDir(), v); }
  _exeFor(v) { return path.join(this._versionDir(v), 'flowpad-backend', EXE_NAME); }

  currentVersion() {
    try { return fs.readFileSync(this._currentFile(), 'utf8').trim() || null; } catch { return null; }
  }

  getInstalledFlowBin() {
    // A downloaded/upgraded version (versions/ + current pointer) wins.
    const v = this.currentVersion();
    if (v) {
      const exe = this._exeFor(v);
      if (fs.existsSync(exe)) { this._flowBin = exe; return exe; }
    }
    // Else, if the installer bundled a blob, run it IN PLACE — no copy. This
    // avoids a whole class of stale-cache bugs (a cached copy never refreshing)
    // and keeps the backend in lockstep with the installed app version.
    const bundled = BlobManager.bundledBlobPath();
    if (bundled) {
      const exe = path.join(bundled, EXE_NAME);
      if (fs.existsSync(exe)) { this._flowBin = exe; return exe; }
    }
    return null;
  }

  getInstalledVersionSync() { return this.currentVersion(); }

  async _resolveFlowBin() { return this.getInstalledFlowBin() || EXE_NAME; }

  // A frozen exe either runs or doesn't — there is no "installed but can't import"
  // half-state that uv-manager's --reinstall heals, so this is always false.
  isBrokenInstallError() { return false; }

  // uv is not used by the blob path.
  async ensureUv() { /* no-op */ }

  // ---- update check (GitHub releases replaces the PyPI check) ---------------

  async checkLatest() {
    // LOCAL-SOURCE mode (FLOWPAD_BLOB_LOCAL): no network — lets the full path be
    // tested off a local blob without publishing a release. Removable: unset the
    // env var and the GitHub path below is used unchanged.
    // FLOWPAD_BLOB_LOCAL = install from a local path; FLOWPAD_BLOB_URL = download
    // from an arbitrary host (S3/gist/file-share/ngrok) — both skip the GitHub
    // API and let you run the REAL download+install flow off any private URL,
    // no publishing required. Removable: unset the env and GitHub is used.
    if (process.env.FLOWPAD_BLOB_LOCAL || process.env.FLOWPAD_BLOB_URL) {
      return process.env.FLOWPAD_BLOB_VERSION || '0.0.0-local';
    }
    // Bundled-in-installer: the engine ships WITH the desktop app and runs in
    // place, so engine updates ride the desktop app update (electron-updater) —
    // there's no separate blob "latest" to poll here.
    if (BlobManager.bundledBlobPath()) return null;
    try {
      const j = await this._getJson(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`);
      return (j.tag_name || '').replace(/^v/, '') || null;
    } catch (err) { this.log.warn(`[blob] update check failed: ${err.message}`); return null; }
  }

  // parity: main.js calls uvManager._pypiUpdateStatus()
  async _pypiUpdateStatus() {
    const latest = await this.checkLatest();
    const current = this.currentVersion();
    if (latest && latest !== current) return { currentVersion: current, latestVersion: latest };
    return null;
  }

  /**
   * parity with UvManager.checkForUpdatesInBackground(mainWindow, opts).
   * When beforeBackendStart is set and an update exists, upgrade in place and
   * return true so main.js's normal start path boots the new version.
   */
  async checkForUpdatesInBackground(mainWindow, opts = {}) {
    const status = await this._pypiUpdateStatus();
    if (!status) return false;
    if (opts.beforeBackendStart) {
      if (opts.sendStatus) opts.sendStatus('Upgrading Flowpad');
      await this.upgrade();
      return true;
    }
    // Post-start: main.js already shows its own update prompt for the standalone
    // case; leaving the download to the same upgrade() keeps one code path.
    return false;
  }

  // ---- install / upgrade ----------------------------------------------------

  async installLatest() {
    const latest = await this.checkLatest();
    if (!latest) throw new Error('[blob] could not resolve latest backend version');
    await this._installVersion(latest);
  }

  async reinstall() { return this.installLatest(); }   // parity: re-download fresh

  async upgrade() {
    const latest = await this.checkLatest();
    if (!latest) throw new Error('[blob] could not resolve latest backend version');
    if (latest === this.currentVersion()) { this.log.info('[blob] already latest'); return; }
    await this.stop();
    await this._installVersion(latest);
    this._pruneOldVersions(latest);
  }

  async _installVersion(version) {
    const dest = this._versionDir(version);
    fs.mkdirSync(this._versionsDir(), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const bundled = BlobManager.bundledBlobPath();
    const local = process.env.FLOWPAD_BLOB_LOCAL || bundled;
    if (local) {
      // LOCAL-SOURCE: install from a local onedir folder or .zip (no network).
      // `bundled` is the frozen backend shipped INSIDE the signed installer via
      // electron-builder extraResources — a self-contained install, no download.
      this.log.info(`[blob] installing from local source ${local}`);
      if (local.toLowerCase().endsWith('.zip')) await this._extractZip(local, dest);
      else fs.cpSync(local, path.join(dest, 'flowpad-backend'), { recursive: true });
    } else {
      // FLOWPAD_BLOB_URL overrides the GitHub URL → download the REAL blob from
      // any private host (for real-time testing without publishing to GitHub).
      const url = process.env.FLOWPAD_BLOB_URL
        || `https://github.com/${RELEASE_REPO}/releases/download/v${version}/flowpad-backend-${version}-${PLATFORM_TAG}.zip`;
      const zipPath = path.join(this.root, `download-${version}.zip`);
      this.log.info(`[blob] downloading ${url}`);
      await this._download(url, zipPath);
      // TODO(review): verify published SHA256 + Authenticode-verify the exe BEFORE trusting it.
      await this._extractZip(zipPath, dest);
      fs.rmSync(zipPath, { force: true });
    }
    if (!fs.existsSync(this._exeFor(version))) throw new Error(`[blob] install missing ${EXE_NAME}`);
    const tmp = this._currentFile() + '.tmp';
    fs.writeFileSync(tmp, version, 'utf8');
    fs.renameSync(tmp, this._currentFile());   // atomic pointer flip
    this._flowBin = this._exeFor(version);
    this.log.info(`[blob] current -> ${version}`);
  }

  _pruneOldVersions(keep) {
    try {
      const others = fs.readdirSync(this._versionsDir()).filter((d) => d !== keep).sort();
      for (const d of others.slice(0, -1)) fs.rmSync(this._versionDir(d), { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  // ---- start / stop / restart ----------------------------------------------

  async startWithBin(exe) { this._flowBin = exe; return this.start(); }

  async start() {
    const exe = this._flowBin || this.getInstalledFlowBin();
    if (!exe) throw new Error('[blob] no installed backend to start');
    this.isShuttingDown = false;
    // Ensure the cwd exists — when running the BUNDLED blob in place we never
    // create this.root via an install, so a fresh machine has no ~/.flow/backend
    // and spawn() would throw ENOENT on the missing cwd.
    fs.mkdirSync(this.root, { recursive: true });
    const env = await this._buildEnv();
    this.log.info('[blob] starting backend via frozen exe: <exe> start');
    const child = spawn(exe, ['start'], {
      env, cwd: this.root, detached: false,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    this._backendProcess = child;
    child.stdout.on('data', (d) => this.log.info(`[flow stdout] ${d.toString().trim()}`));
    child.stderr.on('data', (d) => this.log.warn(`[flow stderr] ${d.toString().trim()}`));
    // `<exe> start` spawns the detached monitor and returns; readiness is polled
    // by main.js waitForBackend() exactly as today.
  }

  async restart() { await this.stop(); return this.start(); }

  async _flowStop() {
    const exe = this.getInstalledFlowBin();
    if (exe) { try { await this._run(exe, ['stop'], 10000); } catch { /* fall through */ } }
  }

  async _killPort(/* port */) {
    if (IS_WIN) { try { await this._run('taskkill', ['/IM', EXE_NAME, '/F', '/T'], 10000); } catch { /* ignore */ } }
    // Unix: killed by name via stop(); a port-specific kill can be added if needed.
  }

  async stop() {
    this.isShuttingDown = true;
    await this._flowStop();
    await this._killPort(BACKEND_PORT);
    this._backendProcess = null;
  }

  getServerInfo() {
    try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.flow', 'instances', 'prod', 'server.json'), 'utf8')); }
    catch { return {}; }
  }

  // ---- env (copied from UvManager so the backend starts identically) --------

  async _buildEnv() {
    const sodKey = await this._loadSodKey();
    const env = {
      ...process.env,
      PATH: this._enrichedPath(),
      DEPLOY_ENV: 'desktop',
      MINIHUB_HOST: '127.0.0.1',
      // Desktop always uses 9007; an explicit LOCAL_SERVER_PORT override is
      // honored (used for isolated local testing).
      LOCAL_SERVER_PORT: process.env.LOCAL_SERVER_PORT || BACKEND_PORT,
      MINIHUB_RELOAD: 'false',
      FLOWPAD_NO_BROWSER: '1',
      FLOWPAD_DESKTOP: '1',
    };
    if (sodKey) env.SOD_ENC_KEY = sodKey;   // Python short-circuits keychain access
    if (IS_WIN) {
      env.USERPROFILE = env.USERPROFILE || os.homedir();
    } else {
      env.HOME = os.homedir();
      env.USER = process.env.USER || process.env.LOGNAME || '';
      env.LOGNAME = process.env.LOGNAME || process.env.USER || '';
      env.SHELL = process.env.SHELL || '/bin/bash';
      env.LANG = process.env.LANG || 'en_US.UTF-8';
    }
    return env;
  }

  _enrichedPath() {
    const home = os.homedir();
    const extra = [];
    if (IS_WIN) {
      extra.push(path.join(home, '.local', 'bin'));
      extra.push(path.join(home, '.cargo', 'bin'));
      for (let m = 10; m <= 14; m++) extra.push(path.join(home, 'AppData', 'Roaming', 'Python', `Python3${m}`, 'Scripts'));
      const lp = path.join(home, 'AppData', 'Local', 'Programs', 'Python');
      for (let m = 10; m <= 14; m++) { const d = path.join(lp, `Python3${m}`); extra.push(d, path.join(d, 'Scripts')); }
      extra.push(path.join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps'));
    } else {
      extra.push(path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'));
      if (IS_MAC) {
        extra.push('/opt/homebrew/bin', '/usr/local/bin');
        for (let m = 10; m <= 14; m++) extra.push(`/Library/Frameworks/Python.framework/Versions/3.${m}/bin`);
      } else { extra.push('/usr/local/bin', '/usr/bin', '/snap/bin'); }
    }
    return [...extra, process.env.PATH || ''].join(PATH_SEP);
  }

  async _loadSodKey() {
    let flowRs;
    try { flowRs = require('./flow-rs-keychain'); }
    catch (err) { this.log.warn(`[blob] flow-rs-keychain not available: ${err.message}`); return null; }
    const account = flowRs.sodKeyAccount();
    try {
      const key = await flowRs.getKeyRestricted(SOD_KEY_KEYCHAIN_SERVICE, account);
      if (key) { this.log.info(`[blob] Loaded Flowpad sod_key from keychain (${account})`); return key; }
    } catch (err) { this.log.warn(`[blob] keychain read failed: ${err.message}`); }
    this.log.info('[blob] No sod_key in keychain — SecretApprovalDialog will fire on first secret use');
    return null;
  }

  // ---- net / extract helpers ------------------------------------------------

  _getJson(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'flowpad-desktop' } }, (res) => {
        if (res.statusCode >= 300 && res.headers.location) return this._getJson(res.headers.location).then(resolve, reject);
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
  }

  _download(url, dest) {
    const mod = url.startsWith('http://') ? require('http') : https;
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      mod.get(url, { headers: { 'User-Agent': 'flowpad-desktop' } }, (res) => {
        if (res.statusCode >= 300 && res.headers.location) { file.close(); return this._download(res.headers.location, dest).then(resolve, reject); }
        if (res.statusCode !== 200) { file.close(); return reject(new Error(`download ${res.statusCode}`)); }
        res.pipe(file); file.on('finish', () => file.close(resolve));
      }).on('error', (e) => { file.close(); reject(e); });
    });
  }

  _extractZip(zip, dest) {
    // PowerShell Expand-Archive is slow for many files — bundle a fast extractor (7za) in production.
    if (IS_WIN) return this._run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${dest}' -Force`], 300000);
    return this._run('unzip', ['-q', zip, '-d', dest], 300000);
  }

  _run(cmd, args, timeout) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { windowsHide: true });
      const t = setTimeout(() => { p.kill(); reject(new Error(`${cmd} timeout`)); }, timeout);
      let err = ''; if (p.stderr) p.stderr.on('data', (d) => (err += d));
      p.on('close', (c) => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(`${cmd} exit ${c}: ${err}`)); });
      p.on('error', (e) => { clearTimeout(t); reject(e); });
    });
  }
}

module.exports = BlobManager;
