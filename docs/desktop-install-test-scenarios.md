---
id: aa640578-a177-4c25-ad4a-d07f00265128
---
# Desktop install — test scenarios

Manual and scripted scenarios for the three changes that came out of the
"Startup Error: Command failed: uv tool install flowpad --python 3.10 --force"
failure:

1. The Python pin is read from `pyproject.toml` (`requires-python` floor), not hand-written.
2. A failed install/start shows the in-app panel with **Retry** instead of a native error box that quits.
3. The release gate runs the desktop's exact first-launch install in a clean room (`scripts/validate_uv_tool_install.sh`).

Section E covers the Windows uninstaller (FLOWPAD-2250).

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

---

## E. Windows uninstall

The uninstaller removes only what FlowPad Desktop provably owns and nothing else uses, keeps your data unless you choose otherwise, and says exactly what it did.

The pieces:

- **`flow-rs uninstall`** ([`flow_sdk/rust/src/uninstall/`](../flow_sdk/rust/src/uninstall/)) decides what may go and deletes it.
- **`electron/resources/installer.nsh`** is the NSIS page, run and finish page around it.
- **The desktop app and the engine** write the evidence it reads:
  - [`electron/engine-ownership.js`](../electron/engine-ownership.js), the engine's ownership record;
  - `runtime-repair.js`, the `.flowpad-owned` marker in the repaired runtime;
  - [`flow_sdk/cli/cli_use.py`](../flow_sdk/cli/cli_use.py), the `.cli_used` stamp;
  - `server.json` `launched_by` and `monitor_create_time`.

The rules each scenario relies on:

- **The engine goes by default** only when the desktop installed it and nothing else uses it. When the command line uses it, or its origin is inferred or uncertain, removing it needs consent. An engine the desktop adopted, did not install, or that is shared is kept, with the reason.
- **Data is never deleted by default.** Deleting it takes an unchecked box plus a confirmation that defaults to No. An instance the command line also uses is never offered.
- **Processes are stopped only on verified association** with a desktop-launched server. Never by name, never by interpreter, never by port.
- **Deletion goes by handle and never follows a junction or symlink.** Evidence files go last; ACLs are never overridden.
- **An item in use is scheduled for the next sign-in** through a one-shot RunOnce. The scheduled run re-proves every item from disk before deleting it.
- **Nothing runs during an update** (`--updated`, which electron-builder passes on every install over an existing copy).

Exit codes of `flow-rs uninstall`:

| Code | Meaning |
|---|---|
| `0` | Complete |
| `10` | The rest is scheduled for the next sign-in |
| `20` | Something was kept or could not be removed |
| `124` | The deadline was hit |

The finish page and `%TEMP%\flowpad-uninstall.log` say which items, and why.

### How to run

| What | Where | Command |
|---|---|---|
| Unit tests (decisions, receipt, process selection, cleanup state, report) | any OS | `cargo test --manifest-path flow_sdk/rust/Cargo.toml --lib uninstall` |
| Evidence writers | any OS | `cd electron && node engine-ownership.test.js && node runtime-repair.test.js`; `pytest tests/unit/test_uninstall_ownership_evidence.py` |
| Installer script rules | any OS | `cd electron && node builder-config.test.js` |
| Deletion on NTFS, process snapshot | Windows | `cargo test --manifest-path flow_sdk/rust/Cargo.toml --test fs_delete --test proc_scan` |
| End to end against a scratch tree | Windows | `cargo build --manifest-path flow_sdk/rust/Cargo.toml --bin flow-rs`, then `scripts\win_uninstall_e2e.ps1` |
| All of the above on `windows-latest` | CI | the `uninstaller (flow-rs + installer.nsh, windows)` job. It also builds the installer, so an `installer.nsh` mistake fails it (NSIS warnings are errors) |

Notes on the end-to-end script and the CI job:

- **The script needs a debug build.** Only debug builds honour `FLOWRS_TEST_LAYOUT_ROOT`, which redirects every user folder into the scratch tree, and `FLOWRS_TEST_ALLOW_UNSIGNED`. It never touches a real installation.
- **It needs a desktop session for the deferred cleanup.** That keeps its key in the Credential Manager, which an ssh or service session does not have, so those scenarios report SKIP there and never PASS.
- **The CI runner is an administrator in a service session.** Run the standard-user and desktop-session cases on a Windows VM:
  - run the script, and the `fs_delete` / `proc_scan` test executables, as the signed-in user through a one-shot task (`schtasks /Create … /RL LIMITED /IT`);
  - drive the GUI cases (E3, E6) by hand or with Win32 messages. UI Automation sees the x86 NSIS controls only as panes on an ARM64 VM.

### Silent uninstall and the manual cleanup command

`"Uninstall Flowpad.exe" /S` removes the app and only what goes by default. These switches stand in for the page's choices:

