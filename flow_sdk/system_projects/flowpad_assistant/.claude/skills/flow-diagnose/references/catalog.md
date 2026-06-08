# Flowpad Known-Issue Catalog

Quick reference for the flow-diagnose skill. Each entry: cause, detection command(s) per
platform, repair class, and repair action or workaround.

> **Ports:** use `$PORT` / `$VITE_PORT` resolved in SKILL.md Step 1 — do not hardcode. `9007` /
> `4097` shown below are the packaged-desktop / dev defaults (the desktop app pins `9007`).

---

## A. Runtime / Backend — AUTO-REPAIRABLE

### A1 Port occupied ($PORT, default 9007)
- **Cause**: A previous backend process did not exit cleanly and is still holding the port.
- **Detection**:
  - macOS/Linux: `lsof -ti tcp:$PORT`
  - Windows: `netstat -ano | findstr ":$PORT"`
- **Repair**: `flow stop` → if still held, SIGTERM/SIGKILL (mac/linux) or `taskkill /PID <pid> /F` (win). Tell user to relaunch.

### A2 Backend unhealthy / failed to respond within 30 s
- **Cause**: Stale lock from dead PID, DB corruption, or disk full.
- **Detection**: `curl -fsS http://localhost:$PORT/health/status` → not `{"data":true}`.
- **Repair**:
  - Stale lock: verify `server.pid` PID is dead → delete `server.lock` + `server.pid` → relaunch.
  - DB corruption: backend auto-recovers from `~/.flow/instances/<name>/backups/` on next launch.
  - Disk full: `df -h ~/.flow` (mac/linux) / `Get-PSDrive C` (win) → free space.
- **NEVER** raise the 30 s health-check timeout.

### A3 Instance not running / no server.json
- **Cause**: `FLOW_INSTANCE` env var points to an instance with no live server.
- **Detection**: `ls ~/.flow/instances/` + `echo $FLOW_INSTANCE`.
- **Repair**: Desktop app → relaunch Flowpad (always uses "prod"). CLI → `flow start` or `FLOW_INSTANCE=<name> flow start`.

### A4 Sodot/secrets undecryptable
- **Cause**: Keychain key lost or changed; stored secrets are now unreadable.
- **Self-heal**: `recover_orphaned_sodot` runs automatically on next launch, resets the secrets store.
- **User action**: Re-enter any API keys after restarting.

---

## B. Packaging (pip path) — REINSTALL

### B5 Blank page / 404 on /assets/*.js or *.css
- **Cause**: Wheel built without running `build_ui.py`; `server/static/assets/` is empty.
- **Detection**: Open http://localhost:$PORT → 404 errors on JS/CSS assets.
- **Repair**: `uv tool install flowpad --force` (or `pip install --force-reinstall flowpad`), restart backend.

---

## C. Hub / Cloud — INFORMATIONAL (non-fatal)

### C6 Cloud not available / hub unreachable / expired token
- **Cause**: Internet issue, hub down, or expired auth token.
- **Impact**: Sharing/sync/realtime degrade. Local app fully functional.
- **Action**: Expired token → log in again from Settings. Hub unreachable on localhost:8093 → local hub process not running (dev scenario only).

---

## D. Distribution / First-launch — NOT USER-REPAIRABLE (CI/signing side)

### D7 macOS "app is damaged / can't be opened"
- **Cause**: Signing/notarization/stapling failed in CI.
- **Workaround**: `xattr -dr com.apple.quarantine /Applications/Flowpad.app` (per-app, does not disable Gatekeeper).
- **Report to**: https://github.com/langware-labs/flowpad-desktop/issues

### D8 Windows SmartScreen / unknown publisher
- **Cause**: Azure Trusted Signing creds missing in CI → unsigned .exe ships.
- **Workaround**: "More info" → "Run anyway".
- **Report**: Windows version + Flowpad version in the issue tracker.

### D9 Linux AppImage won't launch (FUSE missing)
- **Cause**: AppImage requires FUSE; not present on all distros.
- **Options** (ask user to choose; do not run sudo automatically):
  - `sudo apt-get install -y libfuse2`
  - Extract: `./Flowpad-*.AppImage --appimage-extract && ./squashfs-root/AppRun`

---

## E. Auto-update — CI/manifest side, NOT user-repairable

### E10 Apple Silicon gets Intel (x64) build
- **Cause**: CI manifest merge bug; both arch builds emit same-named `latest-mac.yml`.
- **Detection**: `~/.flow/logs/main_desktop/` shows electron-updater downloading `x64` artifact on arm64.
- **Workaround**: Manually download `arm64` .dmg from GitHub Releases.

### E11 Updates never detected
- **Cause**: `RELEASE_VERSION` override empty in CI → manifest version = `package.json`, diverges from GitHub tag.
- **Detection**: `~/.flow/logs/main_desktop/` → `[electron-updater] update-not-available` despite newer release existing.
- **Workaround**: Manual install from GitHub Releases.

### E12 macOS auto-update broken
- **Cause**: CI did not upload `.zip` + `.blockmap`; electron-updater on macOS needs `.zip`.
- **Workaround**: Download and reinstall from `.dmg` on GitHub Releases.

---

## F. Two-updater Drift — PARTIALLY USER-REPAIRABLE

