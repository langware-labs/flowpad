---
id: 53b909b8-40b1-447a-a968-a209f49c458b
version: 2
---
# Windows test VM

A UTM Windows VM at `192.168.64.2`, used to try a dev build of Flowpad on a clean Windows machine.
It was rebuilt on 2026-10-05, so the old `Tzahi` user and `~/.ssh/id_ed25519` key no longer work.

## Connect

```bash
ssh -i ~/.ssh/winclean2 -o IdentitiesOnly=yes "test 11"@192.168.64.2
```

* The user is `test 11` — **with a space**, so it must be quoted.

* The key is `~/.ssh/winclean2`.

* The remote shell is `cmd.exe`. Run a single command by passing it as the last argument.

* `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED` means the VM was reinstalled. Run
  `ssh-keygen -R 192.168.64.2` and connect again.

## Copy files

```bash
scp -i ~/.ssh/winclean2 -o IdentitiesOnly=yes <file> "test 11@192.168.64.2:C:/Users/Public/<file>"
```

Ship anything longer than a one-liner as a `.ps1` file and run it with
`powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Public\<file>.ps1`.
Inline quoting over ssh breaks easily.

## Install a dev build

Flowpad on the VM is a `uv tool` install of a local wheel, `C:\Users\Public\flowpad-0.2.999-py3-none-any.whl`.

1. **Build the wheel** with the version set to `0.2.999`. Change `flow_sdk/_version.py` only for the build
   and restore it afterwards.

   ```bash
   rm -rf build dist/*.whl          # a stale build/ leaks removed modules into the wheel
   uv run python build_ui.py
   sed -i '' 's/<current>/0.2.999/' flow_sdk/_version.py
   uv build --wheel
   git checkout flow_sdk/_version.py
   ```

2. **Copy it** to `C:/Users/Public/` with `scp` (above).

3. **Install and relaunch** with a script run on the VM:

   ```powershell
   Get-Process Flowpad -ErrorAction SilentlyContinue | Stop-Process -Force
   Get-CimInstance Win32_Process -Filter "name='python.exe'" |
     Where-Object { $_.CommandLine -like '*uv\tools\flowpad*' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   Start-Sleep 2
   & "$env:USERPROFILE\.local\bin\uv.exe" tool install --force --reinstall "C:\Users\Public\flowpad-0.2.999-py3-none-any.whl"

   # An ssh session cannot start a GUI app directly; use an interactive scheduled task.
   $a = New-ScheduledTaskAction -Execute "C:\Users\test 11\AppData\Local\Programs\Flowpad\Flowpad.exe"
   $p = New-ScheduledTaskPrincipal -UserId "test 11" -LogonType Interactive
   Register-ScheduledTask -TaskName FlowpadRelaunch -Action $a -Principal $p -Force | Out-Null
   Start-ScheduledTask -TaskName FlowpadRelaunch
   Start-Sleep 5
   Unregister-ScheduledTask -TaskName FlowpadRelaunch -Confirm:$false
   ```

4. **Check the backend** — it listens on port 9007:

   ```powershell
   Invoke-WebRequest -UseBasicParsing http://localhost:9007/api/v1/graph/bootstrap
   ```

   Expect `200` within about 10 seconds. If it does not come up, read the newest file under
   `C:\Users\test 11\.flow\instances\prod\logs\server\`.

## Useful checks

```bash
ssh -i ~/.ssh/winclean2 -o IdentitiesOnly=yes "test 11"@192.168.64.2 "uv tool list"
ssh -i ~/.ssh/winclean2 -o IdentitiesOnly=yes "test 11"@192.168.64.2 "tasklist | findstr /i Flowpad"
```