| Switch | Equivalent to |
|---|---|
| `/REMOVEENGINE` | Ticking "Also remove the FlowPad engine" (only when it is offered) |
| `/DELETEAPPDATA` | Ticking "Delete FlowPad Desktop settings, cache and desktop logs" |
| `/DELETEDATA` | Both data boxes (instance data only where it would be offered) |

A switch never deletes what the page would not offer.

A cleanup left pending runs:

- at the next sign-in;
- before the first launch of the next FlowPad install;
- or by hand: `"%LOCALAPPDATA%\Flowpad\fc\flow-rs.exe" deferred-cleanup --trigger manual`.

Its progress is in `%LOCALAPPDATA%\Flowpad\fc\status.log`, which reads scheduled → executed → verified.

### E1 — Desktop-installed engine, default uninstall

**Preconditions:** an engine the desktop installed (`engine-ownership.json` `origin: desktop`), no instance without `.desktop_managed`, no `.cli_used`, `global/cli-stamp-since` present, the app running.

**How:** `win_uninstall_e2e.ps1` "desktop-exclusive engine" (scratch tree); a Windows VM for the running app.

**Pass:**

- **Exit 0**, summary "FlowPad was removed."
- **Removed:**
  - the venv, `flow.exe` / `flow-sdk-mcp.exe` and the set-aside `flowpad.pre-repair`;
  - `engine-ownership.json`, the repaired runtime and `desktop-runtime.json`;
  - the install marker, the launcher downloads, the updater cache and `%TEMP%\flowpad-*` leftovers.
- **Untouched:** `uv.exe` / `uvx.exe`, other uv tools, and files in those folders that FlowPad did not create.
- **The app** (`$INSTDIR\Flowpad.exe`) is stopped by `flow-rs app-running --stop`.

### E2 — Default uninstall keeps every piece of data

**How:** the script (every scenario without an opt-in flag); on a VM, compare the file count of `~/.flow` before and after.

**Pass:** `~/.flow` and `%APPDATA%\Flowpad` are unchanged, except `desktop-install-in-progress.json` (always removed) and `desktop-runtime.json` (removed only with its runtime).

### E3 — Data scope and the confirmation

**How:** the script "opt-in" and "CLI-used" scenarios; the page on a VM.

**Pass:**

- **(a)** `--delete-app-data` removes `%APPDATA%\Flowpad` and `~/.flow/logs/main_desktop`.
- **(b)** `--delete-instance-data` removes a desktop-managed instance with no `.cli_used`, and `global/` once no instance is left.
- **(c)** An instance with `.cli_used` is never offered and is kept even with the flag.
- **(d)** Instances without `.desktop_managed` are never offered.
- **(e)** On the page:
  - both data boxes start unchecked, and each names its exact folders and sizes;
  - the confirmation lists them and its default button is **No**;
  - No unticks the boxes and deletes nothing;
  - the button that starts the removal reads "Uninstall".

### E4 — A file in use

**How:** the script "a file in use" (needs a desktop session).

**Pass:**

- **(a) Scheduled:**
  - exit 10;
  - the receipt (the ownership proof) is kept while anything is left;
  - the runtime waits behind the engine;
  - `HKCU\…\RunOnce` points at the helper copy in `%LOCALAPPDATA%\Flowpad\fc`.
- **(b–c) Executed and verified:** after the holder closes, `deferred-cleanup` exits 0; engine, runtime and both records are gone; the helper removes itself; the RunOnce value is gone.
- **(d) Manual, VM:** with `DisableCurrentUserRunOnce` set, nothing is scheduled and the outcome is Partial.
- **(e) Manual:** a helper path that would make the command longer than 259 characters is not scheduled.

### E5 — The repaired runtime

**How:** `classify.rs` unit tests `a_marked_runtime_goes_with_its_engine`, `a_legacy_runtime_needs_the_exact_folder_and_a_psf_signature` and `a_link_is_never_proven_even_with_a_matching_token`; the script "desktop-exclusive engine".

**Pass:** a runtime folder is removed only when all of these hold:

- its engine goes;
- no other uv tool's `pyvenv.cfg` points into it;
- its `.flowpad-owned` token matches `desktop-runtime.json`, or, for a pre-marker repair, it is the exact recorded `python-<version>` folder with a PSF-signed `python.exe`.

An unsigned look-alike, a wrong token, or a junction is kept and reported.

### E6 — Update, then uninstall

**How:** a Windows VM:

1. Install a build.
2. Run `Flowpad-Setup.exe --updated /S` of another build over it.
3. Uninstall.

**Pass:**

- The old uninstaller is started with `--updated` (`isUpdated=1`), also on a manual reinstall: `old-uninstaller.exe /S /KEEP_APP_DATA /currentuser --updated`.
- Nothing but the app files is touched, and `flowpad://`, the venv and `~/.flow` remain.
- The later real uninstall behaves as E1/E2.

### E7 — Reinstall after uninstall

**How:** `engine-ownership.test.js` (a first install records `origin: desktop`); a Windows VM.

**Pass:** the first launch installs the engine and records `origin: desktop`, and the app starts normally.

