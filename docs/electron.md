---
id: 437ff4a3-d646-5028-9135-3374a61cea55
---

# Electron Desktop App

How the Flowpad desktop application works — from development to packaging and distribution.

## Architecture Overview

The Electron app has two components at build time, but installs the Python backend from PyPI at runtime:

```
Electron Main Process (Node.js)
  |
  |-- uv tool install flowpad --> flow CLI (installed from PyPI on first launch)
  |-- flow start               --> Python Backend (port 9007)
  |                                |
  |                                |-- serves --> React Frontend (static assets bundled in flowpad package)
  |
  |-- creates --> BrowserWindow
                     |
                     |-- loads --> http://localhost:9007 (backend-served UI)
                     |
                     |-- preload.js --> IPC bridge (window.flowpadDesktop, window.electronAPI)
```

The backend is the `flowpad` Python package published to PyPI. On first launch, Electron uses `uv` to install it (`uv tool install flowpad`), then runs `flow start` to launch the server. The frontend is a Vite-built React SPA that's included in the `flowpad` package as static assets and served by the backend.

**Prerequisites:**
- Internet access on first launch (to download `flowpad` from PyPI and install `uv` if needed)

## File Structure

```
electron/
  ├── main.js                       # Electron main process entry point
  ├── preload.js                    # Context bridge (IPC security layer)
  ├── uv-manager.js                # Installs/manages Python backend via uv + flow CLI
  ├── loading.html                  # Splash screen shown while backend starts
  ├── package.json                  # Scripts, dependencies
  ├── electron-builder.json         # Platform-specific packaging config
  ├── electron-builder.config.cjs   # Config wrapper (custom sign function)
  ├── entitlements.mac.plist        # macOS sandbox permissions
  ├── signing/
  │   ├── metadata.json             # Azure Code Signing credentials
  │   ├── notarize.js               # macOS notarization (afterAllArtifactBuild hook)
  │   └── mac-sign.js               # Custom macOS codesigning
  └── resources/
      └── icons/                    # icon.icns, icon.ico, icon.png

# Related files at repo root:
build_ui.py                         # Builds frontend into server/static/ (for PyPI package)
pyproject.toml                      # Python package config (published to PyPI as "flowpad")
```

## Application Lifecycle

### Startup Sequence

```
1. User launches app
2. Electron main process starts (main.js)
3. BrowserWindow created, loading.html displayed (splash screen)
4. Check MINIHUB_DEV env var:
   - Dev mode (true):  Assume backend running externally
   - Prod mode (false): Run uv-based install and start:
     a. uvManager.ensureUv()         — ensure uv is available (auto-installs if needed)
     b. uvManager.installLatest()    — uv tool install flowpad (from PyPI)
     c. uvManager.start()            — flow start (launches server in background)
5. Poll GET /api/v1/graph/bootstrap every 500ms (max 30 seconds)
6. Backend responds 200 -> load UI from http://localhost:9007
7. preload.js injects window.flowpadDesktop and window.electronAPI
8. main.tsx calls initDesktopBackend():
   - Calls window.flowpadDesktop.getBackendBaseUrl() via IPC
   - Gets actual backend URL (http://localhost:9007)
   - Updates SDK config with real port
9. App renders, makes API calls to backend
```

### Shutdown Sequence

```
1. User closes window / quits app
2. before-quit event fires
3. uvManager.stop() runs `flow stop`
   - Stops the monitor and server processes
4. App exits
```

### Sleep / wake (known follow-up)

There is currently **no `powerMonitor` (`suspend`/`resume`) hook** wiring system
sleep/wake to the renderer. It isn't needed for the common case: on wake the app
WebSocket reconnects and the backend's connection-membership FSM resumes PTY
delivery on its own (`PtyRegistry.on_ws_connect`; see
`docs/agent-management/pty-websocket.md`). The one remaining edge — a socket that
goes *half-open* on wake and never fires a reconnect — is deferred; closing it
needs an app-level heartbeat or a `powerMonitor 'resume'` → renderer hook that
forces a socket reconnect.

## Core Files

### main.js — Electron Main Process

Creates the BrowserWindow and manages the full app lifecycle.

