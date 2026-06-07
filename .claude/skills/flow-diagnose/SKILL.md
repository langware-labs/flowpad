---
id: a3f7c821-4b2e-5d19-8e6f-1c9a0b3e7d52
name: flow-diagnose
description: >
  Diagnoses and auto-repairs Flowpad desktop/backend installation and runtime issues.
  Use when the user reports: Flowpad won't start, "Startup Error" dialog, "Backend server
  failed to respond", port 9007 conflict, blank page/404 assets, macOS "app is damaged",
  Windows SmartScreen warning, Linux AppImage won't launch, auto-update stuck or wrong arch,
  cloud/hub unreachable, version mismatch between Electron shell and Python backend.
  Accepts an optional pasted error string; without one runs a full diagnostic sweep.
  Keywords: flowpad, flow diagnose, startup error, port 9007, backend unhealthy,
  damaged app, update failed, instance not running, sodot, server.lock, blank page.

recommended_scope: project
---

# Flow Diagnose

Analyzes Flowpad installation and runtime issues, performs auto-repairs where safe on the
user's machine, explains build/CI-side problems with workarounds, and always ends with a
plain-language "To Summarize:" line.

## Instructions

### Step 1 — Detect platform, read optional error text

Detect OS first — all subsequent commands branch on this:

```
macOS:   uname -s → "Darwin"
Linux:   uname -s → "Linux"
Windows: $Env:OS  → "Windows_NT"  (PowerShell)
```

The input may be a **free-text description of a symptom** or a **verbatim pasted error** — treat
both the same. If any text was provided, go to Step 3 (classify it). If it was empty, run the full
sweep in Step 2.

### Step 2 — Full diagnostic sweep (no error text given)

Run ALL checks below, collect all results, THEN report. Do not stop at the first finding.

**2a. Port 9007**
```bash
# macOS/Linux
lsof -ti tcp:9007
# Windows (PowerShell)
netstat -ano | findstr :9007
```
Expected: empty (port free). Any PID = potential conflict.

**2b. Backend health**
```bash
curl -fsS http://localhost:9007/health/status
```
Expected: `{"data":true}`. Anything else or curl error = unhealthy.

**2c. Log tails** (newest file in each directory, last 20 lines)
```bash
# macOS/Linux — repeat for server, monitor, main_desktop
LOGDIR=~/.flow/logs/server
tail -20 "$(ls -t $LOGDIR/ | head -1 | xargs -I{} echo $LOGDIR/{})"
```
Look for: `record_error`, `integrity_check`, `EADDRINUSE`, `electron-updater`, `x64` on arm64.

**2d. Instance state**
```bash
ls ~/.flow/instances/
# For the prod instance:
ls ~/.flow/instances/prod/       # expect: flowpad.db, server.json (if running)
cat ~/.flow/instances/prod/server.pid 2>/dev/null
# Check if PID is alive:
# macOS/Linux: kill -0 <pid> 2>/dev/null && echo alive || echo dead
# Windows:     Get-Process -Id <pid> -ErrorAction SilentlyContinue
```

**2e. Version**
```bash
uv tool list | grep flowpad     # Python backend
# Electron version: grep the newest ~/.flow/logs/main_desktop/ file for "Starting Flowpad"
```

**2f. Disk space**
```bash
# macOS/Linux
df -h ~/.flow
# Windows (PowerShell)
Get-PSDrive C | Select Used,Free
```
Warn if < 500 MB free.

After collecting results, map each finding to the catalog in Step 3 and proceed to Step 4 or 5.

### Step 3 — Classify the symptom (semantic, open-ended)

Decide which known issue the user's text (or your sweep findings) best matches by **meaning** —
reason about intent. Do **NOT** string/regex match: wording varies and will change over time, and
you are an LLM that can understand a paraphrase. The known issues live in `references/catalog.md`
(entries A1–F13); here they are summarized by meaning so you know the menu:

