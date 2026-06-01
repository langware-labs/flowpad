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
});
