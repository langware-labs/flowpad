# Control the guest

> Invariants (inline by design): the guest reaches the Mac at `10.0.2.2`; drive it with
> `scripts/vmrun.py` (needs `vmq_server.py` up — `scripts/start.sh`); the VM is shared — other
> jobs may be queued or the user may be at the keyboard.

## What does not work, and why (so you skip it)

| Tried | Why it fails |
|---|---|
| computer-use on the QEMU window | QEMU is a bare Homebrew binary with no app bundle id — access can't be granted |
| HMP `mouse_move` / `mouse_set` | relative moves; the guest's USB tablet ignores them |
| OpenSSH (`hostfwd 22220`) | service sshd closes the session right after auth (blank-password admin); user-session sshd hangs in Windows Terminal; reconnect loops trip OpenSSH 10's per-source penalty |
| osascript keystrokes on the Mac | land in whatever app is frontmost — never type blind on the host |
| `Start-Process -WindowStyle Hidden` in the guest | child dies with `0xc0000142`; use `-WindowStyle Minimized` |

## The job rig (`vmrun.py`)

The guest can always reach the Mac, so the Mac queues jobs and the guest polls:
`vmq_server.py` (Mac `127.0.0.1:$VMQ_PORT`, default 8766) ↔ `C:\vmagent\agent.ps1` (two logon
scheduled tasks). Run:

```bash
scripts/vmrun.py 'Get-Process msedge | select Id,MainWindowTitle'   # user lane: normal token, like a real user
scripts/vmrun.py -a 'winget install --id Git.Git -e --scope machine --silent --accept-source-agreements --accept-package-agreements'   # admin lane: elevated
scripts/vmrun.py -t 1800 - < script.ps1                               # script from stdin, 30-min cap
scripts/vmrun.py --status                                             # seconds since each lane last polled
```

- **Pick the lane deliberately.** User-lane results are what a real user gets (installers that
  need elevation fail there with "you cancelled the installation"); system changes (winget
  machine installs, firewall, portproxy, `Set-Date`) go to `-a`.
- **Each job is a fresh PowerShell process**, so environment never leaks between jobs; the exit
  code passes through to `vmrun.py`. Its PATH is the agent's logon-time PATH, so tools installed
  later are missing: prefix jobs with
  `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`.
- **Three timeouts stack:** the agent kills the job tree at `-t` (exit -1); `vmrun.py` waits for
  it; the Bash tool caps at 600 s — for long jobs run `vmrun.py` in the background. If the Mac side
  gives up first, the job keeps running in the guest.
- **One job per lane at a time.** A job that waits on invisible UI (a sign-in, a credential
  prompt — e.g. Git Credential Manager) blocks every job behind it. Unblock from the other lane:
  `vmrun.py -a 'taskkill /F /T /IM git-credential-manager.exe'`.
- **A dead agent** (lanes stop polling): `qmp.py key meta_l-r`, `qmp.py type 'powershell -ExecutionPolicy Bypass -WindowStyle Minimized -File C:\vmagent\agent.ps1\n'`,
  or reboot the guest (the logon tasks start both lanes).
- **Updating `agent.ps1` in the guest:** a job that restarts its own agent never returns its result
  — write the new file (base64 it in; `attrib -r` first, files copied from the install CD are
  read-only), submit `Restart-Computer -Force` without waiting for it (`curl -X POST --data '…' 'localhost:8766/submit?lane=admin'`),
then poll `vmrun.py --status` until both lanes report a few seconds.
- Job scripts land in `C:\vmagent\jobs\` — delete them after a job that carried a secret.

## PowerShell 5.1 in the guest

- `Invoke-WebRequest`/`Invoke-RestMethod` need `-UseBasicParsing`; set
  `$ProgressPreference='SilentlyContinue'` or downloads crawl.
- After `Start-Process -PassThru`, touch `$null = $p.Handle` before waiting, or `ExitCode` is null.
- Nested quoting (PowerShell → `python -c` → JSON) loses quotes; write a `.ps1`/`.py` file and run it.
- Native tools writing progress to stderr (uv) become errors under `$ErrorActionPreference='Stop'`;
  wrap them: `cmd /c "uv … 2>&1"`.
- A bare `powershell` start costs ~8 s (`-NoProfile`) to ~30 s on this VM — batch work into one job.

## Screen input

- **Keys:** `qmp.py key <combo>` (HMP `sendkey` names: `ret`, `esc`, `tab`, `meta_l-r`,
  `ctrl-alt-delete`); `qmp.py type 'text'` sends ~10 keys/s — faster drops characters.
- **Clicks:** `qmp.py click X Y` in screenshot pixels (QMP absolute axes; needs the conf's `-qmp`).
- **Typing into a GUI app from a job** (no coordinates needed): user lane,
  `$w=New-Object -ComObject WScript.Shell; $w.AppActivate((Get-Process msedge | ? MainWindowTitle | select -First 1).Id); $w.SendKeys('text{TAB}more{ENTER}')`
  — `+ ^ % ~ ( ) { } [ ]` are SendKeys syntax. Confirm with a screenshot every time: focus can move.
- Prefer a job over clicks whenever a command can do it — clicks depend on layout and focus.
