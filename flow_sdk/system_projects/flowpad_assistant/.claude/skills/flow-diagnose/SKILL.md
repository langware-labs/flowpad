---
id: a3f7c821-4b2e-5d19-8e6f-1c9a0b3e7d52
name: flow-diagnose
description: >
  Diagnoses and auto-repairs Flowpad desktop/backend installation and runtime issues.
  Use when the user reports: Flowpad won't start or open, the app is **stuck on "Starting…"**,
  "Startup Error" dialog, "Backend server failed to respond", port 9007 conflict, blank page/404
  assets, macOS "app is damaged", Windows SmartScreen warning, Linux AppImage won't launch,
  auto-update stuck or wrong arch, cloud/hub unreachable, version mismatch between Electron shell
  and Python backend. Covers Electron desktop-app startup issues (the shell), not just the backend.
  Accepts an optional pasted error string; without one runs a full diagnostic sweep.
  Keywords: flowpad, flow diagnose, won't open, stuck on starting, startup error, port 9007,
  backend unhealthy, electron, desktop app, damaged app, update failed, instance not running,
  sodot, server.lock, blank page.

recommended_scope: project
---

# Flow Diagnose

Analyzes Flowpad installation and runtime issues, performs auto-repairs where safe on the
user's machine, explains build/CI-side problems with workarounds, and always ends with a
plain-language "To Summarize:" line.

## Operating rules

- You run **autonomously and headless** — you **CANNOT ask the user any questions** and no human
  will reply mid-run. Never pause for confirmation or input. Make the most reasonable assumption,
  proceed, and note the assumption in the report.
- Do the **whole job in one go** and do not end your turn until it's done:
  diagnose → root cause → prove it → fix (when safe) → validate → end-to-end check → record.
- Apply fixes yourself only when safe **and** capable (Step 4); otherwise advise the user (Step 5).
- **Read the logs — they are primary evidence.** The **`flowpad_logs`** skill is the authoritative
  list of every Flowpad log location: the backend instance logs
  (`~/.flow/instances/<name>/logs/`), the **Electron desktop app** logs
  (`~/.flow/logs/{main_desktop,monitor,server}/`), and the local hub. Scan the logs it lists when
  looking for whether there IS an issue **and** when establishing the root cause — never conclude
  "healthy" from a live health check alone (the shell can be stuck even when the backend is up).
- Never raise or add any timeout/retry/backoff/poll budget to mask a symptom.

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

**Resolve the ports first — do NOT hardcode them** (instances vary; only examples below use
literals). Backend port: read it from the instance's `server.json`, falling back to
`$LOCAL_SERVER_PORT`, then the packaged-desktop default `9007`:

```bash
PORT=$(python3 -c "import json,os,pathlib; inst=os.environ.get('FLOW_INSTANCE','prod'); p=pathlib.Path.home()/'.flow'/'instances'/inst/'server.json'; print(json.load(open(p))['port'] if p.exists() else os.environ.get('LOCAL_SERVER_PORT','9007'))")
```

Frontend dev-server port: `${VITE_PORT:-4097}`. Use `$PORT` / `$VITE_PORT` in every URL and port
check below. (The packaged desktop app uses `9007` and serves the UI on that same port.)

### Step 2 — Full diagnostic sweep (no error text given)

Run ALL checks below, collect all results, THEN report. Do not stop at the first finding.

**2a. Backend port ($PORT, default 9007)**
```bash
# macOS/Linux
lsof -ti tcp:$PORT
# Windows (PowerShell): $PORT resolved as above
netstat -ano | findstr ":$PORT"
```
Expected: empty (port free). Any PID = potential conflict.

**2b. Backend health**
```bash
curl -fsS http://localhost:$PORT/health/status
```
Expected: `{"data":true}`. Anything else or curl error = unhealthy.

**2c. Log tails** (newest file in each directory, last 20 lines)
Consult the **`flowpad_logs`** skill for the full, authoritative list of log locations and scan
**all** of them — backend instance logs, the Electron desktop logs, and the hub. At minimum:
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

**2g. Electron desktop app startup (ALWAYS check — even if the backend is healthy)**
The Electron shell waits only **30 s** for the backend; it can be stuck on "Starting…" or have shown
a "Startup Error" even though the backend is healthy *now*. Read the newest `main_desktop` log and
reason about the shell↔backend timeline:
```bash
# macOS/Linux — newest main_desktop log, last ~40 lines
LOGDIR=~/.flow/logs/main_desktop
tail -40 "$(ls -t $LOGDIR/ | head -1 | xargs -I{} echo $LOGDIR/{})"
# Windows (PowerShell)
Get-Content (Get-ChildItem $HOME\.flow\logs\main_desktop\*.log | Sort LastWriteTime -Desc | Select -First 1) -Tail 40
```
Look for: `Waiting for backend` **without** a following `Backend is ready!`; `Backend failed to
start within timeout`; `[startup error details]`; `[update] desktop upgraded` / `[uv] Upgrading
flowpad...` / `[electron-updater] update downloaded`; `flow shim blocked by Windows Device Guard`;
`[flow stderr]` errors; `Failed to spawn flow start`. These map to **G14–G17** even when the backend
currently reports healthy.