### E8 — Something else listens on port 9007

**How:** `procs.rs` unit test `port_9007_alone_selects_nothing`.

**Pass:** a listener on the port is never selected unless it is the verified server itself.

### E9 — Process identification

**How:** `procs.rs` unit tests; `proc_scan.rs` on Windows (creation time equals psutil's `create_time()`, verified to the microsecond).

**Pass:**

- **(a)** The desktop tree is verified: the app, the monitor, the server, and its `flow_sdk` workers.
- **(b)** A process on the shared interpreter with no chain to the server is untouched.
- **(c)** A non-FlowPad child of the server (an agent CLI, a shell) is left running and reported.
- **(d–f)** A stale `server.json`, a reused pid, or a create-time mismatch selects nothing.
- **(g–h)** A server not launched by the desktop is left running, and marks the engine shared.
- **(i)** Only `$INSTDIR\Flowpad.exe` is matched as the app; a `Flowpad.exe` in another folder is not.

### E10 — Running it twice

**How:** the script "desktop-exclusive engine", second run.

**Pass:** exit 0, and nothing more is removed.

### E11 — A partial or damaged installation

**How:** `classify.rs` unit tests (no venv is `absent`; an unreadable record or receipt is never trusted); (d) and (e) on a Windows VM.

**Pass:**

- **(a)** No engine: nothing to remove, no error.
- **(b)** A corrupt record or receipt: the engine is kept.
- **(c)** uv is not needed: the engine is removed by flow-rs, not by `uv tool uninstall`.
- **(d) Manual:** `flow-rs.exe` missing from the installation: only the app and `flowpad://` go, and the finish page says the engine, runtime and data were kept.
- **(e) Manual:** `flow-rs.exe` blocked by policy has the same result as (d).

### E12 — Upgrade from the last released version

**How:** a Windows VM: install the latest release, then the new build over it.

**Pass:** the released version's uninstaller runs with `--updated`; the engine, runtime, `~/.flow` and `flowpad://` survive. The new desktop's first launch backfills `engine-ownership.json` as `legacy-inferred` or `adopted`, never `desktop`.

### E13 — Silent mode

**How:** the script passes the flags `flow-rs` receives; `builder-config.test.js` checks the switch parsing; a VM for `/S` itself.

**Pass:**

- `/S` alone removes what goes by default and nothing offered.
- `/REMOVEENGINE`, `/DELETEAPPDATA` and `/DELETEDATA` each match their box.
- A switch never deletes what would not be offered.

### E14 — Junctions, symlinks and races

**How:** `fs_delete.rs` on Windows, as an administrator and as the signed-in user; the script "junction".

**Pass:**

- **(a–b)** A junction at the root, or above it, is refused, and nothing under it is touched.
- **(c)** Links inside the tree are removed as links, and their targets are byte-identical.
- **(d)** A hard link to an outside file leaves that file intact.
- **(e)** A held root cannot be moved.
- **(f)** An 8.3 short path is the same root.
- **(g)** A folder swapped for a junction mid-deletion never reaches the junction's target (200 iterations, a swap landing mid-run in most of them).
- **(h)** A junction planted at a runtime folder is not followed, and is reported (outcome Partial).

### E15 — Who owns the engine

**How:** `classify.rs` unit tests (every sharing signal keeps the engine and is named); `engine-ownership.test.js`; the script "shared" and "CLI-used".

**Pass:**

| The engine is… | Result |
|---|---|
| Without a record (independently installed) | Kept, no opt-in |
| `adopted` (installed over one the desktop found) | Kept, no opt-in |
| Changed after the desktop installed it (receipt or identity differs) | Kept as shared |
| Carrying an extra `--with` package | Kept as shared |
| Used by an instance without `.desktop_managed` | Kept as shared |
| Run by an independently started server | Kept as shared |
| `legacy-inferred`, or CLI stamping not yet active | Kept unless the user opts in |
| Desktop-made with `.cli_used` | Kept unless the user opts in |

FlowPad's Claude Code hooks (`--name=flowpad_sniffer`) are removed with the engine. If they cannot be confirmed gone, the engine is kept, so Claude Code is never left calling a missing `flow`.

### E16 — The pending cleanup is checked, never trusted

**How:** `state.rs` unit tests; the script "a tampered cleanup state"; `fs_delete.rs` `remove_self_refuses_a_directory_put_in_its_place`.

**Pass:**

- **(a)** A pending cleanup completes and verifies (see E4).
- **(b)** A folder recreated before the next sign-in (a new file identity) is not touched.
- **(c)** A modified `state.json` is refused and nothing is deleted.
- **(d)** An old state replayed after a completed run is refused: its key was deleted.
- **(e)** A root whose ownership proof (receipt, marker) is gone is skipped.
- **(f) Manual:** a reinstall before the sign-in: the sign-in run stands down, and the new installer finishes the cleanup.
- **(g)** A cleanup still blocked at sign-in does not re-register itself; the next installer or the manual command finishes it.
