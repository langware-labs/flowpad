const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const log = require('electron-log');
const UvManager = require('./uv-manager');

// Configure logging — store all logs under ~/.flow/
const FLOW_HOME = path.join(require('os').homedir(), '.flow');
const MAIN_LOG_PATH = path.join(FLOW_HOME, 'main.log');
require('fs').mkdirSync(FLOW_HOME, { recursive: true });
try { require('fs').writeFileSync(MAIN_LOG_PATH, ''); } catch { /* ignore */ }
log.transports.file.resolvePathFn = () => MAIN_LOG_PATH;
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.info('Flowpad starting...');

// Configuration
const BACKEND_PORT = 9007;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const FLOWPAD_CLOUD_URL = process.env.FLOWPAD_CLOUD_URL || 'https://app.flowpad.ai';
const HEALTH_CHECK_INTERVAL = 500; // ms
const MAX_HEALTH_CHECKS = 60; // 30 seconds max wait

let mainWindow = null;
let uvManager = null;

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

      const os = require('os');

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
      const home = require('os').homedir();
      const logPath = path.join(home, '.flow', 'monitor.log');
      const logContent = require('fs').readFileSync(logPath, 'utf8');
      const lastLines = logContent.split('\n').slice(-15).join('\n');
      detail += `\n\nMonitor log (${logPath}):\n${lastLines}`;
    } catch {
      detail += '\n\nNo monitor log found.';
    }
    log.error(detail);
    dialog.showErrorBox('Startup Error', detail);
    app.quit();
    return;
  }

  // Load the main UI
  log.info(`Loading UI from ${BACKEND_URL}`);
  mainWindow.loadURL(BACKEND_URL);

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
  const fs = require('fs');
  const home = require('os').homedir();
  const logs = [];

  // Electron log
  try {
    const electronLogPath = log.transports.file.getFile().path;
    const content = fs.readFileSync(electronLogPath, 'utf8');
    logs.push({ name: 'Electron', path: electronLogPath, content });
  } catch { /* ignore */ }

  // Monitor log
  try {
    const monitorLog = path.join(home, '.flow', 'monitor.log');
    const content = fs.readFileSync(monitorLog, 'utf8');
    logs.push({ name: 'Monitor', path: monitorLog, content });
  } catch { /* ignore */ }

  // Server log
  try {
    const serverLog = path.join(home, '.flow', 'server.log');
    const content = fs.readFileSync(serverLog, 'utf8');
    logs.push({ name: 'Server', path: serverLog, content });
  } catch { /* ignore */ }

  return logs;
});

// ---------------------------------------------------------------------------
// Live log tailing — pushes new log lines to the renderer every second
// ---------------------------------------------------------------------------
let _logWatchInterval = null;
const _logFileOffsets = {};  // { filePath: bytesReadSoFar }

function _getLogFiles() {
  const fs = require('fs');
  const home = require('os').homedir();
  const files = [];

  try {
    files.push({ name: 'Electron', path: log.transports.file.getFile().path });
  } catch { /* ignore */ }

  const monitorLog = path.join(home, '.flow', 'monitor.log');
  if (fs.existsSync(monitorLog)) {
    files.push({ name: 'Monitor', path: monitorLog });
  }

  const serverLog = path.join(home, '.flow', 'server.log');
  if (fs.existsSync(serverLog)) {
    files.push({ name: 'Server', path: serverLog });
  }

  return files;
}

function _readNewContent(filePath) {
  const fs = require('fs');
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
  const fs = require('fs');
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
