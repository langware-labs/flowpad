# Flowpad Known-Issue Catalog

Quick reference for the flow-diagnose skill. Each entry: cause, detection command(s) per
platform, repair class, and repair action or workaround.

---

## A. Runtime / Backend — AUTO-REPAIRABLE

### A1 Port 9007 occupied
- **Cause**: A previous backend process did not exit cleanly and is still holding the port.
- **Detection**:
  - macOS/Linux: `lsof -ti tcp:9007`
  - Windows: `netstat -ano | findstr :9007`
- **Repair**: `flow stop` → if still held, SIGTERM/SIGKILL (mac/linux) or `taskkill /PID <pid> /F` (win). Tell user to relaunch.

### A2 Backend unhealthy / failed to respond within 30 s
- **Cause**: Stale lock from dead PID, DB corruption, or disk full.
- **Detection**: `curl -fsS http://localhost:9007/health/status` → not `{"data":true}`.
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
- **Detection**: Open http://localhost:9007 → 404 errors on JS/CSS assets.
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
