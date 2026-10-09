---
id: 8edcadfe-73f7-4252-97ab-c1dd33acdb01
---

# The `electron/` directory — structure, flows, and next steps

This document describes the **actual** state of the `electron/` directory on branch `FLOWPAD-2110`.
It complements [`electron.md`](electron.md) (an older, general overview).

> **Correction to `electron.md`:** it says the Electron version should match the PyPI version.
> That is **not true**. The versions are independent: the desktop app is updated through
> electron-updater, and the engine (`flowpad` on PyPI) is installed and updated through `uv tool install`.

## 1. Overview

The app is a thin shell: the desktop (Electron) installs the **engine** (the Python package `flowpad`)
from PyPI using `uv`, starts it on `http://localhost:9007`, and loads it in a window.

```
Electron (main.js)
 ├─ UvManager (uv-manager.js)  → uv → python → flowpad (PyPI)  → server on :9007
 ├─ electron-updater           → desktop updates (GitHub releases)
 └─ BrowserWindow              → loading.html, then http://localhost:9007
```

## 2. Directory layout

### Main process

| File | Role |
| --- | --- |
| `main.js` | Entry point (no exports). Window, menu, deep links, IPC, desktop updates, the startup/install flow (`startApp`, `installAndStartBackend`), the error panel. |
| `uv-manager.js` | The `UvManager` class. Downloads `uv`, installs/upgrades/reinstalls the engine, picks the Python version, manages the install-in-progress marker, WDAC fallback, `checkForUpdatesInBackground`. |
| `preload.js` | `contextBridge` bridge to the renderer. |
| `loading.html`, `loading-renderer.js` | Loading screen, progress, and the error panel (including "Share with us"). |

### Small modules (each has a `*.test.js`)

| Module | Role |
| --- | --- |
| `semver.js` | Version comparison. |
| `shutdown.js` | Graceful backend stop. |
| `backend-wait.js` | Waiting for the server to come up. |
| `flow-rs-keychain.js` | Reading keys from the keychain. |
| `progress-watchdog.js` | Progress guard: 30 s windows, 3 quiet windows in a row = stalled. Gated by `canStall`, async sampling, overlap-safe. |
| `update-restart.js` | `createRestartApplier` — "Restart now": stops the backend, installs, and recovers if the restart fails. |
| `update-plan.js` | The combined update flow: `decideOffer`, `savePendingEngine`, `markPendingEngineConsented`, `planAfterDesktopUpdate`, `createReadyReminder`. |
| `startup-error.js` | `describeStartupFailure` and `summarizeOutput` — panel text and which steps to show. |
| `support-bundle.js` | "Share with us": `collectLogs`, `buildSupportZip`, `buildMailtoUrl`, `redact`. |
| `zip-writer.js` | Dependency-free zip writer (`createZip`, `crc32`). |
| `log-redact.js` | Secret redaction in logs: `redactUrl`, `redactLogMessage`, `installLogRedaction`. |
| `app-location.js` | AppTranslocation detection and the offer to move to `/Applications` (macOS only). |

### Build, signing, distribution

| Path | Role |
| --- | --- |
| `electron-builder.json` | Build config. The `files` list is a **whitelist** — a new module must be added to it or it will not be packaged. `*.test.js` files are excluded. |
| `electron-builder.config.cjs` | Wrapper around the JSON. Under `FLOWPAD_SIGNING=required`, a placeholder `publisherName` counts as missing (`builder-config.test.js`). |
| `signing/` | `mac-sign.js`, `notarize.js`, `win-verify.js`, plus `LAUNCHER.md`, `SMARTSCREEN*.md`, `WINDOWS-SIGNING.md`. |
| `scripts/build-flow-rs.js` | Builds the `flow-rs` binary. |
| `winget/`, `store/STORE.md` | winget and store distribution. |
| `resources/`, `agentic-assets/`, `entitlements.mac.plist` | Icons, bundled assets, macOS entitlements. |

### Tests and running

