---
id: aa640578-a177-4c25-ad4a-d07f00265128
---
# Desktop install — test scenarios

Manual and scripted scenarios for the three changes that came out of the
"Startup Error: Command failed: uv tool install flowpad --python 3.10 --force"
incident (desktop v0.2.44):

1. The Python pin is read from `pyproject.toml` (`requires-python` floor), not hand-written.
2. A failed install/start shows the in-app panel with **Retry** instead of a native error box that quits.
3. The release gate runs the desktop's exact first-launch install in a clean room (`scripts/validate_uv_tool_install.sh`).

Each scenario lists its preconditions, steps, and the exact pass criteria. IDs
are stable so a run report can reference them.

Conventions used below:

- `<pin>` is the `>=` floor of `requires-python` in `pyproject.toml` (today `3.11`).
- "Desktop log" is the newest file under `~/.flow/logs/main_desktop/` (macOS/Linux) or `%USERPROFILE%\.flow\logs\main_desktop\` (Windows).
- "Sandboxed home" means launching the app with `HOME` (macOS/Linux) or `USERPROFILE` (Windows) pointed at an empty folder, so the app sees no uv, no tool venv, no Python. On macOS this cannot be combined with an already-running Flowpad: the single-instance lock is keyed on the account, not on `HOME`, so quit the real app first.

---

## A. Python pin comes from pyproject.toml

### A1 — Unit: parser and runtime value agree with the repo file

**Preconditions:** repo checkout.

**Steps:**

```bash
cd electron && node uv-manager.test.js
```

**Pass:** the run reports all assertions passed, including
`PYTHON_VERSION == repo requires-python floor` and the parser cases
(`>=3.11` → `3.11`, `>=3.12,<3.14` → `3.12`, `>= 3.11.2` → `3.11`, missing key throws, no `>=` floor throws).

### A2 — Packaged app reads the bundled copy, not the repo

**Preconditions:** an unpacked build (`npx electron-builder --mac --dir`, or the platform equivalent).

**Steps:**

1. Confirm `pyproject.toml` sits in the app's resources folder (macOS: `Flowpad.app/Contents/Resources/pyproject.toml`; Windows/Linux: `resources/pyproject.toml`).
2. Load the shell's module from inside the package and print the pin. macOS example:

   ```bash
   ELECTRON_RUN_AS_NODE=1 release/mac-arm64/Flowpad.app/Contents/MacOS/Flowpad \
     -e "console.log(require(process.resourcesPath + '/app.asar/uv-manager.js').PYTHON_VERSION)"
   ```

**Pass:** the file exists, and the printed value equals `<pin>`.

### A3 — Pin follows a change to requires-python

**Steps:**

1. Temporarily edit `pyproject.toml` to `requires-python = ">=3.12"`.
2. Run A1.
3. Revert the edit.

**Pass:** step 2 reports `PYTHON_VERSION` as `3.12` with no code change in `electron/`. The `--python` argument in the desktop log (see B1) follows the same value if an install is run.

### A4 — Build fails loudly when the floor is missing

**Steps:**

1. Temporarily change `requires-python` to `"==3.11.*"`.
2. Run `node -e "require('./electron/uv-manager.js')"` from the repo root.
3. Revert.

**Pass:** step 2 throws with a message naming `requires-python` and the missing `>=` floor. It must not fall back to any default version.

### A5 — First launch with an existing Python of the pinned minor

**Preconditions:** a machine with Python `<pin>.x` installed in a location the app scans (Homebrew or python.org framework on macOS; python.org installer, Store, or winget on Windows), sandboxed home, network available.

**Steps:** launch the app; watch the status line and the desktop log.

**Pass:**

- The log shows `uv tool install flowpad --python <pin> --force`.
- No `Downloading cpython-…` line appears: uv reused the existing interpreter.
- The app reaches the main UI.

### A6 — First launch with no Python at all

**Preconditions:** sandboxed home, no Python on PATH or in the registry (a fresh VM is the honest version of this).

**Pass:** the log shows `Downloading cpython-<pin>.…`, then the wheel install, then the main UI. The existing system state is untouched: nothing new under `/usr/local`, `Program Files`, or the user's own Python installs.

### A7 — Existing Python of a different minor is not used

**Preconditions:** only Python 3.12 or 3.13 installed, sandboxed home.

**Pass:** uv downloads a managed `<pin>` interpreter rather than building the venv on the other minor. The venv's `python --version` under the uv tools dir reports `<pin>.x`.

### A8 — Build without the bundled pyproject.toml still launches a healthy install

**Preconditions:** an unpacked build from which `pyproject.toml` has been deleted from the resources folder (simulates a broken build), on a machine with a healthy flowpad install.

**Steps:**

1. Launch the app.
2. Then, on a sandboxed home (no install), launch again.

**Pass:**

- Step 1 reaches the main UI. The pin is only resolved by an install, so the missing file must not stop a launch that takes the fast path.
- Step 2 shows the failure panel before any `uv tool install` runs. The detail says the build is missing its bundled pyproject.toml and to reinstall the desktop app. The recovery command shown omits `--python` rather than inventing a version.
- Nothing in the app ever falls back to a hard-coded Python version.

Scripted equivalent (no build needed): copy `electron/uv-manager.js` and `electron/semver.js` to a folder with no `../pyproject.toml`, `require` the copy, and check that loading does not throw, `tryPythonVersion()` is `null`, `upgradeCommand()` has no `--python`, and `getPythonVersion()` throws naming pyproject.toml.

---

## B. Failed install shows a retryable panel

### B1 — Install failure renders the panel with Retry

**Preconditions:** sandboxed home. Make the package index unreachable so the install fails quickly and deterministically:

```bash
UV_DEFAULT_INDEX=http://127.0.0.1:9/simple UV_INDEX_URL=http://127.0.0.1:9/simple <launch the app>
```

**Pass:**

- No native OS error dialog. The loading window shows the "Flowpad couldn't start" panel.
- The detail's first line is `Command failed: uv tool install flowpad --python <pin> --force`.
- The detail includes either `Exit code N.` or `The process was killed (SIGNAL).`, and a `Last output:` block with the last lines uv printed.
- Both **Quit** and **Retry** buttons are visible. The upgrade command shown uses `<pin>`.
- The app is still running (not quit). The desktop log contains `[startup error details]` with the full dump (HOME, PATH, stderr tail).

### B2 — Retry re-runs the install in place

**Preconditions:** B1 state on screen.

**Steps:** click **Retry** while the index is still unreachable.

**Pass:**

- The panel hides, the spinner returns, the status reads `Retrying`, then the normal install status lines (`Setting up Flowpad (first time)`, `Installing Flowpad — …`).
- The desktop log contains `[startup] retry requested from the error panel` followed by a second `uv tool install` run.
- The panel reappears with the new failure. Retry is still available. No relaunch happened (same PID).

### B3 — Retry succeeds once the cause is fixed

**Preconditions:** B1 was produced by a real network condition you can restore (Wi‑Fi off, a blocked proxy, a captive portal), not by the env override, since env cannot change mid-run.

**Steps:** restore the network, click **Retry**.

**Pass:** the install completes without a relaunch and the main UI loads. Everything uv had already downloaded before the failure is not downloaded again (the second run's log shows fewer or no `Downloading` lines for the same wheels).

### B4 — Quit from the panel

**Steps:** in B1 state, click **Quit**.

**Pass:** the app exits cleanly; no orphan `uv` or `flow` process remains (`pgrep -f "uv tool install"` and `pgrep -f flow_sdk.server.run` are empty).

### B5 — Backend timeout panel has no Retry

**Preconditions:** a working install whose backend cannot come up. Simplest: occupy the backend port with any listener before launching, or point the app at a `flow` shim that exits immediately.

**Pass:** the same panel appears with the timeout wording, and **Retry is hidden**. Only Quit is shown. This is the pre-existing recovery path and must be unchanged.

### B6 — Panel renders multi-line detail

**Preconditions:** any B1 state.

**Pass:** line breaks in the detail are preserved (one item per line, not a single run-on paragraph), long lines wrap rather than overflow, and the two copy buttons still copy their commands.

### B7 — Killed install is reported as killed, not as a uv error

**Preconditions:** B-style launch, but kill uv from outside mid-download:

```bash
pkill -TERM -f "uv tool install flowpad"
```

**Pass:** the panel detail says `The process was killed (SIGTERM).` and the `Last output:` block contains only progress lines with no `error:` line. This is the exact trace of the original incident, now labelled correctly.

### B8 — Slow install is not killed by the app

**Preconditions:** throttle the network to roughly 1 MB/s (Network Link Conditioner on macOS, `tc` on Linux, NetLimiter or a throttled proxy on Windows), sandboxed home.

**Pass:** the install runs for well over two minutes and completes. The status line keeps updating with uv's progress lines the whole time. No panel, no `killed` in the log. (The app has no wall-clock cap on the install; only uv's own no-data timeout can end it.)

### B9 — Windows: install on a machine with Defender scanning enabled

**Preconditions:** Windows with real-time protection on, sandboxed profile.

**Pass:** same as B8. Antivirus scanning of unpacked wheels lengthens the install but must not cause a panel.

---

## C. Release gate: clean-room uv tool install

### C1 — Gate passes on a published version

**Preconditions:** repo checkout, `uv` installed, network. Run from the repo root on purpose.

**Steps:**

```bash
scripts/validate_uv_tool_install.sh flowpad==<latest on PyPI>
```

**Pass:**

- Output starts with `Spec:`, `Python: <pin>`, `Sandbox: <temp dir>`.
- uv downloads a managed Python (`Downloading cpython-<pin>…`) even if the machine has one: the gate never borrows a system interpreter.
- `✓ venv interpreter is Python <pin>` and `✓ installed flowpad <version>`.
- validate_install.sh reports all critical checks passed, including `Server started`.
- Any Python warning paths printed during the server boot point inside the sandbox's `site-packages`, never into the repo checkout.
- Exit code 0. The temp dir is gone afterwards, and nothing new appears under `~/.flow/instances/` or `~/.local/share/uv/`.

### C2 — Gate passes on a local wheel

**Steps:**

```bash
python3 build_ui.py && uv build
scripts/validate_uv_tool_install.sh dist/flowpad-<version>-py3-none-any.whl
```

**Pass:** as C1, with `✓ installed flowpad <version>` matching the wheel's version. (Discard the regenerated locale catalogs afterwards if they show as modified.)

### C3 — Gate fails when the pin cannot satisfy the package

**Steps:**

1. Temporarily set `requires-python = ">=3.10"` in `pyproject.toml` (so the gate pins 3.10).
2. Run C1 against the latest published version.
3. Revert.

**Pass:** the gate exits non-zero. Either uv refuses the resolution, or it resolves an older release and the gate fails on `✗ installed flowpad X, expected Y`. The deploy must not be able to pass this silently. This reproduces the v0.2.44 drift.

### C4 — Gate does not collide with a running backend

**Preconditions:** your own Flowpad backend running (desktop app open, or `flow start`).

**Steps:** run C1.

**Pass:** the server boot inside the gate still reports `Server started`. The log must not contain `[singleton] Server already running`. Your running backend is unaffected.

### C5 — Gate never imports the repo checkout

**Steps:** run C1 from the repo root, then compare with a run from `/tmp`.

**Pass:** both runs pass identically, and no repo file changes (`git status` clean before and after). A run that imported the checkout would show the checkout's paths in warnings and could stamp frontmatter ids into repo markdown files.

### C6 — Gate is wired into the deploy

**Steps:**

```bash
grep -n "validate_uv_tool_install.sh" scripts/deploy_to_github.sh
```

**Pass:** the call appears after the `Validating PyPI package` step, inside the publish branch, and a non-zero exit from it makes the deploy `exit 1`. A `--no-pypi` run does not reach it.

### C7 — Windows: gate runs under Git Bash

**Preconditions:** Windows with Git for Windows and uv; no `python3` command on PATH.

**Steps:** run C1 in Git Bash.

**Pass:** the gate runs without invoking any host Python (the pin is parsed with grep/sed), finds `bin/flow.exe` and `tools/flowpad/Scripts/python.exe` in the sandbox, passes uv Windows-style paths, and reaches the same result as C1. Removal of the temp dir succeeds at the end.

### C8 — Gate fails when the floor is missing

**Steps:** as A4 but run the gate instead.

**Pass:** exits with code 2 and a message naming `requires-python` and the missing `>=` floor, before any uv call.

---

## D. Regression checks after a desktop release

### D1 — Upgrade path from v0.2.44

**Preconditions:** a machine that has the shipped v0.2.44 with a tool venv built on Python 3.10.

**Steps:** install the new desktop build and launch.

**Pass:** the pre-start update prompt offers the backend upgrade; accepting it runs `uv tool install flowpad@latest --python <pin> --force`, the venv is rebuilt on `<pin>`, and the app reaches the main UI. `~/.local/share/uv/tools/flowpad/bin/python --version` reports `<pin>.x`.

### D2 — Fast path unchanged

**Preconditions:** a healthy install.

**Pass:** launching the app does not run `uv tool install` at all (no such line in the desktop log) and the main UI loads within the normal time.