**Key constants:**
```javascript
BACKEND_PORT = 9007
BACKEND_URL = "http://localhost:9007"
HEALTH_CHECK_INTERVAL = 500   // ms between bootstrap polls
MAX_HEALTH_CHECKS = 60        // 30 seconds max wait
```

**Window configuration:**
- Size: 1400x900 (min 800x600)
- Context isolation enabled, node integration disabled
- Preload script: `preload.js`
- Background color: `#1e1e1e`
- External links opened in system browser (not in Electron)

**IPC handlers (ipcMain.handle):**

| Channel | Returns                   | Purpose |
|---------|---------------------------|---------|
| `get-backend-url` | `"http://localhost:9007"` | Backend URL for SDK |
| `get-app-version` | `app.getVersion()`        | App version string |
| `restart-backend` | `boolean`                 | Restart backend (flow stop + flow start) |
| `open-external` | `void`                    | Open URL in system browser |

**Dev mode:** Set `MINIHUB_DEV=true` to skip backend installation/spawning and assume it runs externally (e.g., `python -m server.run`).

**Mouse back/forward (X1/X2) buttons** — Electron does not map these to history navigation, and the OS surfaces them **differently per platform**, so `createWindow()` listens per-platform and funnels into shared `goBack()`/`goForward()` (which call `webContents.navigationHistory`):

| Platform | Event(s) that fire | Notes |
|----------|--------------------|-------|
| **Windows / Linux** | `webContents` `app-command` → `browser-backward` / `browser-forward` | The standard path. `app-command` does **not** fire on macOS. |
| **macOS** | `webContents` `input-event` (`button: 'back'/'forward'`) **and** the `BrowserWindow` `swipe` event (`'left'` = back, `'right'` = forward) | The press never reaches the renderer as a DOM `mouseup`. |

> **macOS gotcha (hard-won):** with mouse-driver software — notably **Logitech Options / Options+** — and with the trackpad, the back/forward buttons are delivered **only** as a macOS `swipe` gesture. They do **not** arrive as a mouse button, `app-command`, DOM `mouseup` button 3/4, or keystroke. So a handler that only listens for mouse buttons silently does nothing for a large fraction of macOS users. Always also handle `mainWindow.on('swipe', …)`. (Verified by capturing every event layer with a standalone Electron tester — `Input.dispatchMouseEvent` over CDP is **not** a faithful repro: it injects a Chromium web-layer event that real macOS hardware never triggers.)

The renderer (`ui/src/main.tsx`) additionally binds `mouseup` button 3/4 → `window.history.back/forward()` for mice that *do* deliver standard buttons; this is dormant for the swipe path.

### preload.js — IPC Security Bridge

Exposes two API objects to the renderer via `contextBridge.exposeInMainWorld`:

**window.flowpadDesktop** (matches FlowPad cloud pattern):
```javascript
{
  getBackendBaseUrl: () => ipcRenderer.invoke('get-backend-url')
  // Returns "http://127.0.0.1:9007"
}
```

**window.electronAPI:**
```javascript
{
  getBackendUrl:    () => ipcRenderer.invoke('get-backend-url'),
  getAppVersion:    () => ipcRenderer.invoke('get-app-version'),
  restartBackend:   () => ipcRenderer.invoke('restart-backend'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  platform:         process.platform   // "darwin", "win32", "linux"
}
```

No direct access to `ipcRenderer`, `require()`, or Node.js APIs. All communication goes through these intentionally exposed methods.

### uv-manager.js — Backend Package & Process Manager

Installs and manages the Python backend via `uv` and the `flow` CLI.

**Bootstrap chain (handles missing tools automatically):**
1. Check if `uv` is available on PATH
2. If not, auto-install `uv` via the official installer script
3. All tool commands run via `uv tool install/upgrade/list`

**Methods:**
- `ensureUv()` — Ensures uv is installed (auto-installs if needed)
- `installLatest()` — Installs the flowpad package: `uv tool install flowpad` (from PyPI)
- `start()` — Runs `flow start` (launches backend server in background with monitoring)
- `stop()` — Runs `flow stop` (terminates monitor and server processes)
- `restart()` — Calls `stop()` then `start()`
- `upgrade()` — Runs `uv tool upgrade flowpad`