After collecting results, map each finding to the catalog in Step 3 and proceed to Step 4 or 5.

### Step 3 — Classify the symptom (semantic, open-ended)

Decide which known issue the user's text (or your sweep findings) best matches by **meaning** —
reason about intent. Do **NOT** string/regex match: wording varies and will change over time, and
you are an LLM that can understand a paraphrase. The known issues live in `references/catalog.md`
(entries A1–G17); here they are summarized by meaning so you know the menu:

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
- **G14** — **Electron app stuck on "Starting…"** / backend health-check timed out (shell gives up at
  30 s even though the backend becomes healthy moments later). Often the answer to "won't open" /
  "stuck on Starting".
- **G15** — auto-update mid-session reinstalled the backend; next launch exceeds the 30 s window → G14.
- **G16** — shell can't install/run `flow` (first-run `uv`/PyPI failure, or Windows Device Guard
  blocks the shim).
- **G17** — backend spawned but crashed / port not freed by the shell.

Read `references/catalog.md` for each entry's exact detection + repair. The **G-series** is found
in the `main_desktop` logs (Step 2g) — check it even when the backend is currently healthy, since a
"won't start / stuck on Starting" is usually an Electron↔backend *timing* problem, not a dead
backend. If several apply, handle **ALL**.

**The catalog is knowledge, not a fence.** If the symptom matches nothing above, do **not** give up
— go to **Step 5b (unrecognized issue)** and diagnose it generally.

### Step 4 — Repair: root cause → prove → fix → validate

For each issue you intend to fix, work through these four sub-steps and **show your evidence** in
the output — never jump straight from symptom to guess:

1. **Root cause.** Identify the actual underlying cause, not the surface symptom — e.g. not
   "backend not responding" but "a stale `server.pid` points to dead PID 17268, so startup aborts".
2. **Prove it.** Back the root cause with concrete evidence — prefer the **on-disk logs** (use the
   `flowpad_logs` skill to find every log location): a specific log line, a command output, or a
   small reproduction showing that this cause produces this symptom (e.g. `main_desktop` log shows
   `Backend failed to start within timeout` while the `server` log shows the backend became healthy
   10 s later; or `kill -0 17268` → dead and `curl …/health/status` → connection refused). If you
   cannot prove it from evidence, say so and treat it as unrecognized (Step 5b) — do not fix on a hunch.
3. **Fix** — but ONLY when safe and you're capable: (a) your diagnosis is confident, and (b) it's a
   safe, reversible fix you can perform on this machine (e.g. delete a stale
   `server.lock`/`server.pid`/`server.json` for a dead PID, free port 9007, install FUSE). Actually
   run the commands — don't just recommend them. If the fix is the user's to make (re-install,
   re-sign, cloud/account actions) or is risky/destructive, do NOT attempt it — describe exactly
   what the user should do (Step 5).
4. **Validate.** Re-run the exact check that exposed the problem and show it now passes (e.g.
   `curl -fsS …/health/status` → `{"data":true}`, the port is free, the stale file is gone).

CRITICAL: Never suggest raising the 30-second health timeout or any other wait/retry/backoff
budget. The timeout is correct; fix the underlying stall or contention instead.

The per-issue repair details (A1–G17) below are the **"how"** for the Fix sub-step:

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

1. **Gather evidence**: `curl -fsS http://localhost:$PORT/health/status`; the newest files under
   `~/.flow/logs/{server,monitor,main_desktop}`; instance state in `~/.flow/instances/<name>/`
   (`flowpad.db`, `server.lock`, `server.pid`, `server.json`); disk space.
2. **Reason** about the most likely root cause from that evidence.
3. **Attempt only a conservative, reversible repair** — never destructive (no DB deletes, no
   `xattr` on unrelated apps, no disabling Gatekeeper/SmartScreen system-wide). If unsure, do
   nothing and advise the user.
4. Mark the report **`status: unrecognized`** and recommend the user report it.

Never raise or add any timeout/retry/backoff to mask a symptom — fix the root cause or report it.

---

### Step 5c — End-to-end validation (headless Playwright)

After repairing, prove the **app actually works end-to-end** — not just that one check passed. Do
this headlessly and autonomously (no questions):

1. **Ensure the backend is up.** If your fix was meant to unblock startup, start it now
   (`flow start`, or `uv run -m flow_sdk.server.run` in the background) and wait for
   `curl -fsS http://localhost:$PORT/health/status` to return `{"data":true}` (`$PORT` resolved in
   Step 1).
2. **Drive the UI with Playwright (headless, Chromium).** Use the copy already in `ui/`
   (`@playwright/test`). If the browser binary isn't installed, install it once:
   `cd ui && npx playwright install chromium`.