- `npm test` runs 14 test files in sequence (see `package.json`).
- `main-update-flow.test.js` is an integration test that loads the **real** `main.js` with stubs for electron,
  electron-updater, electron-log and UvManager, exposing internals by appending to the source at load time.
  It was checked with three mutation checks.
- The `uv-manager` tests never run the real installer: `_runStreaming` is stubbed, and a global guard throws on
  any command containing `astral.sh` / `tool install` / `tool run`.
- CI: the `electron-tests` job in `.github/workflows/test.yml`. Locally: the `electron-tests` hook in `.pre-commit-config.yaml`.
- Release repo `flowpad-desktop` (`.github/workflows/build-desktop.yml`): the `test-electron` job runs `npm test`,
  the app identity is patched with sed and verified, `win-verify.js release --publisher "Langware INC."` runs, and
  the step "Verify baked auto-update config (app-update.yml)" checks the baked update config.

## 3. Flows

### 3.1 Startup and first install
1. `startApp` (macOS, non-dev) first calls `offerMoveToApplications`.
2. If `uv` is missing, `ensureUv` downloads it (section 3.4).
3. `installAndStartBackend` installs the engine: `uv tool install flowpad@latest|==X --python <pin> --force --compile-bytecode --no-build-package cryptography` (cryptography is never built from source: Intel Mac has no wheel from 49.0.0).
4. The desktop waits for the server to be healthy, then loads the window.
5. A failure is shown in a detailed error panel with Retry / Share with us.

**Python selection:** the pin comes from the floor in the bundled `pyproject.toml`, raised according to the
`requires_python` of the PyPI release (`pythonFloor`, `maxPythonVersion`, `_pythonPinForUpgrade`). This prevents the
"engine ≥0.2.173 needs 3.11 but an old desktop pins 3.10" failure for new desktops.

### 3.2 Updates (new flow)
- Checked every 20 minutes (`UPDATE_CHECK_INTERVAL_MS`) by `checkPackageUpdateInBackground`.
- **Desktop and engine both new:** one screen, "Update now / Later". The engine version X is saved to `pending-engine.json`.
  After a consented "Restart now", the new desktop installs exactly `flowpad==X` (`planAfterDesktopUpdate` → `upgrade({version})`).
- **"Later":** a reminder every 90 minutes (`READY_REMINDER_MS`). If the app is closed after Later, the regular engine
  dialog appears — no silent install.
- **A newer desktop** refreshes X. Engine dialogs are **held back** while a desktop update is pending.
- **A yanked X** is replaced by the latest release (`_resolveEngineTarget`).
- Engine-only update: the regular dialog. Desktop-only update: background download and the "ready" prompt.
- electron-updater: `autoDownload=false`, `autoInstallOnAppQuit=true`, NSIS with `oneClick:false`
  (`quitAndInstall` is handled in `update-restart.js`); setup is idempotent (`updaterInitialized`).

### 3.3 Recovery from an interrupted install
`~/.flow/desktop-install-in-progress.json` is written before an install and removed on success.
`repairIfInterrupted` repairs on the next launch; `abortInstall` stops an install; if the watchdog killed the install
(`killedByGuard`) the marker is **kept**. A `before-quit` dialog warns while an install is running.

### 3.4 Watchdog and time limits (approved values)
| What | Value |
| --- | --- |
| Watchdog window | 30 s; 3 quiet windows in a row = stalled |
| `uv` download — fallback cap (when the signal is untrusted) | 200 s (`_fallbackCapMs`) |
| `uv tool install` — fixed cap | 240 s (`_toolInstallCapMs`), identical in `upgrade()` / `reinstall()` |
| Health after upgrade | 240 checks = 120 s (`POST_UPGRADE_HEALTH_CHECKS`) |
| Server log silence | 60 checks = 30 s (`LOG_STALL_CHECKS`) |

