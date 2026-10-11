# Flowpad in the guest

> Invariants (inline by design): drive the guest with `scripts/vmrun.py` (user lane = what a real
> user gets, `-a` = elevated); the guest reaches the Mac at `10.0.2.2`; the VM is shared — leave
> other sessions' instances, ports and installs alone.

## What a clean image has

Windows, the agent, the clipboard agent — and **no** git, node, uv or Python (`python` resolves to
the Microsoft Store stub). That is the point: a from-scratch test must see what a new user sees.
When a test needs tools rather than testing their absence:

```powershell
irm https://astral.sh/uv/install.ps1 | iex          # uv (user lane)
irm https://claude.ai/install.ps1 | iex             # Claude Code (user lane)
```
`winget install --id Git.Git -e --scope machine --silent --accept-source-agreements --accept-package-agreements`
needs the **admin lane** (the user lane fails with "you cancelled the installation"). New tools
are not on an existing process's PATH — refresh PATH in the job (`control.md`) and restart any
backend that must see them.

## Three ways to install

| Goal | How |
|---|---|
| test the real user path | desktop installer: `curl.exe -L -o %TEMP%\Flowpad-Setup.exe https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-Setup.exe`, run with `/S`; lands in `%LOCALAPPDATA%\Programs\Flowpad` (x64 Electron, runs emulated) |
| test an unreleased build | on the Mac `python build_ui.py && uv build`, serve `dist/` (`network.md`), then in the guest install the wheel into a **fresh venv** (`uv venv --python 3.11 C:\flowpad-test\<inst>\venv`; `uv pip install --python <venv>\Scripts\python.exe <whl>`) |
| test `uv tool` behaviour without touching the real install | set `UV_TOOL_DIR` / `UV_TOOL_BIN_DIR` to a scratch folder for that job |

`Flowpad-Setup.exe` is a ~1 MB **launcher**, not the app: it downloads the real installer to
`%LOCALAPPDATA%\Flowpad\bootstrap\Flowpad-<ver>-Setup.exe` (progress in `flowpad-install.log`
beside it) and starts it. `/S` on the launcher returns at once with no app installed; if
`Programs\Flowpad\Flowpad.exe` has not appeared a few minutes later, run the downloaded
`Flowpad-<ver>-Setup.exe /S` yourself and wait for it — minutes under emulation.