- **A1** — backend port 9007 already in use / "address already in use".
- **A2** — backend unhealthy or "failed to respond" (stale lock, DB corruption, full disk).
- **A3** — an instance isn't running / no `server.json`.
- **A4** — secrets/keychain (sodot) can't be decrypted.
- **B5** — blank page / missing JS·CSS assets (pip wheel built without `build_ui.py`).
- **C6** — cloud/hub unreachable or token expired (**non-fatal** — the app is still healthy).
- **D7** — macOS "app is damaged / unidentified developer" (signing/notarization).
- **D8** — Windows SmartScreen / unknown publisher (unsigned installer).
- **D9** — Linux AppImage won't launch (FUSE missing).
- **E10** — Apple Silicon received the Intel build (auto-update manifest merge bug).
- **E11** — updates never detected (manifest version mismatch).
- **E12** — macOS auto-update broken (missing `.zip` / `.blockmap`).
- **F13** — Electron shell vs Python backend version drift.

Read `references/catalog.md` for each entry's exact detection + repair. If several apply, handle
**ALL**.

**The catalog is knowledge, not a fence.** If the symptom matches nothing above, do **not** give up
— go to **Step 5b (unrecognized issue)** and diagnose it generally.

### Step 4 — Auto-repairable entries: detect, repair, confirm

**Apply the fix yourself — but only when you safely can.** Run a repair only when BOTH hold:
(1) your diagnosis is confident and you know exactly what to do, and (2) it's a safe, reversible
fix you can perform on this machine (e.g. delete a stale `server.lock`/`server.pid` for a dead
PID, free port 9007, install FUSE). For the auto-repairable cases below, actually run the commands
— don't just recommend them. But if you're unsure of the cause, or the fix is the user's to make
(re-install, re-sign, cloud/account actions) — i.e. the Step 5 items — do NOT attempt it; describe
exactly what the user should do instead. Stay conservative and reversible — never destructive.

CRITICAL: Never suggest raising the 30-second health timeout or any other wait/retry/backoff
budget. The timeout is correct; fix the underlying stall or contention instead.

---

**A1 — Port 9007 occupied**

Repair:
1. Run `flow stop`.
2. Re-check port. If still held:
   - macOS/Linux: `kill -TERM <pid>` → wait 3 s → `kill -KILL <pid>` if still alive.
   - Windows: `taskkill /PID <pid> /F`
3. Report each PID killed and whether it was a Flowpad process or foreign.
4. Confirm port is free: re-run lsof/netstat. Tell user to relaunch Flowpad (do NOT auto-start).

---

**A2 — Backend unhealthy / failed to respond**

Work through sub-checks in order:

a) Stale lock from dead PID:
```bash
PID=$(cat ~/.flow/instances/prod/server.pid 2>/dev/null)
kill -0 "$PID" 2>/dev/null && echo "alive" || echo "dead"
```
If dead → delete `~/.flow/instances/prod/server.lock` and `server.pid`. Tell user to relaunch.

b) DB integrity: look for `record_error` or `integrity_check` in `~/.flow/logs/server/` newest file.
If corruption found → backend auto-recovers from `~/.flow/instances/prod/backups/` on next launch.
List backups: `ls -t ~/.flow/instances/prod/backups/`. Tell user to relaunch.

c) Disk space (from 2f). If < 500 MB free, that is likely the cause — tell user to free space.

d) If no specific cause found: tail the most recent server and monitor log lines and quote the
relevant error lines verbatim so the user can report them.

---

**A3 — Instance not running / no server.json**

Show: `ls ~/.flow/instances/` and `echo "FLOW_INSTANCE=${FLOW_INSTANCE:-prod}"`

- Desktop app: always uses "prod" — tell user to relaunch Flowpad.
- CLI user: tell them to run `flow start` (or `FLOW_INSTANCE=<name> flow start`).
- Do NOT auto-start a backend on behalf of the Electron desktop app.

---

**A4 — Sodot/secrets undecryptable**

Self-healing — `recover_orphaned_sodot` resets the secrets store on next launch automatically.
Tell user: any API keys stored in Flowpad need to be re-entered after restarting. No manual
file deletion needed or safe.

