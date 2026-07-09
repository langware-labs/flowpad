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
  upgradeFlowpad: () => ipcRenderer.invoke('upgrade-flowpad'),

  // Startup-timeout recovery panel (loading.html): show the panel, copy the
  // recovery commands to the clipboard, and quit from the panel.
  onStartupError: (callback) => ipcRenderer.on('startup-error', (_event, data) => callback(data)),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  quitApp: () => ipcRenderer.send('quit-app'),

  // Provision the per-instance Fernet sod-key in the OS keychain via the
  // bundled signed flow-rs binary, and return the value so the renderer
  // can hand it to Python via /api/v1/secrets/seed-key. Keeps the keychain
  // ACL trust list showing flow-rs (signed) rather than python3.x (unsigned).
  //
  // No argument → mint a fresh Fernet key.
  // String argument → re-write the supplied value via flow-rs (used by the
  //   legacy python3.x → flow-rs migration flow to preserve existing secrets).
  provisionSodKey: (existingValue) => ipcRenderer.invoke('secrets:provision-sod-key', existingValue),
});