The desktop app auto-updates and runs its own prod backend from the **same** `flowpad` uv tool:
stop `Flowpad.exe` and its python before `uv tool install --force`, or files are locked ("Access
denied") and the tool is left half-removed. A half-created venv folder makes uv refuse
("not a virtual environment") — use a new folder.

## The desktop app on an unreleased backend (deep links, `flowpad://`)

A venv instance cannot receive `flowpad://` — only the installed app owns the protocol, and a
packaged app always uses port 9007 (if another session's backend holds 9007, that is theirs:
ask, don't take it). To put unreleased code behind the real app:

1. Stamp the wheel ABOVE PyPI — `flow_sdk/_version.py` = `<PyPI latest>+local<N>` in a scratch
   worktree — then `build_ui.py && uv build --wheel`. A lower version makes the app offer the
   PyPI build over yours at every start.
2. App and its tool python stopped, then `cmd /c "uv tool install --force --python 3.11 <whl> 2>&1"`.
3. Start it from a job with the hub in the JOB's env — `$env:FLOWPAD_HUB_URL='http://localhost:8093'; Start-Process "$env:LOCALAPPDATA\Programs\Flowpad\Flowpad.exe"`.
   `setx` alone does not reach it (a job's environment is the agent's — `control.md`).
4. `scripts/expose-port.sh 9007` and wait for `http://127.0.0.1:19007/api/v1/graph/bootstrap` on
   the Mac; `…/api/v1/cloud/status` says which hub it talks to. First boot can take 15 minutes.

Deep links, and how to know one arrived:

- **Ground truth is the app's own log**: `%USERPROFILE%\.flow\logs\main_desktop\*` —
  `[deep-link] received: flowpad://…`, then `[nav]` lines for every page it loads. Count the
  receipts before and after; a screenshot of the app proves nothing about WHICH link moved it.
- `Start-Process 'flowpad://<path>?…'` (user lane) hands a link to the Windows handler — the same
  hop a browser makes after its prompt is accepted. Use it to test the app side alone.
- From a browser, the link waits at the browser's own prompt until Open is pressed (`network.md`).
- The handler is `HKCU\Software\Classes\flowpad\shell\open\command`, written when the app runs.

## Launching an instance

Start it detached and minimized from a job, with its own env:

```powershell
$env:FLOW_INSTANCE='<inst>'; $env:LOCAL_SERVER_PORT='<port>'; $env:FLOWPAD_HUB_URL='http://localhost:8093'
$env:FLOWPAD_SKIP_DOTENV='true'; $env:MINIHUB_RELOAD='False'; $env:FLOWPAD_SKIP_FIRST_RUN_SETUP='true'; $env:PYTHONUTF8='1'
Start-Process <venv>\Scripts\python.exe -ArgumentList '-m','flow_sdk.server.run' -WindowStyle Minimized `
  -RedirectStandardOutput C:\flowpad-test\<inst>\backend.log -RedirectStandardError C:\flowpad-test\<inst>\backend.err
```

- **Wait for `Uvicorn running` in the log instead of polling the port while it boots.** On
  Windows, a client that hangs up mid-accept could make the Proactor loop close the listening
  socket (`WinError 64`) — the process lives, the port is dead.
- Boot takes minutes on this VM; budget for it rather than raising timeouts.
- Hub login: the hub must look like localhost (`network.md`). Env-mode cloud login reads
  `FLOWPAD_CLOUD_USER_EMAIL` / `FLOWPAD_CLOUD_USER_PASSWORD` from the backend env and is
  triggered with an empty `POST /api/v1/cloud/login`; the first try right after boot can report
  "Cloud is not available" — retry once.
- To look like a separate machine/user, give the instance its own `USERPROFILE` folder.
- Expose the backend to the Mac with `scripts/expose-port.sh <port>` to test it from Mac tools.

## Expected slowness (not bugs)

x64 Electron and Python startup run under emulation on an 8 GB guest: backend boot ~3–4 min,
`flow` CLI cold start 10–70 s, `powershell` start 8–30 s, a Claude Code turn minutes. Judge a
"timeout" against these before filing it — and check the Mac isn't swapping (`operate.md`).

## Windows-only failure modes to look for

| Symptom | Cause | Check |
|---|---|---|
| `[WinError 3]` listing/unpacking under `%APPDATA%\uv\tools\…`; index aborts, wizards missing; later `git clone` `[WinError 2]` | MAX_PATH: `LongPathsEnabled=0` by default and deep shipped paths pass 260 chars | `reg query HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled`; measure the longest path in the install |
| git "Checking access…" forever; job lane blocked | Git Credential Manager waits on an invisible sign-in (`-c credential.helper=X` *appends* to the helper list) | `Get-Process git-credential-manager`; kill it from the other lane |
| `flow upgrade` says done, version unchanged — or the tool vanishes | pinned `flowpad==X` install makes upgrade a no-op; a running `flow.exe` can't be replaced | version before/after; `%TEMP%\flowpad-upgrade.log` |
| `UnicodeEncodeError` printing a banner when piped | stdout is cp1252 when not a console | rerun with `PYTHONUTF8=1` to confirm |
| remote command sits on "Preparing" | a `bash -c …`/POSIX-quoted command sent to `cmd.exe` | the command text in backend logs |
| messages out of order between Mac and guest | ordering by the sender's clock + guest clock skew | compare guest `Get-Date` with the Mac |
| backend port dead, process alive | Proactor `WinError 64` on a dropped accept | backend log; was something probing during boot? |