**Cross-platform support:**
- **Enriched PATH**: Prepends `~/.local/bin`, `~/.cargo/bin`, Homebrew paths, python.org framework paths, Windows Python/Scripts dirs
- **Windows**: Uses `shell: true` for `.cmd`/`.bat` wrappers; `windowsHide: true` to prevent console flash
- **Flow binary**: Resolves from `uv tool dir --bin`; checks `flow.exe`, `flow.cmd`, `flow` on Windows

**Environment variables set for `flow start`:**

| Variable | Value       | Purpose |
|----------|-------------|---------|
| `DEPLOY_ENV` | `desktop`   | Desktop deployment mode |
| `MINIHUB_HOST` | `127.0.0.1` | Listen on localhost only |
| `LOCAL_SERVER_PORT` | `9007`      | Backend port |
| `MINIHUB_RELOAD` | `false`     | Disable reloader (conflicts with Electron) |

## Frontend URL Resolution (Desktop Mode)

In desktop mode, the frontend can't use a hardcoded API URL because the backend port is determined at runtime. This is handled by the runtime backend resolution system.

### How It Works

1. **Build time:** When `IS_PACKAGE=true`, Vite bakes `__API_URL__ = ''` and `__IS_PACKAGE__ = true` into the bundle. The SDK config gets a placeholder port of `0`.

2. **Runtime:** Before React renders, `main.tsx` calls `initDesktopBackend()`:
   ```
   initDesktopBackend()
     -> window.flowpadDesktop.getBackendBaseUrl()     [IPC call]
     -> ipcMain.handle('get-backend-url')             [Electron main process]
     -> returns "http://localhost:9007"
     -> updateConfigForDesktop(sdkConfig, url)         [mutates SDK config]
     -> sdkConfig.api_port = 9007                     [real port set]
   ```

3. **API calls:** The axios request interceptor in `ts_sdk/src/client.ts` checks `isDesktopEnv()` and overrides `baseURL` on every request with the IPC-resolved URL.

4. **WebSocket:** `ts_sdk/src/websocket.ts` uses `getBackendBaseUrl()` to resolve the WS URL dynamically.

### Key Files

| File | Role |
|------|------|
| `ts_sdk/src/runtime/backend.ts` | `getBackendBaseUrl()` and `initDesktopBackend()` |
| `ts_sdk/src/config/load_config.ts` | `PACKAGE_PLACEHOLDER_PORT = 0`, `updateConfigForDesktop()` |
| `ts_sdk/src/client.ts` | Axios interceptor overrides `baseURL` in desktop mode |
| `ts_sdk/src/websocket.ts` | WS URL resolution via `getBackendBaseUrl()` |
| `ts_sdk/src/main.ts` | Port validation skipped in desktop mode (`window.flowpadDesktop` check) |

### Why Port 0?

When `__IS_PACKAGE__` is true, the SDK config uses `PACKAGE_PLACEHOLDER_PORT = 0` as a placeholder. This is fine because:
- The real port is resolved at runtime via IPC before any API calls
- The `initSdk()` port validation check skips validation when `window.flowpadDesktop` exists
- The axios interceptor overrides the URL on every request

## Build & Packaging

### Development

```bash
cd electron

# Start backend + electron in parallel:
npm run dev
# Runs: python -m server.run (port 9007) + MINIHUB_DEV=true electron .
```

### Full Build (macOS)

```bash
cd electron
npm run pack:mac:full
```

This runs the following steps in order:

```
1. npm i                         # Install electron dependencies
2. npm run build                 # Build frontend only
   └── build:frontend            # IS_PACKAGE=true python3 build_ui.py
       ├── Clean server/static/
       ├── npm install (ui/)
       ├── npm run build (with DEPLOY_ENV=desktop IS_PACKAGE=true)
       └── Copy ui/dist/* -> server/static/
3. npm run pack:mac              # electron-builder packages everything
   ├── Bundles electron shell (main.js, preload.js, uv-manager.js, etc.) into app.asar
   ├── Custom mac-sign.js signs the app
   └── notarize.js submits to Apple for notarization
```

