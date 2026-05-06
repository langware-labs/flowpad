const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const log = require('electron-log');
const UvManager = require('./uv-manager');

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

// Configuration
const BACKEND_PORT = 9007;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const FLOWPAD_CLOUD_URL = process.env.FLOWPAD_CLOUD_URL || 'http://localhost:5173';
const HEALTH_CHECK_INTERVAL = 500; // ms
const MAX_HEALTH_CHECKS = 60; // 30 seconds max wait

let mainWindow = null;
let uvManager = null;

// Deep link that arrived before the window was ready to navigate.
let pendingDeepLink = null;

/**
 * Convert a flowpad:// URL to the equivalent http://localhost:9007 URL and
 * navigate the main window to it.
 *
 * flowpad://task/<id>  →  http://localhost:9007/task/<id>
 */
function handleDeepLink(url) {
  log.info(`[deep-link] received: ${url}`);
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

  // Show loading screen first
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in the system browser instead of the Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation to the backend (same-origin), block everything else
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

async function waitForBackend() {
  log.info(`Waiting for backend at ${BACKEND_URL}...`);

  for (let i = 0; i < MAX_HEALTH_CHECKS; i++) {
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

  log.error('Backend failed to start within timeout');
  return false;
}

function sendStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('startup-status', message);
  }
}

async function startApp() {
  createWindow();

  // Wait for the loading page to finish loading so IPC listeners are ready
  if (mainWindow.webContents.isLoading()) {
    await new Promise((resolve) => mainWindow.webContents.once('did-finish-load', resolve));
  }

  // In development mode, assume backend is running externally
  const isDev = process.env.MINIHUB_DEV === 'true';

  if (isDev) {
    log.info('Development mode: expecting backend to be running externally');
  } else {
    // Install and start backend via uv + flow CLI
    uvManager = new UvManager(log);

    try {
      // FAST PATH: check if flow binary exists on disk (no subprocess, just fs.existsSync)
      const flowBin = uvManager.getInstalledFlowBin();

      if (flowBin) {
        // Already installed → launch immediately (skip uv/version checks)
        log.info(`Fast path: flow binary found at ${flowBin}`);
        const version = uvManager.getInstalledVersionSync(flowBin);
        const versionSuffix = version ? ` v${version}` : '';
        sendStatus(`Starting flowpad${versionSuffix}`);
        await uvManager.startWithBin(flowBin);
      } else {
        // FIRST-TIME SETUP: uv tool install flowpad (latest)
        log.info('First-time setup: flow binary not found, installing latest from PyPI');
        sendStatus('Setting up Flowpad (first time)');

        sendStatus('Checking Python installation');
        await uvManager.ensureUv();

        sendStatus('Installing Flowpad');
        await uvManager.installLatest();

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

  // Wait for backend to be ready
  sendStatus('Waiting for server');
  const backendReady = await waitForBackend();

  if (!backendReady) {
    // Try to gather diagnostics for the error dialog
    let detail = 'Backend server failed to respond within 30 seconds.';
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

let isQuitting = false;

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
    const ready = await waitForBackend();

    if (ready && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(BACKEND_URL);
    }

    return { success: ready };
  } catch (err) {
    return { success: false, error: err.message };
  }
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