---

**B5 — Blank page / 404 on static assets (pip path)**

Repair:
```bash
uv tool install flowpad --force
# OR
pip install --force-reinstall flowpad
```
Then restart the backend. This is a packaging bug (wheel built without `build_ui.py` output).
Instruct user to file a report with the version number if it recurs on an official release.

---

**D9 — Linux AppImage / FUSE missing**

Detection:
```bash
ls /dev/fuse 2>/dev/null || echo "fuse missing"
ldconfig -p 2>/dev/null | grep libfuse || echo "libfuse not found"
```

Present BOTH options and ask user to choose — do NOT run sudo automatically:
- Option 1: `sudo apt-get install -y libfuse2`  (requires sudo)
- Option 2 (no sudo): `./Flowpad-*.AppImage --appimage-extract && ./squashfs-root/AppRun`

---

**F13 — Two-updater version drift**

Backend repair (user-side):
```bash
uv tool install flowpad@latest --force
```
Tell user to relaunch. Electron shell auto-updates on next launch if its manifest is correct;
if it does not, see E11/E12.

---

### Step 5 — Non-auto-repairable entries: explain + workaround + report

**C6 — Cloud/hub unavailable** (informational, not a broken install)

App is fully functional locally. Only sharing/sync/realtime degrade.
Expired token: backend auto-logs-out; user logs in again from Settings.
Hub unreachable on localhost:8093: the local hub process is not running (dev-only scenario).

---

**D7 — macOS "app is damaged / can't be opened"**

Problem class: signing/notarization failure in CI (langware-labs/flowpad-desktop repo).

Safe workaround (per-app only, does NOT disable system Gatekeeper):
```bash
xattr -dr com.apple.quarantine /Applications/Flowpad.app
```
Or: right-click Flowpad.app → Open → Open.

Report: file an issue at https://github.com/langware-labs/flowpad-desktop/issues with your
macOS version and Flowpad version. CI must use a valid Developer ID Application cert + notarize + staple.

---

**D8 — Windows SmartScreen / unknown publisher**

Problem class: missing Azure Trusted Signing credentials in CI — .exe ships unsigned.

Safe workaround: "More info" → "Run anyway" in the SmartScreen dialog.

Report: file an issue with Windows version and Flowpad version. CI must configure Azure Trusted Signing secrets.

---

**E10 — Apple Silicon receives Intel (x64) build**

Problem class: CI manifest merge bug — both arch builds overwrite the same `latest-mac.yml`.

Safe workaround: manually download the `arm64` .dmg from the GitHub Releases page.

Report: include Mac model ("M1/M2/M3"), Flowpad version, and the electron-updater log line
from `~/.flow/logs/main_desktop/` showing an `x64` artifact being downloaded on arm64.

---

**E11 — Updates never detected**

Problem class: version tag mismatch in CI manifest (`RELEASE_VERSION` override empty → falls
back to `package.json`). Backend: latest-mac.yml / latest.yml / latest-linux.yml manifest outdated.

Safe workaround: manually install the latest release from GitHub Releases.

---

**E12 — macOS auto-update broken**

Problem class: CI did not upload `.zip` + `.blockmap`; electron-updater on macOS uses the
`.zip`, not the `.dmg`, for differential updates.

Safe workaround: download and reinstall from the `.dmg` on the GitHub Releases page.

---

### Step 5b — Unrecognized issue (not in the catalog)

When the symptom matches no catalog entry, still diagnose it generally — don't bail:

1. **Gather evidence**: `curl -fsS http://localhost:9007/health/status`; the newest files under
   `~/.flow/logs/{server,monitor,main_desktop}`; instance state in `~/.flow/instances/<name>/`
   (`flowpad.db`, `server.lock`, `server.pid`, `server.json`); disk space.
2. **Reason** about the most likely root cause from that evidence.
3. **Attempt only a conservative, reversible repair** — never destructive (no DB deletes, no
   `xattr` on unrelated apps, no disabling Gatekeeper/SmartScreen system-wide). If unsure, do
   nothing and advise the user.