3. **Check the app launches:** navigate to the app URL — the backend serves the UI at
   `http://localhost:$PORT` (the Vite dev server, if running, is at `http://localhost:${VITE_PORT:-4097}`)
   — and assert the page renders (the home landing mounts, `body` has content, no fatal console error).
4. **Check the specific issue is resolved:** assert the symptom the user described (or you found) is
   gone — e.g. the app reaches the home screen instead of a blank page/error; the affected feature
   now works.
5. Implement this as a tiny throwaway headless Playwright script run with node; capture pass/fail.

If end-to-end validation genuinely doesn't apply (a macOS signing / Windows SmartScreen /
auto-update issue that can't be exercised locally, or the app truly can't be launched on this
machine), **skip it and say why** — never fake a pass.

Record the validation outcome (passed / failed / skipped + why) in the Step 6 report and the Step 7
summary. If validation fails, the issue is NOT fixed — set the report status to `needs_action`.

### Step 6 — Final output format

Always use this structure:

```
== Flowpad Diagnostic Report ==
Platform: <macOS / Windows / Linux>
Date:     <timestamp>

[FOUND] <issue title> — <FIXED | NEEDS USER ACTION | INFORMATIONAL | UNRECOGNIZED>
  Root cause: <the underlying cause, not the symptom>
  Proof:      <evidence this is the cause (command output / log line / repro)>
  Action:     <what you did (if fixed), or exactly what the user must do>
  Validation: <the check you re-ran + its result>

[OK] <check name> — no issues

End-to-end: <headless Playwright check — passed | failed | skipped (reason)>

To Summarize: <plain-language 1-3 sentence summary of findings and next step>
```

### Step 7 — Record the result (ALWAYS runs — even when everything is healthy)

**You MUST run the reporter script every single time, no matter the outcome — including a fully
healthy, no-issue, no-action-needed result.** "Everything is fine" is NOT a reason to skip this step:
a `flowpad_diagnosis` record is created for every diagnostic run (that is how the run is considered
complete). Do **not** end your turn until the script has printed its JSON. Skipping this step makes
the whole run count as failed.

The script is the SDK, **not** an HTTP API — it opens the local instance DB itself, so it works even
when the backend is DOWN. Run the reporter that ships **next to this SKILL.md** (`report.py` in this
skill directory); do **not** hand-build any entities and do **not** import from `flow_sdk`.

You do not decide whether to post a Feed entry — **`report.py` decides that from `--status`**. You
just always run it with the right status:

1. It **always** creates a `flowpad_diagnosis` record from your `title / symptoms / rca / fix`.
2. If you found an issue (`--status` is `fixed`, `needs_action`, or `unrecognized`) it also posts the
   diagnosis to the Home Feed (hidden support Conversation + summary `flow_message` with the diagnosis
   attached + a `message_suggest` `feed_entry`) so the user can send it to support in one click.
3. If the sweep was clean (`--status ok`) or the only findings are benign (`--status informational`),
   it records the diagnosis for history but creates **no** Feed entry. **Use `--status ok` for a
   healthy result — and still run the script.**

(The `flow diagnose` runner cross-links the diagnosis to this process for you afterwards — do **not**
attempt the cross-link yourself.)

```bash
uv run python "<this skill dir>/report.py" \
  --title "<short diagnosis title>" \
  --symptoms "<what was observed>" \
  --rca "<root cause, or 'none — healthy' if no issue>" \
  --fix "<what you did / what the user should do, or 'none needed'>" \
  --summary "<one-paragraph plain summary>" \
  --status fixed|needs_action|unrecognized|informational|ok \
  --platform "macOS|Windows|Linux" \
  --details "<the full == Flowpad Diagnostic Report == block from Step 6>"
```

`<this skill dir>` is the folder this SKILL.md is in — the same path you were given to read it from.
Use `--status ok` when everything is healthy and no issue was found. It prints a JSON line including
`diagnosis_id` (and the Feed ids when a Feed entry was posted).

Do not end your turn before the reporter script has printed its JSON. Do **not** fail the whole run if
this step errors; the console report from Step 6 still stands.

## Reference Files

- [Full known-issue catalog with detection commands](references/catalog.md)
- `report.py` — the SDK-direct reporter this skill runs in Step 7 (Conversation + FlowMessage + FeedEntry).

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
  Root cause: A previous backend (PID 4821) crashed, leaving server.lock/server.pid
              behind; the singleton guard sees the lock and aborts every new start.
  Proof:      server.pid → 4821; `kill -0 4821` → dead; `curl …/health/status` → refused.
  Action:     Deleted ~/.flow/instances/prod/server.lock and server.pid.
  Validation: Started the backend; `curl …/health/status` → {"data":true}.

[OK] Port 9007 — free
[OK] Disk space — 42 GB free
[OK] Cloud/hub — informational only (local app unaffected)

End-to-end: passed — headless Playwright loaded http://localhost:9007; the home
            landing rendered (no blank page, no fatal console error).

To Summarize: A leftover lock file from a crashed backend was blocking startup. I removed it, restarted the backend, and confirmed via a headless browser check that the app now loads normally.
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
