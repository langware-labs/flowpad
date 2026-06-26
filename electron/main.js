const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const log = require('electron-log');
const crypto = require('crypto');
const UvManager = require('./uv-manager');
const { SOD_KEY_KEYCHAIN_SERVICE } = UvManager;
const { isNewer } = require('./semver');

// Register flowpad:// as a custom protocol so the OS routes deep links here.
// Must be called before app.whenReady().
app.setAsDefaultProtocolClient('flowpad');

// Enforce single-instance so Windows/Linux deep links reach the running app
// via the 'second-instance' event rather than spawning a second process.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Configure logging — store all logs under ~/.flow/logs/
const fs = require('fs');
const os = require('os');
const FLOW_HOME = path.join(os.homedir(), '.flow');
const LOGS_BASE = path.join(FLOW_HOME, 'logs');
const MAIN_DESKTOP_LOG_DIR = path.join(LOGS_BASE, 'main_desktop');

function generateTimestampedFilename() {
  const now = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = now.getDate();
  const mon = months[now.getMonth()];
  const year = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${day}${mon}${year}_${hh}_${mm}_${ss}.log`;
}

function cleanupOldLogs(dir, maxAgeDays = 7) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.log'))
    .map(f => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  if (files.length <= 1) return;
  const cutoff = Date.now() - maxAgeDays * 86400000;
  for (const f of files.slice(0, -1)) {  // never delete the newest
    if (f.mtime < cutoff) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
  }
}

function getNewestLogFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.log'))
    .map(f => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0] : null;
}

fs.mkdirSync(MAIN_DESKTOP_LOG_DIR, { recursive: true });
cleanupOldLogs(MAIN_DESKTOP_LOG_DIR);
const MAIN_LOG_PATH = path.join(MAIN_DESKTOP_LOG_DIR, generateTimestampedFilename());
log.transports.file.resolvePathFn = () => MAIN_LOG_PATH;
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.info('Flowpad starting...');

// ----------------------------------------------------------------------------
// Electron desktop wrapper auto-update.
// ----------------------------------------------------------------------------

// Set when a desktop download was started after the user DEFERRED ("Later") —
// suppresses the restart prompt so the update just applies silently on the next
// app quit/restart (autoInstallOnAppQuit). Reset once consumed.
let suppressDesktopRestartPrompt = false;

function setupElectronAutoUpdater() {
  if (!app.isPackaged) {
    log.info('[electron-updater] skipped: app is not packaged');
    return;
  }

  autoUpdater.logger = log;
  // Manual control: we CHECK (no download) at pre-start so a desktop update can
  // be offered together with a backend update in ONE dialog, and only download
  // once the user opts in. Download is triggered explicitly via downloadUpdate().
  autoUpdater.autoDownload = false;
  // A deferred ("Later") desktop download still applies on the next quit/restart
  // without nagging — that's exactly autoInstallOnAppQuit (default true; set
  // explicitly so the intent is clear).
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('[electron-updater] checking for update...');
  });
  autoUpdater.on('update-available', (info) => {
    log.info(`[electron-updater] update available: ${info.version}`);
  });
  autoUpdater.on('update-not-available', (info) => {
    log.info(`[electron-updater] up to date. current=${app.getVersion()} latest=${info && info.version}`);
  });
  autoUpdater.on('download-progress', (p) => {
    log.info(`[electron-updater] download ${Math.round(p.percent)}% (${p.transferred}/${p.total})`);
  });
  autoUpdater.on('error', (err) => {
    log.error('[electron-updater] error:', err);
  });

  // Fires only after an explicit downloadUpdate() completes. Restarting to
  // apply is the one unavoidable step of a desktop self-update, so prompt for it.
  autoUpdater.on('update-downloaded', async (info) => {
    log.info(`[electron-updater] update downloaded: ${info.version}`);
    if (suppressDesktopRestartPrompt) {
      // User deferred earlier — don't nag. autoInstallOnAppQuit applies it on
      // the next quit/restart, so the app comes back on the latest desktop.
      suppressDesktopRestartPrompt = false;
      log.info('[electron-updater] deferred — will install on next quit/restart');
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      log.warn('[electron-updater] mainWindow missing; will install on quit');
      return;
    }
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'FlowPad update ready',
      message: `FlowPad ${info.version} is ready to install.`,
      detail: 'Restart FlowPad now to apply the update.',
    });
    if (result.response === 0) {
      log.info('[electron-updater] user accepted, quitting to install');
      isQuitting = true;
      autoUpdater.quitAndInstall();
    } else {
      log.info('[electron-updater] user deferred install');
    }
  });

  // Long-lived sessions: re-check hourly and, if a newer desktop build appears,
  // download it in the background (the update-downloaded handler then prompts to
  // restart). Launch-time is handled by the pre-start flow, not here.
  const HOUR_MS = 60 * 60 * 1000;
  setInterval(async () => {
    if (await getDesktopUpdateVersion()) downloadDesktopUpdateInBackground();
  }, HOUR_MS);
}

/**
 * Latest desktop build available on the update feed, or null when there's no
 * newer version (or the app is unpackaged / the check failed). Checks WITHOUT
 * downloading (autoDownload is false), so it's safe to await before boot to
 * decide whether to fold the desktop update into the pre-start prompt.
 */
async function getDesktopUpdateVersion() {
  if (!app.isPackaged) return null;
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result && result.updateInfo && result.updateInfo.version;
    if (latest && isNewer(app.getVersion(), latest)) return latest;
  } catch (err) {
    log.warn(`[electron-updater] desktop update check failed: ${err.message}`);
  }
  return null;
}

/**
 * Start downloading the desktop update in the background. Requires a prior
 * getDesktopUpdateVersion() / checkForUpdates() that found an update.
 *
 * promptOnReady=true  → the `update-downloaded` handler offers "Restart now".
 * promptOnReady=false → deferred: no prompt; it applies on the next quit/restart
 *                       (autoInstallOnAppQuit), so the user isn't nagged.
 */
function downloadDesktopUpdateInBackground({ promptOnReady = true } = {}) {
  suppressDesktopRestartPrompt = !promptOnReady;
  autoUpdater.downloadUpdate().catch((err) => {
    log.error('[electron-updater] download failed:', err);
  });
}

// ----------------------------------------------------------------------------
// Desktop wrapper version tracking.
//
// We persist the Electron app version that last ran so the next launch can
// tell whether the user just upgraded to a new desktop build. On an upgrade we
// bring the bundled flowpad (Python) package up to latest so backend and
// wrapper move in lockstep. (getPath('userData') requires app to be ready.)
// ----------------------------------------------------------------------------
function getDesktopVersionStatePath() {
  return path.join(app.getPath('userData'), 'desktop-version.json');
}
function readLastDesktopVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(getDesktopVersionStatePath(), 'utf8'));
    return (data && data.version) || null;
  } catch {
    return null;
  }
}
function writeDesktopVersion(version) {
  try {
    fs.writeFileSync(getDesktopVersionStatePath(), JSON.stringify({ version }), 'utf8');
  } catch (err) {
    log.warn(`[update] failed to persist desktop version: ${err.message}`);
  }
}

// Configuration
const BACKEND_PORT = 9007;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const FLOWPAD_CLOUD_URL = process.env.FLOWPAD_CLOUD_URL || 'https://app.flowpad.ai';
const HEALTH_CHECK_INTERVAL = 500; // ms
const MAX_HEALTH_CHECKS = 180; // 90 seconds — cold-start window
const POST_UPGRADE_HEALTH_CHECKS = 240; // 120 seconds — matches uv upgrade() ceiling

let mainWindow = null;
let uvManager = null;
let isQuitting = false;

// Deep link that arrived before the window was ready to navigate.
let pendingDeepLink = null;

function isStartupOnlyDeepLink(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'flowpad:' && ['__probe', '__launch'].includes((parsed.hostname || '').toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Convert a flowpad:// URL to the equivalent http://localhost:9007 URL and
 * navigate the main window to it.
 *
 * flowpad://task/<id>  →  http://localhost:9007/task/<id>
 */
function handleDeepLink(url) {
  log.info(`[deep-link] received: ${url}`);

  // Ignore install/probe URLs.
  // These are only used by the browser to detect whether FlowPad
  // is installed and must never replace a real task/message deep link.

  if (isStartupOnlyDeepLink(url)) {
    log.info('[deep-link] ignoring startup-only url');
    return;
  }

  try {
    const parsed = new URL(url);
    // host = "task", pathname = "/<id>"  (or just "" for the root)
    const typePart = parsed.hostname || '';
    const idPart = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    const tail = `${parsed.search}${parsed.hash}`;
    const localUrl = typePart ? `${BACKEND_URL}/${typePart}${idPart}${tail}` : `${BACKEND_URL}${tail}`;

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.loadURL(localUrl);
    } else {
      // Window not ready yet — apply after startup completes.
      pendingDeepLink = localUrl;
    }
  } catch (err) {
    log.warn(`[deep-link] failed to parse URL "${url}": ${err}`);
  }
}

// macOS: flowpad:// links arrive here whether the app is running or cold-starting.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Windows / Linux: a second launch passes the URL as a CLI argument.
app.on('second-instance', (_event, argv) => {
  const deepLinkUrl = argv.find(arg => arg.startsWith('flowpad://'));
  if (deepLinkUrl) handleDeepLink(deepLinkUrl);
  // Bring the existing window to the front.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Windows / Linux COLD START: when the OS launches the app via a flowpad://
// URL for the first time, the URL is in process.argv. There's no event for
// this — we have to read it ourselves before app.whenReady fires startApp.
// (On macOS this path is dead — the URL arrives via 'open-url' instead.)
//
// handleDeepLink will see mainWindow === null and stash the URL into
// pendingDeepLink, which startApp consumes after backend warmup.
if (process.platform !== 'darwin') {
  const argvDeepLink = process.argv.find(arg => arg.startsWith('flowpad://'));
  if (argvDeepLink) {
    log.info(`[deep-link] picked up from process.argv: ${argvDeepLink}`);
    handleDeepLink(argvDeepLink);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false, // Don't show until ready
    titleBarStyle: 'default',
    backgroundColor: '#1e1e1e',
  });

  // Mouse back/forward (X1/X2) buttons. Electron does not map these to history
  // navigation, so we wire them up — and the OS surfaces them differently per
  // platform, so we listen per platform (one source each, no double-navigation).
  const nav = () => mainWindow.webContents.navigationHistory;
  const goBack = () => { if (nav().canGoBack()) nav().goBack(); };
  const goForward = () => { if (nav().canGoForward()) nav().goForward(); };

  if (process.platform === 'darwin') {
    // macOS surfaces the buttons two ways and never reaches the renderer:
    //  - a raw mouse `input-event` (button 'back'/'forward'); and
    //  - with drivers like Logitech Options / Options+ (or the trackpad), a
    //    `swipe` GESTURE — left = back, right = forward — and ONLY a swipe, no
    //    mouse button / app-command (confirmed by event capture). Handle both.
    mainWindow.webContents.on('input-event', (_e, input) => {
      if (input.type !== 'mouseDown') return;
      if (input.button === 'back') goBack();
      else if (input.button === 'forward') goForward();
    });
    mainWindow.on('swipe', (_e, direction) => {
      if (direction === 'left') goBack();
      else if (direction === 'right') goForward();
    });
  } else {
    // Windows/Linux: the buttons arrive as an app-command.
    mainWindow.webContents.on('app-command', (_e, command) => {
      if (command === 'browser-backward') goBack();
      else if (command === 'browser-forward') goForward();
    });
  }

  // Show loading screen first
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in the system browser instead of the Electron window.
  // Carve-out (docs/tab-management.md Part 3 §7): same-origin `/win/` focus
  // windows (navigation.openDockInWindow) are legit in-app destinations —
  // allow them so Electron opens an in-app BrowserWindow. No teardown
  // handlers on those windows: close relies on disconnect-driven PTY detach.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BACKEND_URL)) {
      try {
        if (new URL(url).pathname.includes('/win/')) {
          return { action: 'allow' };
        }
      } catch {
        // Unparseable URL — fall through to the deny path below.
      }
    }
    if (/^https?:\/\//.test(url)) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation to the backend (same-origin), block everything else.
    // Same-origin /win/ URLs are covered by this allow — they are in-app
    // destinations, consistent with the window-open carve-out above.
    if (!url.startsWith(BACKEND_URL)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) {
        require('electron').shell.openExternal(url);
      }
    }
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

async function waitForBackend({ maxChecks = MAX_HEALTH_CHECKS } = {}) {
  const timeoutSec = Math.round((maxChecks * HEALTH_CHECK_INTERVAL) / 1000);
  log.info(`Waiting for backend at ${BACKEND_URL} (up to ${timeoutSec}s)...`);

  for (let i = 0; i < maxChecks; i++) {
    try {
      const response = await fetch(`${BACKEND_URL}/health/status`);
      if (response.ok) {
        log.info('Backend is ready!');
        return true;
      }
    } catch (error) {
      // Backend not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL));
  }

  log.error(`Backend failed to start within ${timeoutSec}s timeout`);
  return false;
}

function sendStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('startup-status', message);
  }
}

async function startApp() {
  // Kick off the desktop wrapper update check immediately at launch — runs in
  // parallel with backend startup and is a no-op when the app isn't packaged.
  setupElectronAutoUpdater();

  createWindow();

  // Wait for the loading page to finish loading so IPC listeners are ready
  if (mainWindow.webContents.isLoading()) {
    await new Promise((resolve) => mainWindow.webContents.once('did-finish-load', resolve));
  }

  // In development mode, assume backend is running externally
  const isDev = process.env.MINIHUB_DEV === 'true';

  let backendJustUpgraded = false;

  if (isDev) {
    log.info('Development mode: expecting backend to be running externally');
  } else {
    // Install and start backend via uv + flow CLI
    uvManager = new UvManager(log);

    // Did the user just upgrade to a new desktop build? Logged for diagnostics
    // only — the pre-start update prompt below decides (and asks) whether to
    // bring the flowpad backend up to match; we don't silently auto-upgrade.
    const lastDesktopVersion = readLastDesktopVersion();
    const desktopUpgraded =
      app.isPackaged && lastDesktopVersion && lastDesktopVersion !== app.getVersion();
    if (desktopUpgraded) {
      log.info(`[update] desktop upgraded ${lastDesktopVersion} → ${app.getVersion()}`);
    }

    try {
      // FAST PATH: check if flow binary exists on disk (no subprocess, just fs.existsSync)
      const flowBin = uvManager.getInstalledFlowBin();

      if (flowBin) {
        log.info(`Fast path: flow binary found at ${flowBin}`);

        // ── Pre-start updates: desktop + backend, asked ONCE ───────────────
        // Two independent channels: the desktop wrapper (electron-updater /
        // GitHub) and the flowpad backend (PyPI). We check the desktop FIRST,
        // without downloading, so that when BOTH have a newer version we show a
        // single consolidated dialog instead of two. The backend is applied
        // immediately (fast, local); the desktop downloads in the background and
        // prompts to restart when ready. We never silently auto-upgrade — the
        // dialog is the one decision point, so the user stays in control.
        let activeBin = flowBin;
        const desktopLatest = await getDesktopUpdateVersion();

        if (desktopLatest) {
          // Only consolidate when the backend ALSO has an update; otherwise keep
          // the desktop channel's own background-download + restart-prompt flow.
          const backendStatus = await uvManager._pypiUpdateStatus();
          if (backendStatus) {
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Updates available',
              message: 'New versions of FlowPad are available.',
              detail:
                `Desktop app: ${app.getVersion()} → ${desktopLatest}\n` +
                `FlowPad engine: ${backendStatus.currentVersion || 'unknown'} → ${backendStatus.latestVersion}`,
              buttons: ['Update', 'Later'],
              defaultId: 0,
              cancelId: 1,
            });
            if (response === 0) {
              // Backend first (quick) so the about-to-restart desktop boots
              // paired with the new engine; the desktop downloads in the
              // background and prompts to restart once ready.
              const loadingPath = path.join(__dirname, 'loading.html');
              await mainWindow.loadFile(loadingPath);
              sendStatus('Upgrading Flowpad');
              await uvManager.upgrade();
              activeBin = uvManager.getInstalledFlowBin() || flowBin;
              backendJustUpgraded = true;
              downloadDesktopUpdateInBackground();
            } else {
              // Later: still pre-download the desktop in the background so the
              // next restart comes back on the latest — but don't nag (it
              // auto-installs on quit). The backend stays as-is (deferred).
              downloadDesktopUpdateInBackground({ promptOnReady: false });
            }
          } else {
            // Desktop only → background download + restart prompt (unchanged UX).
            downloadDesktopUpdateInBackground();
          }
        } else {
          // No desktop update → the standalone backend prompt handles the
          // "newer on PyPI" case (and no-ops otherwise). Reads the installed
          // version from `_version.py`, so it works even when the install is
          // broken or the cloud is unreachable. `beforeBackendStart` makes the
          // call return right after the upgrade — the normal start path below
          // boots the upgraded backend, avoiding a double start + early UI load.
          const upgradedPreStart = await uvManager.checkForUpdatesInBackground(mainWindow, {
            sendStatus,
            waitForBackend,
            backendUrl: BACKEND_URL,
            cloudUrl: FLOWPAD_CLOUD_URL,
            beforeBackendStart: true,
          });
          if (upgradedPreStart) {
            activeBin = uvManager.getInstalledFlowBin() || activeBin;
            backendJustUpgraded = true;
          }
        }

        const version = uvManager.getInstalledVersionSync(activeBin);
        const versionSuffix = version ? ` v${version}` : '';
        sendStatus(`Starting flowpad${versionSuffix}`);
        try {
          await uvManager.startWithBin(activeBin);
        } catch (startErr) {
          // A shim exists on disk (so we took the fast path), but its env can't
          // import flow_sdk — a corrupt/half-finished install. Without this the
          // app would crash on the same broken shim every launch and never
          // self-heal (a --force reinstall only runs in the first-time branch).
          // Repair once and retry; if it still fails, fall through to the dialog.
          if (!uvManager.isBrokenInstallError(startErr)) throw startErr;
          log.warn('Detected broken flow install (cannot import flow_sdk); reinstalling…');
          sendStatus('Repairing Flowpad installation');
          await uvManager.ensureUv();
          await uvManager.reinstall();
          backendJustUpgraded = true;
          const repairedVersion = uvManager.getInstalledVersionSync();
          sendStatus(`Starting flowpad${repairedVersion ? ` v${repairedVersion}` : ''}`);
          await uvManager.start();
        }
      } else {
        // FIRST-TIME SETUP: uv tool install flowpad (latest)
        log.info('First-time setup: flow binary not found, installing latest from PyPI');
        sendStatus('Setting up Flowpad (first time)');

        sendStatus('Checking Python installation');
        await uvManager.ensureUv();

        sendStatus('Installing Flowpad');
        await uvManager.installLatest();
        backendJustUpgraded = true;

        const version = uvManager.getInstalledVersionSync();
        const versionSuffix = version ? ` v${version}` : '';
        sendStatus(`Starting flowpad${versionSuffix}`);
        await uvManager.start();
      }
    } catch (error) {
      log.error('Failed to start Python backend:', error);

      const details = [
        error?.message || String(error),
        `HOME=${process.env.HOME || ''}`,
        `cwd=${os.homedir()}`,
        `flowBin=${uvManager?._flowBin || ''}`,
        `PATH=${(process.env.PATH || '').slice(0, 500)}`
      ];

      if (error?.stderr) details.push(`stderr=${error.stderr.toString().slice(-500)}`);
      if (error?.stdout) details.push(`stdout=${error.stdout.toString().slice(-500)}`);

      const detailText = details.join('\n');
      log.error(`[startup error details]\n${detailText}`);

      dialog.showErrorBox(
        'Startup Error',
        `Failed to start the Python backend:\n\n${detailText}`
      );
      app.quit();
      return;
    }
  }

  // Wait for backend to be ready. After an install/upgrade the freshly
  // unpacked Python env takes substantially longer to import on first boot
  // (PyPI fetch + bytecode warm-up + AV scan on Windows), so widen the
  // window when we know we just ran uv install/upgrade.
  sendStatus('Waiting for server');
  const waitOpts = backendJustUpgraded ? { maxChecks: POST_UPGRADE_HEALTH_CHECKS } : undefined;
  const backendReady = await waitForBackend(waitOpts);

  if (!backendReady) {
    // Try to gather diagnostics for the error dialog
    const timeoutSec = Math.round(
      ((backendJustUpgraded ? POST_UPGRADE_HEALTH_CHECKS : MAX_HEALTH_CHECKS) *
        HEALTH_CHECK_INTERVAL) / 1000,
    );
    let detail = `Backend server failed to respond within ${timeoutSec} seconds.`;
    try {
      const newest = getNewestLogFile(path.join(LOGS_BASE, 'monitor'));
      if (newest) {
        const logContent = fs.readFileSync(newest.path, 'utf8');
        const lastLines = logContent.split('\n').slice(-15).join('\n');
        detail += `\n\nMonitor log (${newest.path}):\n${lastLines}`;
      } else {
        detail += '\n\nNo monitor log found.';
      }
    } catch {
      detail += '\n\nNo monitor log found.';
    }
    log.error(detail);
    dialog.showErrorBox('Startup Error', detail);
    app.quit();
    return;
  }

  // Backend is up — record this desktop version as the baseline so the next
  // launch can detect a wrapper upgrade and re-sync the flowpad package.
  if (app.isPackaged) {
    writeDesktopVersion(app.getVersion());
  }

  // Load the main UI (or a pending deep-link target if one arrived during startup).
  const startUrl = pendingDeepLink || BACKEND_URL;
  pendingDeepLink = null;
  log.info(`Loading UI from ${startUrl}`);
  mainWindow.loadURL(startUrl);

  // Open DevTools in development
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Background update check (non-blocking, after UI is loaded)
  if (!uvManager) {
    uvManager = new UvManager(log);
    try {
      uvManager._flowBin = await uvManager._resolveFlowBin();
    } catch {
      uvManager._flowBin = 'flow';
    }
  }
  uvManager.checkForUpdatesInBackground(mainWindow, {
    sendStatus,
    waitForBackend,
    backendUrl: BACKEND_URL,
    cloudUrl: FLOWPAD_CLOUD_URL,
  });
}
// App lifecycle events
app.whenReady().then(startApp);

app.on('window-all-closed', () => {
  log.info('All windows closed');
  app.quit();
});

app.on('activate', () => {
  // On macOS, recreate window when dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    startApp();
  }
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;

  log.info('Quitting — stopping backend...');

  // Hide window immediately so the user sees instant close
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }

  if (uvManager) {
    event.preventDefault();

    const forceQuitTimer = setTimeout(() => {
      log.warn('Force quitting after timeout');
      app.exit(0);
    }, 1000);

    // Graceful shutdown: flow stop, then kill any remaining processes on port
    uvManager.stop().finally(() => {
      clearTimeout(forceQuitTimer);
      app.exit(0);
    });
  }
});

// IPC handlers for renderer communication
ipcMain.handle('get-backend-url', () => BACKEND_URL);

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-startup-logs', () => {
  const logs = [];

  // Electron log (newest in main_desktop/)
  try {
    const newest = getNewestLogFile(path.join(LOGS_BASE, 'main_desktop'));
    if (newest) {
      const content = fs.readFileSync(newest.path, 'utf8');
      logs.push({ name: 'Electron', path: newest.path, content });
    }
  } catch { /* ignore */ }

  // Monitor log (newest in monitor/)
  try {
    const newest = getNewestLogFile(path.join(LOGS_BASE, 'monitor'));
    if (newest) {
      const content = fs.readFileSync(newest.path, 'utf8');
      logs.push({ name: 'Monitor', path: newest.path, content });
    }
  } catch { /* ignore */ }

  // Server log (newest in server/)
  try {
    const newest = getNewestLogFile(path.join(LOGS_BASE, 'server'));
    if (newest) {
      const content = fs.readFileSync(newest.path, 'utf8');
      logs.push({ name: 'Server', path: newest.path, content });
    }
  } catch { /* ignore */ }

  return logs;
});

// ---------------------------------------------------------------------------
// Live log tailing — pushes new log lines to the renderer every second
// ---------------------------------------------------------------------------
let _logWatchInterval = null;
const _logFileOffsets = {};  // { filePath: bytesReadSoFar }

function _getLogFiles() {
  const files = [];

  // Re-discover newest file in each subdirectory on every tick
  const subdirs = [
    { name: 'Electron', dir: 'main_desktop' },
    { name: 'Monitor', dir: 'monitor' },
    { name: 'Server', dir: 'server' },
  ];

  for (const { name, dir } of subdirs) {
    const newest = getNewestLogFile(path.join(LOGS_BASE, dir));
    if (newest) {
      files.push({ name, path: newest.path });
    }
  }

  return files;
}

function _readNewContent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const prev = _logFileOffsets[filePath] || 0;

    // File was truncated / rotated — reset
    if (stat.size < prev) {
      _logFileOffsets[filePath] = 0;
    }

    const offset = _logFileOffsets[filePath] || 0;
    if (stat.size <= offset) return '';

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);

    _logFileOffsets[filePath] = stat.size;
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

ipcMain.on('watch-startup-logs', (event) => {
  // Initialise offsets to current file sizes so we only stream NEW content
  const initialFiles = _getLogFiles();
  for (const f of initialFiles) {
    try {
      _logFileOffsets[f.path] = fs.statSync(f.path).size;
    } catch {
      _logFileOffsets[f.path] = 0;
    }
  }

  if (_logWatchInterval) clearInterval(_logWatchInterval);

  _logWatchInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(_logWatchInterval);
      _logWatchInterval = null;
      return;
    }
    // Re-discover log files each tick — server.log / monitor.log may appear later
    const logFiles = _getLogFiles();
    const updates = [];
    for (const f of logFiles) {
      // First time seeing this file — start tailing from current position
      if (_logFileOffsets[f.path] === undefined) {
        try {
          _logFileOffsets[f.path] = fs.statSync(f.path).size;
        } catch {
          _logFileOffsets[f.path] = 0;
        }
      }
      const newContent = _readNewContent(f.path);
      if (newContent) {
        updates.push({ name: f.name, content: newContent });
      }
    }
    if (updates.length) {
      mainWindow.webContents.send('startup-logs-update', updates);
    }
  }, 1000);
});

ipcMain.on('unwatch-startup-logs', () => {
  if (_logWatchInterval) {
    clearInterval(_logWatchInterval);
    _logWatchInterval = null;
  }
});

ipcMain.handle('restart-backend', async () => {
  if (uvManager) {
    await uvManager.restart();
    return waitForBackend();
  }
  return false;
});

ipcMain.handle('upgrade-flowpad', async () => {
  if (!uvManager) return { success: false, error: 'No uv manager' };
  try {
    // Show loading screen
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadFile(path.join(__dirname, 'loading.html'));
      await new Promise(r => setTimeout(r, 200));
    }

    sendStatus('Stopping server');
    await uvManager._flowStop();
    await uvManager._killPort(9007);
    uvManager.isShuttingDown = false;
    uvManager._backendProcess = null;

    sendStatus('Upgrading Flowpad');
    await uvManager.upgrade();

    sendStatus('Starting server');
    await uvManager.start();

    sendStatus('Waiting for server');
    const ready = await waitForBackend({ maxChecks: POST_UPGRADE_HEALTH_CHECKS });

    if (ready && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(BACKEND_URL);
    }

    return { success: ready };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Provision the per-instance Fernet sod-key in the OS keychain via the
 * bundled signed flow-rs binary. Returning the value here lets the
 * renderer hand it to Python via the /secrets/seed-key endpoint, so
 * Python never makes a keyring write of its own — keeping the keychain
 * ACL trust list flow-rs-only (no python3.x ownership).
 *
 * Two modes:
 *   * No argument: mint a fresh Fernet key (32 random bytes, url-safe
 *     base64). Used in fresh-install + SecretApprovalDialog approval.
 *   * `existingValue` supplied: write the supplied value verbatim.
 *     Used by the one-shot legacy migration flow — backend reads the
 *     legacy python3.x-owned key (which still decrypts the existing
 *     sodot) and hands it here so flow-rs can re-write it at the
 *     `.flow-rs` slot, preserving the user's secrets.
 *
 * Idempotent: if an entry already exists at the flow-rs slot, returns
 * it unchanged (skips both mint AND re-write).
 */
ipcMain.handle('secrets:provision-sod-key', async (_event, existingValue) => {
  let flowRs;
  try {
    flowRs = require('./flow-rs-keychain');
  } catch (err) {
    log.error(`[secrets] flow-rs-keychain not available: ${err.message}`);
    throw new Error('flow-rs-keychain unavailable');
  }
  const account = flowRs.sodKeyAccount();
  try {
    const existing = await flowRs.getKeyRestricted(SOD_KEY_KEYCHAIN_SERVICE, account);
    if (existing) {
      log.info(`[secrets] sod_key already present in keychain (${account}); returning existing`);
      return existing;
    }
  } catch (err) {
    log.warn(`[secrets] keychain probe failed (${err.message}); minting/migrating fresh`);
  }
  let key;
  if (typeof existingValue === 'string' && existingValue.length > 0) {
    key = existingValue;
    log.info(`[secrets] migrating supplied legacy sod_key to keychain (${account}) via flow-rs`);
  } else {
    // Fernet key: 32 random bytes, url-safe base64 with padding.
    key = crypto.randomBytes(32).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_');
    log.info(`[secrets] minted fresh sod_key for keychain (${account})`);
  }
  await flowRs.setKeyRestricted(SOD_KEY_KEYCHAIN_SERVICE, account, key);
  log.info(`[secrets] wrote sod_key to keychain (${account})`);
  return key;
});

ipcMain.handle('open-external', async (_, url) => {
  const { shell } = require('electron');
  log.info(`[open-external] requested: ${url}`);
  // Only allow http/https URLs for security
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  log.warn(`[open-external] blocked non-http URL: ${url}`);
  return false;
});