4. Mark the report **`status: unrecognized`** and recommend the user report it.

Never raise or add any timeout/retry/backoff to mask a symptom — fix the root cause or report it.

---

### Step 6 — Final output format

Always use this structure:

```
== Flowpad Diagnostic Report ==
Platform: <macOS / Windows / Linux>
Date:     <timestamp>

[FOUND] <issue title> — <FIXED | NEEDS USER ACTION | INFORMATIONAL>
  Detection: <what was checked>
  Action:    <what was done or recommended>

[OK] <check name> — no issues

To Summarize: <plain-language 1-3 sentence summary of findings and next step>
```

### Step 7 — Report to the app Feed (always runs; SDK-direct, no API)

After printing the report, persist it so it surfaces on the Home landing Feed. Use the SDK helper —
**never an HTTP API** (the backend may be down; this writes straight to the local instance DB):

```bash
flow diagnose-report \
  --summary "<one-paragraph plain summary: what was found + whether it was fixed + how>" \
  --status fixed|needs_action|informational|unrecognized \
  --platform "macOS|Windows|Linux" \
  --details "<the full == Flowpad Diagnostic Report == block from Step 6>"
```

This creates a hidden support Conversation + a summary message + a `new` Feed entry directly in the
local store, and prints JSON with the created ids — or `{"skipped": ...}` if the app hasn't
completed a first run (console-only is fine then). Do **not** fail the run if this step errors; the
console report from Step 6 still stands.

## Reference Files

- [Full known-issue catalog with detection commands](references/catalog.md)

## Examples

### Example 1: Full sweep — stale lock

**Input:**
```
flow diagnose
```

**Output:**
```
== Flowpad Diagnostic Report ==
Platform: macOS (Darwin)
Date: 2026-06-04 09:15:00

[FOUND] Stale server lock (A2) — FIXED
  Detection: server.pid held PID 4821; kill -0 4821 → dead
  Action:    Deleted ~/.flow/instances/prod/server.lock and server.pid.
             Please relaunch Flowpad.

[OK] Port 9007 — free
[OK] Disk space — 42 GB free
[OK] Cloud/hub — informational only (local app unaffected)

To Summarize: A leftover lock file from a previously crashed backend was preventing startup. It has been removed. Relaunch Flowpad and it should start normally.
```

### Example 2: macOS damaged-app error

**Input:**
```
flow diagnose "Flowpad is damaged and can't be opened. You should move it to the Trash."
```

**Output:**
```
== Flowpad Diagnostic Report ==
Platform: macOS (Darwin)
Date: 2026-06-04 09:20:00

[FOUND] macOS signing/notarization failure (D7) — NEEDS USER ACTION (build-side issue)
  Problem class: signing/notarization — originates in CI, not your machine
  Safe workaround:
    xattr -dr com.apple.quarantine /Applications/Flowpad.app
  Or: right-click Flowpad.app → Open → Open
  Please report your macOS version and Flowpad version at:
    https://github.com/langware-labs/flowpad-desktop/issues

To Summarize: This is a code-signing problem that happened during the build, not something wrong with your Mac. Running the xattr command above removes the quarantine flag so the app can open. Please also file a report so the CI team can fix signing for the next release.
```

### Example 3: Port conflict

**Input:**
```
flow diagnose "Error: listen EADDRINUSE: address already in use :::9007"
```

**Output:**
```
== Flowpad Diagnostic Report ==
Platform: Linux
Date: 2026-06-04 09:25:00

[FOUND] Port 9007 occupied (A1) — FIXED
  Detection: lsof -ti tcp:9007 → PID 7743 (python / flowpad backend)
  Action:    Ran `flow stop`; PID 7743 terminated via SIGTERM.
             Port 9007 is now free. Please relaunch Flowpad.

To Summarize: A stale Flowpad backend process was still holding port 9007. It has been stopped cleanly. Relaunch Flowpad and it should come up normally.
```