**Note:** The UI is built into `server/static/` so it can be included in the PyPI package. The `flowpad` package must be published to PyPI separately (`uv build && twine upload dist/*`) before the Electron app can install it on user machines.

### Version Synchronization

The Electron app version (in `electron/package.json`) should match the PyPI package version (in `flow_sdk/_version.py`).

### Platform Build Commands

| Platform | Command | Output |
|----------|---------|--------|
| macOS | `npm run pack:mac:full` | `release/Flowpad-{version}.dmg` |
| Windows | `npm run pack:win:full` | `release/Flowpad Setup {version}.exe` |
| Linux | `npm run pack:linux:full` | `release/Flowpad-{version}.AppImage`, `.deb`, `.rpm` |

### Vite Build Defines

When `IS_PACKAGE=true` and `DEPLOY_ENV=desktop`:

| Define | Value | Purpose |
|--------|-------|---------|
| `__API_URL__` | `''` (empty) | No hardcoded URL, resolved at runtime |
| `__IS_PACKAGE__` | `true` | Enables placeholder port + desktop detection |
| `__DEPLOY_ENV__` | `'desktop'` | Desktop deployment mode |
| `__AUTH_PROVIDER__` | `'local'` | Local auth (no JWT/OAuth) |

When building for local development (no env vars):

| Define | Value |
|--------|-------|
| `__API_URL__` | `'http://localhost:9007'` |
| `__IS_PACKAGE__` | `false` |
| `__DEPLOY_ENV__` | `'local'` |

## Release Workflow

To release a new version:

```
1. Update flow_sdk/_version.py and electron/package.json to the same version
2. Build UI: cd electron && npm run build
3. Publish Python package: cd .. && uv build && twine upload dist/*
4. Package Electron: cd electron && npm run pack:mac:full  (or win/linux)
5. Distribute the .dmg / .exe / .AppImage
```

On first launch, the Electron app will `uv tool install flowpad` from PyPI.

## Code Signing & Notarization

### macOS Signing Strategy

The app is a lightweight Electron shell (no bundled Python binaries). The custom `mac-sign.js` walks `Contents/`, signs all Mach-O binaries, frameworks, nested apps, and the outer `.app` bundle.

**Notarization** (`notarize.js`): Submits the DMG to Apple. Supports async mode (CI) and sync mode (local dev).

**Identity detection order:**
1. `opts.identity` from electron-builder
2. `CSC_NAME` env var
3. Auto-detect from keychain (`security find-identity`)
4. Ad-hoc signing (local dev without certificate)

### Required Environment Variables

**macOS notarization:**
```bash
APPLE_ID=your@email.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=XXXXXXXXXX
```

**Windows Azure Code Signing:**
Configured in `electron-builder.json` under `win.azureSignOptions`.

### macOS Entitlements

The `entitlements.mac.plist` grants:
- JIT compilation and unsigned executable memory (required for Python)
- Library validation disabled
- Network client + server (API calls, backend listening)
- File system read/write for user-selected files

## Troubleshooting

| Problem                                         | Cause | Fix |
|-------------------------------------------------|-------|-----|
| UI calls port 9007 in packaged app              | UI built without `IS_PACKAGE=true` | Run `npm run build:frontend` from `electron/` (uses `build_ui.py`) |
| Backend fails to start                          | uv tool install failed | Check logs for uv errors; ensure internet access on first launch |
| `ModuleNotFoundError: No module named 'server'` | `server` package not included in the PyPI wheel | Ensure `pyproject.toml` has `include = ["flow_sdk*", "server*"]` |
| Port 9007 already in use                        | Another instance or process | Kill the process or change `BACKEND_PORT` in `main.js` |
| Notarization fails                              | Missing Apple credentials | Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Backend crash on Finder launch                  | Invalid working directory | Already mitigated (uv-manager sets cwd to `os.homedir()`) |
| `GET /` redirect loop                           | Port placeholder `0` treated as falsy | Desktop mode skips port validation in `initSdk()` |
| Version mismatch between Electron and backend   | Versions out of sync | Keep `electron/package.json` version and `flow_sdk/_version.py` in sync |
| First launch slow                               | Downloading uv + flowpad + dependencies from PyPI | Expected on first launch; subsequent launches reuse the uv tool venv |