**Progress signal:**
- `uv` download: a private TMPDIR plus a `mktemp` shim (macOS `mktemp -d` ignores TMPDIR), verified at runtime
  (`_installerHonorsTempDir`). On Windows the installer needs its own `PSModulePath` (`windowsPowerShellModulePath`)
  because one inherited from pwsh 7 breaks powershell.exe 5.1.
- `uv tool install`: an async fingerprint of the top level of `uv cache dir` and `uv python dir` (including dot-entries),
  plus the async size of `<tool dir>/flowpad`. Trust in the signal is established at runtime, once the directories are seen moving.
  A full scan is never done: an 8 GB cache took ~9 s synchronously.
- Measured with real uv: a slow proxy at 300 KB/s — the install succeeded in 407 s with no false stall.
  A frozen network with `UV_HTTP_TIMEOUT=900` — the guard stopped at 180 s with `stalled:true` and the marker was kept.

### 3.5 Application-control policy (WDAC)
When `flow.exe` is blocked (`isPolicyBlockError`), the chain is: launcher shim → `uv tool run` → the venv python (`PY_FLOW_ENTRY`).
If everything is blocked, a `policyBlocked` error is raised and the panel hides the upgrade/diagnose steps that cannot help.

### 3.6 Secrets in logs
`installLogRedaction(log)` is called before the first log line; `redactUrl` is applied wherever a URL is logged.
In Share, `support-bundle.redact` also covers `fp_(live|test)_`.

### 3.7 Share with us
Sent to `diagnosis@langware.ai`, subject `Flowpad startup problem - YYYY-MM-DD`.
Only the newest desktop log and the newest server log are included. It is a `mailto:` (limited to 1800 characters);
the zip is built locally (`MAX_LOG_BYTES` = 2 MB per file).

### 3.8 AppTranslocation
On macOS, an app running from a transient location is offered, once per version, a move to `/Applications`
(`app.moveToApplicationsFolder`). State is kept in `app-location-prompt.json`.

## 4. State files and logs

| File | Location |
| --- | --- |
| `desktop-version.json`, `app-location-prompt.json`, `pending-engine.json` | `app.getPath('userData')` |
| `desktop-install-in-progress.json` | `~/.flow/` |
| Desktop log | `~/.flow/logs/main_desktop/<DDMonYYYY_HH_MM_SS>.log` |
| Server / monitor logs | `~/.flow/instances/<FLOW_INSTANCE or prod>/logs/{server,monitor}` |

## 5. IPC channels

- `handle`: capture-region, close-auth-window, copy-to-clipboard, get-app-version, get-backend-url,
  get-startup-logs, notify-attention, notify-os, open-auth-window, open-external, open-logs-folder,
  restart-backend, set-badge, share-logs, upgrade-flowpad.
- `on`: quit-app, set-menu-visible, unwatch-startup-logs, watch-startup-logs.
- `once`: retry-startup.
- `app` events: activate, before-quit, open-url, second-instance, window-all-closed.

---

## 6. Note: what still needs to be implemented (next step)

**Not implemented — deliberately marked as such:**

1. **Rollback of a broken engine.** Today there is only a *recovery path* (marker + retry), not a return to the
   previous version. Design: back up the instance directory, `agentic-assets/` and `.flow/` of each root, and
   `global/migrations`; restore when health fails in the first-start window. Requires a Python-side command (`flow backup`).
2. **A compatibility gate.** The engine would publish `min_desktop_version`, and the desktop would not upgrade to an
   engine that requires a newer desktop.
3. **API key leak on the Python side.** `flow_sdk/server/run.py` runs uvicorn with `log_level="info"` and the default
   access log, so the full query string of `/auth/login_callback` (including `flowpad-api-key`) is written to the server
   log. A filter on `uvicorn.access` is needed. (Proven with a real uvicorn run.)