### F13 Electron shell and Python backend on mismatched versions
- **Detection**: `uv tool list | grep flowpad` vs Electron version in logs or About screen.
- **Backend repair**: `uv tool install flowpad@latest --force` → relaunch.
- **Shell repair**: auto-updates on next launch if manifest is correct. If not, see E11/E12.

---

## G. Electron desktop app — STARTUP / RUNTIME (read `~/.flow/logs/main_desktop/`)

> The Electron shell (`flowpad/electron/`) spawns and waits for the Python backend. **A healthy
> backend RIGHT NOW does not mean the shell is fine** — the shell can be stuck on "Starting…" or
> have shown a "Startup Error" because it gave up *earlier* (its health window is only 30 s). Always
> read the **newest `~/.flow/logs/main_desktop/*.log`** and reason about the Electron↔backend
> timeline — even when `/health/status` is currently `{"data":true}`.

### G14 App stuck on "Starting…" / backend health timeout
- **Cause**: The shell polls `http://localhost:$PORT/health/status` for **30 s** (60 × 500 ms,
  `main.js` `waitForBackend`). If the backend isn't healthy within that window, the loader stays on
  "Waiting for server" / shows the **"Startup Error"** dialog ("Backend server failed to respond
  within 30 seconds") — even though the backend may finish booting a few seconds later.
- **Detection** (`main_desktop` log): `"Waiting for backend"` **not** followed by `"Backend is
  ready!"`; `"Backend failed to start within timeout"`; `"[startup error details]"`. Cross-check the
  newest `server` log to see the backend actually became healthy *after* the shell gave up.
- **Root causes to look for**: a slow/cold backend boot — fresh `uv tool install` (see G15), large
  first-run FS index, slow disk, or **Windows antivirus scanning python/flow.exe**.
- **Repair**: usually just **relaunch** — the backend is warm/installed now, so the second launch
  fits inside the 30 s window. (NEVER raise the 30 s timeout.) If it recurs every launch, the
  startup path is genuinely too slow → report it.

### G15 Auto-update mid-session reinstall → next-launch hang
- **Cause**: The shell detected a new version and ran `uv tool install flowpad@latest --force`
  (`uv-manager.js` `upgrade()`), or a desktop self-update landed. The freshly installed backend
  (often 100+ packages) then exceeds the 30 s health window on the *next* launch → G14 hang.
- **Detection** (`main_desktop` log): `"[update] desktop upgraded <old> → <new>"`, `"[uv] Upgrading
  flowpad..."`, `"[electron-updater] update downloaded"`, followed by a `waitForBackend` timeout.
  `uv tool list | grep flowpad` shows the new version; the `server` log shows a fresh first-boot.
- **Repair**: relaunch (install is done; the backend is warm now). If shell/backend versions are
  mismatched afterwards, see F13.

### G16 Shell can't install or run `flow` (first run / Windows Device Guard)
- **Cause**: First launch installs `uv` then `uv tool install flowpad`; this can fail (no network,
  PyPI down, install timeout) or, on **Windows**, the uv-generated `flow` shim is blocked by
  **Device Guard / WDAC**.
- **Detection** (`main_desktop` log): `"[uv] uv not found, installing..."` / `"uv install failed"`
  / `"uv install timed out after 120s"`; `"[uv] PyPI version lookup failed"`; `"flow CLI binary not
  found"`; **`"[uv] flow shim blocked by Windows Device Guard — falling back to \`uv tool run\`"`**;
  `"[uv] Failed to spawn flow start"`; `"Failed to start Python backend"`.
- **Repair**: network/PyPI issues → retry once online. Device Guard → the shell already falls back
  to `uv tool run --from flowpad flow start`; if that also fails, advise installing `uv tool install
  flowpad` manually. Don't fake a fix you can't verify.

### G17 Backend spawned but crashes / port not freed
- **Detection** (`main_desktop` log): `"[flow stderr]"` lines with errors; `"[uv] Port 9007 is in
  use, cleaning up..."` / `"[uv] Killed PID … on port 9007"` (overlaps **A1**); `"[uv] could not
  create backend cwd"`.
- **Repair**: per **A1/A2** (free the port / clear stale lock), then relaunch.

> Build-side desktop issues (unsigned installer, notarization, wrong-arch / broken auto-update
> manifests) are **D7/D8/E10–E12** — not fixable on the machine; advise + point at the
> `langware-labs/flowpad-desktop` CI.

---

## Architecture Quick Reference

| Item | Value |
|------|-------|
| Backend port | 9007 (hardcoded, no fallback) |
| Health endpoint | GET http://localhost:9007/health/status → `{"data":true}` |
| Electron startup timeout | 30 s (60 × 500 ms polls) — NEVER raise this |
| Log dirs | `~/.flow/logs/{server,monitor,main_desktop}/` |
| Default instance | `prod` |
| Instance data | `~/.flow/instances/<name>/{flowpad.db,server.lock,server.pid,server.json,backups/}` |
| Backend updater | `uv tool install flowpad@latest --force` |
| Electron updater | GitHub via electron-updater (latest-mac.yml / latest.yml / latest-linux.yml) |
| Hub (prod) | https://app.flowpad.ai (OPTIONAL — app works without it) |
