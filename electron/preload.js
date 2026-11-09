const { contextBridge, ipcRenderer } = require('electron');

// Expose desktop backend API (matches FlowPad pattern)
contextBridge.exposeInMainWorld('flowpadDesktop', {
  // Returns "http://127.0.0.1:<port>"
  getBackendBaseUrl: () => ipcRenderer.invoke('get-backend-url'),
});

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Get the backend URL
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),

  // Get the app version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Restart the backend
  restartBackend: () => ipcRenderer.invoke('restart-backend'),

  // Open a URL in the system browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Capture a viewport-relative rectangle from the active BrowserWindow.
  captureRegion: (region) => ipcRenderer.invoke('capture-region', region),

  // Screen recording: the macOS Screen Recording grant ('granted' | 'denied' | 'not-determined' |
  // 'restricted'; 'granted' on every other OS) and the System Settings pane that holds it.
  screenCaptureStatus: () => ipcRenderer.invoke('screen-capture-status'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('open-screen-recording-settings'),

  // Platform info
  platform: process.platform,

  // Startup status updates (loading screen)
  onStartupStatus: (callback) => ipcRenderer.on('startup-status', (_event, message) => callback(message)),

  // Startup logs
  getStartupLogs: () => ipcRenderer.invoke('get-startup-logs'),
  watchStartupLogs: () => ipcRenderer.send('watch-startup-logs'),
  unwatchStartupLogs: () => ipcRenderer.send('unwatch-startup-logs'),
  onStartupLogsUpdate: (callback) => ipcRenderer.on('startup-logs-update', (_event, updates) => callback(updates)),

  // Update management
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_event, data) => callback(data)),
  upgradeFlowpad: (version) => ipcRenderer.invoke('upgrade-flowpad', version),
  // The release the popover offers: the newest THIS desktop runs (a version), false (none newer), null (unknown).
  getEngineUpgradeTarget: () => ipcRenderer.invoke('engine-upgrade-target'),
  // The version popover's desktop row: what the updater can offer ({supported, version, state: 'idle' | 'downloading'
  // | 'ready', percent, error, busy}), start that download, or restart into the downloaded update. The state is
  // pushed on every change; the subscription returns a disposer.
  getDesktopUpdateInfo: () => ipcRenderer.invoke('desktop-update-info'),
  downloadDesktopUpdate: () => ipcRenderer.invoke('desktop-update-download'),
  installDesktopUpdate: () => ipcRenderer.invoke('desktop-update-install'),
  onDesktopUpdateState: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('desktop-update-state', handler);
    return () => ipcRenderer.removeListener('desktop-update-state', handler);
  },
  // The ONE ready update set (desktop and/or engine: downloaded, prepared, checked): its state for the top bar's
  // indicator, the "Update Ready" toast main asks for (once, then every 90 minutes while pending), and "Restart".
  getUpdateReadyInfo: () => ipcRenderer.invoke('update-ready-info'),
  activateUpdate: () => ipcRenderer.invoke('update-activate'),
  onUpdateReadyState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('update-ready-state', handler);
    return () => ipcRenderer.removeListener('update-ready-state', handler);
  },
  onUpdateReadyToast: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('update-ready-toast', handler);
    return () => ipcRenderer.removeListener('update-ready-toast', handler);
  },

  // Startup-timeout recovery panel (loading.html): show the panel, copy the
  // recovery commands to the clipboard, and quit from the panel.
  onStartupError: (callback) => ipcRenderer.on('startup-error', (_event, data) => callback(data)),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  shareLogs: (detail, email) => ipcRenderer.invoke('share-logs', detail, email),
  quitApp: () => ipcRenderer.send('quit-app'),
  // Re-run the install/start in-app after a failed first install (no relaunch).
  retryStartup: () => ipcRenderer.send('retry-startup'),
  // Windows: application control blocked the engine's Python — repair the runtime (runtime-repair.js).
  // The user confirmed on the panel; main downloads the official python.org interpreter, reinstalls
  // the engine on it and starts it, streaming progress over `startup-status`.
  repairRuntime: () => ipcRenderer.send('repair-runtime'),
  // FLOWPAD-2231 recovery: install the newer desktop release the panel offered (verified by the updater,
  // once per version and failure), and save the support zip where the user chooses.
  updateDesktopRecovery: () => ipcRenderer.send('update-desktop-recovery'),
  exportLogs: (detail) => ipcRenderer.invoke('export-logs', detail),

  // Provision the per-instance Fernet sod-key in the OS keychain via the
  // bundled signed flow-rs binary, and return the value so the renderer
  // can hand it to Python via /api/v1/secrets/seed-key. Keeps the keychain
  // ACL trust list showing flow-rs (signed) rather than python3.x (unsigned).
  //
  // No argument → mint a fresh Fernet key.
  // String argument → re-write the supplied value via flow-rs (used by the
  //   legacy python3.x → flow-rs migration flow to preserve existing secrets).
  provisionSodKey: (existingValue) => ipcRenderer.invoke('secrets:provision-sod-key', existingValue),

  // OS-level desktop notifications (driven by the `desktop_notify` ui_command).
  // desktopNotify shows a banner; setBadge sets the dock/launcher unread count;
  // notifyAttention bounces the dock (macOS) or flashes the taskbar (Linux/Win);
  // onNotificationClick fires when the user clicks a banner — `clickTarget` is
  // an opaque navigation payload the renderer round-trips (the shell never
  // inspects it, keeping the pipe generic for any notification type).
  desktopNotify: ({ title, body, clickTarget }) => ipcRenderer.invoke('notify-os', { title, body, clickTarget }),
  setBadge: (n) => ipcRenderer.invoke('set-badge', n),
  notifyAttention: () => ipcRenderer.invoke('notify-attention'),
  // Returns a disposer. The renderer mounts this from a React effect, so without
  // one every remount left another listener on the channel — and each listener
  // navigates, so one banner click fired the navigation once per leak.
  onNotificationClick: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('notification-click', handler);
    return () => ipcRenderer.removeListener('notification-click', handler);
  },

  // Show/hide the application menu. The renderer calls this with the current
  // "is advanced view mode" boolean; the menu is only shown in Advanced/Dev.
  // On macOS a minimal baseline menu stays installed even when hidden.
  setMenuVisible: (visible) => ipcRenderer.send('set-menu-visible', visible),

  // Bring the window forward: the hub asked this desktop to open something (a message from its email).
  focusWindow: () => ipcRenderer.send('focus-window'),
});

// Heartbeat for the hung-renderer watchdog (renderer-watchdog.js): a timer on this page's main
// thread. A render loop or any other busy main thread silences it, and main restarts the window clean.
setInterval(() => ipcRenderer.send('renderer-heartbeat'), 1000);