4. **`requires_python`** — only `>=` is parsed today. `~=`, `==` and upper bounds are missing.
5. **Updating `uv` itself.**
6. **Hard-coded uv tool directory.** `getInstalledFlowBin` and `_toolVenvDir` in `uv-manager.js` build the engine's
   location by hand (`~/.local/share/uv/tools/flowpad`, or `%APPDATA%\uv\tools\flowpad` on Windows) and ignore
   `UV_TOOL_DIR`, `XDG_DATA_HOME` and a redirected AppData. On a machine where uv keeps its tools elsewhere, the desktop
   looks in the wrong place, concludes the engine is not installed, and reinstalls it on every launch.
   *Fix:* ask uv where its tool directory is (`uv tool dir`, as `_uvDirs()` already does for the cache and python dirs)
   and derive every path from that answer. Add a test that sets `UV_TOOL_DIR` to a temp directory.
7. **The keychain read has no timeout.** `runFlowRs` in `flow-rs-keychain.js` runs the `flow-rs` binary with
   `execFile` and no time limit. If the OS keychain is locked and waits for a password prompt, the loading screen hangs
   indefinitely. *Fix:* bound the call and surface a clear error, or read the key after the window is already up.
   Note: adding a timeout is exactly the kind of change the project rules forbid without explicit approval
   (see "Test timeouts" in `CLAUDE.md`) — get that approval first, or choose the structural alternative (do not block
   startup on the keychain).
8. **AppImage update can delete the only copy of the app (Linux).** electron-updater's `AppImageUpdater` calls
   `unlinkSync(appImageFile)` *before* `mv -f <downloaded installer> <destination>`. The downloaded file sits in
   `~/.cache/flowpad-updater/pending`, usually on a different filesystem, so `mv` is a copy followed by a delete. If the
   copy fails (no space, permissions, read-only mount), the old AppImage is already gone and the user is left with
   nothing. *Fix:* before installing, check free space and write access; keep a hard-linked backup of the current
   AppImage and restore it if the move fails. For deb/rpm installs the update needs elevated rights (`pkexec`), which is
   a separate path to handle.
9. **The combined update dialog can offer an update that cannot be downloaded.** `getDesktopUpdateVersion` in `main.js`
   trusts `updateInfo.version` and ignores `isUpdateAvailable` from electron-updater. A staged rollout percentage,
   `minimumSystemVersion`, or a semver difference can make `downloadUpdate` refuse ("Please check update first") while
   our dialog still offers the update — on every launch. *Fix:* gate the offer on `isUpdateAvailable` and add a test
   with a staged-rollout response.
10. **Install-guard gaps.** The "install in progress" guard (`_installing`) covers only `_uvToolInstallForce`. It does
    not cover the `ensureUv` download, the PyPI version lookup, or the PATH shim step (`update-shell`), so quitting
    during those is not warned about or recorded. Separately, calling `preventDefault` in `before-quit` may block an OS
    logout/restart on macOS/Windows — this was never verified and should be tested on real machines.
11. **Double install after a repair.** On launch, the interrupted-install repair runs before the desktop and PyPI checks.
    If PyPI publishes a new version in between, the pre-start check can run a second `--force` install right after the
    repair. *Fix:* run the checks first, or have the repair install the target version once.
12. **The PyPI version lookup has no abort.** `_getLatestPypiInfo` and `_getPypiVersionInfo` in `uv-manager.js` call
    `fetch(https://pypi.org/...)` with no abort signal, and `_pythonPinForUpgrade` awaits them inside `installLatest` and
    `reinstall`. On a network that silently drops packets, the first install, the repair and the broken-install repair
    hang with no progress line — before uv even starts. A first install used to need no network before uv ran.
    *Fix (without widening any wait):* do not block on the lookup — if it does not answer, continue with the pin from
    the bundled `pyproject.toml` floor and log that the remote pin was skipped. A timeout on the fetch would also
    work, but needs explicit approval under the project rules.
13. **Validation on real machines:** a WDAC machine, Electron + electron-updater on macOS and Windows,
    `moveToApplicationsFolder`. The automated tests use stubs and do not replace this.
14. **Docs maintenance:** run `docit index` (`docs/index.md` is generated and must not be edited by hand),
    and fix the incorrect claim in `electron.md`.
