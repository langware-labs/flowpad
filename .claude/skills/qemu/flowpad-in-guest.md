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

The desktop app auto-updates and runs its own prod backend from the **same** `flowpad` uv tool:
stop `Flowpad.exe` and its python before `uv tool install --force`, or files are locked ("Access
denied") and the tool is left half-removed. A half-created venv folder makes uv refuse
("not a virtual environment") — use a new folder.

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
