# Operate the VM

> Invariants (inline by design): snapshot/reset only with the VM off; the VM is shared —
> screenshot + `vmrun.py --status` and ask before stopping it; `hostfwd_add` forwards die with
> QEMU, so re-expose ports after any restart.

## Start, stop, look

- **Start:** `scripts/start.sh` — starts `vmq_server.py` if it isn't answering, launches the VM
  from its parent folder (quickemu paths are relative to it), and waits until both agent lanes
  poll. After a Mac reboot the queue server is gone too; `start.sh` covers both.
- **Stop gracefully:** `vmrun.py -a 'Stop-Computer -Force'` (what `snapshot.sh` does). HMP `quit`
  is a power cut — fine before a reset, unsafe otherwise.
- **Look:** `scripts/qmp.py shot out.png`, then read the PNG. Screenshots are cheap; take one
  before and after anything that changes the screen. A stale-looking shot (old clock) → shoot again.
  A black screen is display sleep: `qmp.py wake`.
- **State:** `scripts/qmp.py status` (`running`, `paused (io-error)`, …).
- **Sockets:** HMP text monitor `$VM_DIR/<name>-monitor.socket` (quickemu always opens it — keys,
  screendump, `hostfwd_add`, `info usernet`); QMP `$VM_DIR/qmp.socket` exists only when the conf
  adds `-qmp unix:…` (needed for absolute clicks). An old hand-made `launch-qmp.sh` (raw qemu line
  copied from quickemu's generated `.sh`) is a frozen copy — it misses later `extra_args` like the
  clipboard channel; prefer quickemu + the conf.

## Window size

Windows on this VM has no GPU driver in use; it draws on `ramfb`, fixed at **800×600**. Two levers:
- **Scale the window:** `-display cocoa,zoom-to-fit=on` at the end of `extra_args` (QEMU takes the
  last `-display`), then drag the window corner. The setting resets on every QEMU start unless it
  is in the conf. Text is a soft upscale.
- **Real resolution:** replace `ramfb` with `virtio-gpu-pci` (the ARM64 `viogpudo` driver is in
  the virtio pack and staged by the unattend install). Needs a quickemu patch change and a
  re-taken snapshot; untested here.

## Clipboard

Shared both ways once two pieces exist: the conf's `virtio-serial-pci` + `-chardev
qemu-vdagent,…,clipboard=on` + `virtserialport …name=com.redhat.spice.0`, and in the guest the
SPICE agent (`spice-vdagent-x64` MSI — no ARM64 build; x64 runs emulated; service `spice-agent`).
Paste in the guest with **Ctrl+V**. When a test writes the Mac clipboard (`pbcopy`), save and
restore the user's content around it (`OLD=$(pbpaste)` … `printf %s "$OLD" | pbcopy`).

## Snapshots

Internal qcow2 snapshots hold the disk only; UEFI vars are a separate raw file, so every snapshot
gets a matching `OVMF_VARS.<name>.fd` copy.
- **Take:** `scripts/snapshot.sh NAME [--replace] [--boot]` — powers off gracefully, snapshots,
  copies the vars, runs `qemu-img check`. A name holds one state; `--replace` overwrites it.
- **Restore:** `scripts/reset.sh [NAME] [--boot]` (default `clean-win11`) — discards everything
  since that snapshot.
- **List (even while running):** `qemu-img snapshot -l -U "$VM_DIR/disk.qcow2"`.
- Keep a `clean-win11` with nothing but Windows + agent + clipboard: every "test from scratch"
  starts there in seconds instead of a 45-minute reinstall.

## Host-side traps

- **Mac disk full → VM pauses** (`qmp.py status` says `paused (io-error)`). The qcow2 grows with
  every guest write and never shrinks on its own. Free Mac space, then HMP `cont`. Copying big
  trees (venvs, `robocopy` of repos) inside the guest is the usual cause — install from wheels
  instead.
- **Mac swapping → VM freezes:** QEMU's resident memory collapses, the guest clock stops, process
  starts take tens of seconds and checks time out falsely. With an 8 GB guest, close memory hogs
  before testing and before blaming the code for slowness (`memory_pressure`, QEMU RSS in `ps`).
- **Guest clock:** QEMU gives the guest the Mac's *local* time and NTP does not work over user
  networking. Keep the guest zone equal to the Mac's (`Set-TimeZone -Id '<Windows tz id>'`) and
  correct drift in the admin lane: `Set-Date -Date ([DateTime]::Parse('<Mac UTC ISO time>').ToLocalTime())`.
  Clock skew matters for anything ordered by timestamp across machines.
