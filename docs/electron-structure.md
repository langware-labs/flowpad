---
id: 8edcadfe-73f7-4252-97ab-c1dd33acdb01
---

# The `electron/` directory — structure, flows, and next steps

This document describes the **actual** state of the `electron/` directory on branch `FLOWPAD-2110`.
It complements [`electron.md`](electron.md) (an older, general overview).

> **Versions:** the desktop app and the engine release independently — the desktop is updated through
> electron-updater, the engine (`flowpad` on PyPI) through `uv tool install`. What keeps an installed pair
> workable is the bidirectional compatibility contract in [`version-compatibility.md`](version-compatibility.md).

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
| `uv-manager.js` | The `UvManager` class. Downloads `uv`, installs/upgrades/reinstalls the engine, picks the Python version, manages the install-in-progress marker, WDAC fallback, `checkForUpdatesInBackground`. A post-boot engine update is first prepared in the background (`prepareEngine`: staged in a throwaway tool dir, then checked to import, report the release and meet the start contract — its launch module, `/health/status`, `flow --help` — without starting a server; the record is `~/.flow/prepared-engine.json`; the staging dir is removed in the background — a file Windows still holds is tried 3 times, then left to the next prepare's sweep), so the upgrade after "Upgrade" — now, or at a later launch — installs offline in seconds. "Later" to the engine dialog at launch prepares it once the app is up (`prepareDeferredEngineUpdate`), so the next launch's "Upgrade" is fast too. The engine that rides along with a desktop update is prepared the same way while the desktop downloads, for the NEW desktop, which installs it offline after the restart. |
| `preload.js` | `contextBridge` bridge to the renderer. |
| `loading.html`, `loading-renderer.js` | Loading screen, progress, and the error panel (including "Send Report"). |

### Small modules (each has a `*.test.js`)

| Module | Role |
| --- | --- |
| `semver.js` | Version comparison. |
| `engine-compat.js` | Desktop <-> engine compatibility: the floors (`engine-compat.json` / the wheel's `flow_sdk/compat.json`), `checkPair`, `selectCompatibleRelease`, `isInstallableVersion`. See `docs/version-compatibility.md`. |
| `wheel-compat.js` | `readWheelMember` — reads one member (a candidate release's `flow_sdk/compat.json`) out of a remote wheel with HTTP Range requests: tens of KB instead of the whole wheel, no package code run. |
| `shutdown.js` | Graceful backend stop. |
| `backend-wait.js` | Waiting for the server to come up. |
| `flow-rs-keychain.js` | Reading keys from the keychain. |
| `progress-watchdog.js` | Progress guard: 30 s windows, 3 quiet windows in a row = stalled. Gated by `canStall`, async sampling, overlap-safe. |
| `update-restart.js` | `createRestartApplier` — "Restart" on a desktop update: the window stays up on "Installing the update" (never hidden before the quit begins), stops the backend, installs, and brings the app back if the restart fails. |
| `update-schedule.js` | When automatic update checks happen (FLOWPAD-2308): per-account cadence (hourly for @langware.ai, daily otherwise) plus a desktop-only look at the feed every launch and every 20 minutes for every account (`desktopCheckDue`), failure backoff, launch-check planning, the offered-version watermark. Pure decisions; `main.js` owns the timers and the fs. |
| `update-plan.js` | The combined update flow: `decideOffer`, `savePendingEngine`, `markPendingEngineConsented`, `planAfterDesktopUpdate`, `createReadyReminder`. |
| `startup-error.js` | `describeStartupFailure` and `summarizeOutput` — panel text and which steps to show. |
| `support-bundle.js` | "Send Report" zip: `collectLogs`, `buildSupportZip`, `redact`. |
| `support-upload.js` | "Send Report" upload: `uploadSupportBundle` — the zip to the hub's anonymous `/diagnosis-report/bundle` intake (GCS). |
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
5. A failure is shown in a detailed error panel with Retry / Send Report.

**Python selection:** the pin comes from the floor in the bundled `pyproject.toml`, raised according to the
`requires_python` of the PyPI release (`pythonFloor`, `maxPythonVersion`, `_pythonPinForUpgrade`). This prevents the
"engine ≥0.2.173 needs 3.11 but an old desktop pins 3.10" failure for new desktops.

### 3.2 Updates (new flow)
- Both channels are checked on a per-account schedule (`update-schedule.js`, FLOWPAD-2308): hourly for an
  `@langware.ai` login (the hub-validated email the backend writes to the instance's `config.json`), daily
  otherwise — including logged out. The last check, its answer, the failure streak and the last version
  announced persist in `update-schedule.json` (userData), so a restart neither resets the cadence nor
  re-announces the same version; failed checks retry on a growing backoff (10 min → 4 h). A 5-minute tick
  only asks whether a check is due; login/logout/account switch re-evaluate at once (a directory watch on
  the instance dir, re-armed by the tick if it dies). The launch check is skipped while a recent answer said
  "current" (the status is seeded, so engine updates are not held), but a relaunch inside a failure backoff
  retries for real; recovery panels and the update-cycle harness bypass the schedule.
  The DESKTOP feed is also looked at on every launch and every 20 minutes, whatever the account (a new desktop
  leads; the engine follows its dependencies): a desktop-only check (`getDesktopUpdateVersion({desktopOnly})`)
  stamps `lastDesktopCheckAt` (and keeps its answer in `lastResult`) and never moves the shared anchor or the
  backoff, so the engine keeps its cadence. At a launch inside the interval it runs in the background — the
  start never waits for the feed — and a newer desktop it finds is offered once the app is up, never mid-start.
  That launch asks no engine question pre-start (it would come before the feed answers): once the app is up,
  `postBootUpdates` waits for the background look (bounded by the launch check's 20 s; the app is usable
  meanwhile), offers a desktop it found first — with a newer engine riding it — and only then
  the engine alone (PyPI comparison, prepared before it is announced). A look that gives up defers nothing further; a
  desktop it finds later still goes first. Not after a failed start (the previous run never got up, per the
  startup journal, or the error panel's Retry): an engine that does not boot never gets to `postBootUpdates`,
  so there the engine question is asked pre-start, as before (`engineOfferCanWaitForBoot`). An engine
  prepared in the background is offered only if no desktop update turned up while it prepared. After a desktop
  UPGRADE — "Restart" on "Update Ready", or installed on the next quit — the new desktop
  installs the newest engine it accepts without a question (`engineForUpdatedDesktop`; offline when it was
  prepared with the desktop download; PyPI silent → the version saved with the update). A downgrade (an older
  installer run by hand) changes no engine by itself: the installed-pair check repairs a forbidden pair, and
  asks before moving the engine backward. A feed answer that
  cannot be announced (offered before a restart, or a feed regression after a pull) is adopted silently —
  downloaded deferred, installed on the next quit, surfaced by the reminder (`decideDesktopAction`).
  Each channel keeps its own failure streak: a PyPI outage retries engine-only on its backoff without
  re-hitting the GitHub feed, and vice versa. There is ONE offer at a time (`startOffer` is the only entry
  point, and launching it does not block the scheduler); a newer release found while the previous one
  downloads cancels that download and is offered instead. Work blocked by a running offer, check or download
  is a per-half follow-up debt, finished from the cached answer on a near tick and capped at 3 consecutive
  failed retries per interval.
- **Nothing is asked before an update is ready** (VS Code's model): a newer desktop downloads in the background, a
  newer engine is prepared in the background (downloaded, staged and checked while the running engine serves), and
  an optional update never holds the start. Only the recovery asks pre-start: after a failed start, or for an
  install that cannot say its version, the native engine question stays (a fix on PyPI is the way out).
- **"Update Ready":** once a set is ready (`updateReadyState`: the downloaded desktop with the engine saved to ride
  it, or a prepared engine alone while no desktop goes first), ONE non-blocking toast — "Update Ready", Restart /
  Later, gone after 30 s (`ui/.../update-ready/UpdateReadyBridge.tsx`) — and an "Update ready" indicator in the top bar
  for as long as it stays ready; it opens the version popover, which lists the set and applies it. The same set is
  toasted once; the 90-minute reminder (`READY_REMINDER_MS`) toasts it again while it stays pending. Later, the X
  and the timeout only close the toast. A toast asked for while the UI is still mounting is not lost: the UI takes
  it on mount (`update-ready-take-toast`, handed out once). A prepared engine is the newest release THIS desktop runs
  — PyPI's newest, or an older one when the newest needs a newer desktop — and is offered while it is newer than the
  installed one. A new desktop download replaces the downloaded installer, so that one stops being ready.
- **Restart** (`update-activate`, one at a time; `busy` while a background check or prepare runs, `not-ready` once
  the set is gone — a Restart from the toast that does not apply opens the popover to say why) uses the existing paths: a desktop update is the old "Restart now" —
  consent to the saved engine version X (`pending-engine.json`), then `restartApplier`; the new desktop installs
  exactly `flowpad==X` (`planAfterDesktopUpdate` → `upgrade({version})`). An engine-only update is the popover's
  upgrade (`upgradeEngine`: the offline swap, the server restarted, the window reloaded) — the desktop keeps running.
- **A newer desktop** refreshes X. Engine updates are **held back** while a desktop update is pending or KNOWN — a
  failed check never overwrites a known newer desktop (in memory, and `lastResult` on disk is kept by `recordFailure`).
  A desktop check that has not answered (`unknown`) is no newer desktop: such a hold looks at the feed again first
  (`engineChangeAllowedAfterRecheck`, the desktop-only check, bounded like the launch check — a scheduled pass that has
  just looked does not look twice), and when the feed still does not answer and no newer desktop is known
  (`lastKnownNewerDesktop`), the engine change goes on against THIS desktop's compatibility contract instead — a
  GitHub outage or a proxy never strands the engine. Every engine update is checked fail-closed: a release whose
  compatibility metadata cannot be read, or that ships none, is never picked (`resolveCompatibleEngineVersion`) or
  installed (`_assertCandidateCompatible`), and `upgrade()` never falls back to an unchecked `@latest`; only a first
  install or a repair (no working engine) still relies on the post-install check. Used by the popover's "Upgrade",
  the post-boot and engine-retry checks, the postponed prepare and the gate after a prepare. The popover refuses only for a newer desktop to install first
  (`desktopUpdatePending`).
- **Activation:** an upgraded engine is remembered until it is seen healthy (`markEngineHealthy`). One that does not
  come up — applied from "Update Ready", from the popover, or installed at launch — is stopped and the engine it
  replaced is put back (`restorePreviousEngine`: uv's cache first, then PyPI) and started; before activation the staged
  engine was checked against the start contract (`_validateStaged`: imports, version, `flow_sdk.server.launch`, the
  `/health/status` route, `flow --help`). An incompatible pair after an install is rolled back the same way
  (`_verifyInstalledPairOrRollback`).
- **A yanked X** is replaced by the latest release (`_resolveEngineTarget`).
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
In "Send Report", `support-bundle.redact` also covers `fp_(live|test)_`.

### 3.7 Send Report
The zip is built locally (`MAX_LOG_BYTES` = 2 MB per file; newest desktop + server + monitor logs, secrets masked)
and uploaded to the hub's anonymous `POST /api/v1/diagnosis-report/bundle` intake (`FLOWPAD_CLOUD_URL`), which stores it in
GCS and notifies the team; the hub answers a `submission_id` the user can quote. Clicking "Send Report"
already commits the upload: a popup asks for an optional email, and every way out of it — Send, ×, Esc —
uploads (empty email = anonymous; native failure dialogs send anonymously). On upload failure the panel
offers "Export logs".

### 3.8 AppTranslocation
On macOS, an app running from a transient location is offered, once per version, a move to `/Applications`
(`app.moveToApplicationsFolder`). State is kept in `app-location-prompt.json`.

## 4. State files and logs

| File | Location |
| --- | --- |
| `desktop-version.json`, `app-location-prompt.json`, `pending-engine.json`, `update-schedule.json` | `app.getPath('userData')` |
| `desktop-install-in-progress.json` | `~/.flow/` |
| Desktop log | `~/.flow/logs/main_desktop/<DDMonYYYY_HH_MM_SS>.log` |
| Server / monitor logs | `~/.flow/instances/<FLOW_INSTANCE or prod>/logs/{server,monitor}` |

## 5. IPC channels

- `handle`: capture-region, close-auth-window, copy-to-clipboard, desktop-update-download, desktop-update-info,
  desktop-update-install, get-app-version, get-backend-url, update-activate, update-ready-info, update-ready-take-toast,
  engine-upgrade-target, get-startup-logs, notify-attention, notify-os, open-auth-window, open-external,
  open-logs-folder, restart-backend, set-badge, share-logs, upgrade-flowpad.
  The version popover's "Upgrade to vX": `engine-upgrade-target` names the newest release THIS desktop runs
  (PyPI's newest may need a newer desktop); `upgrade-flowpad(version)` installs exactly it — checked against the
  desktop before the server is stopped, and a failed install brings the running version back (or the error panel).
  The popover's desktop button: `desktop-update-info` (what the updater can offer, pushed on every change as
  `desktop-update-state`), `desktop-update-download` (looks at the feed and starts the offer's download — the
  usual "Update Ready" follows), `desktop-update-install` (its Restart). The ready set: `update-ready-info` (pushed as
  `update-ready-state` for the top bar's indicator; `update-ready-toast` asks the UI for the toast, which it takes
  with `update-ready-take-toast` — also on mount, for one sent before it listened) and
  `update-activate` (Restart, from the toast or the popover).
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
9. **The desktop offer can start an update that cannot be downloaded.** `getDesktopUpdateVersion` in `main.js`
   trusts `updateInfo.version` and ignores `isUpdateAvailable` from electron-updater. A staged rollout percentage,
   `minimumSystemVersion`, or a semver difference can make `downloadUpdate` refuse ("Please check update first") while
   the offer still starts it — on every launch. *Fix:* gate the offer on `isUpdateAvailable` and add a test
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
