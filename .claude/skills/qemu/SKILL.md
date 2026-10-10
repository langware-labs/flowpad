---
id: 29a89ec5-7e63-4e8b-9c1a-2f0b99fdde50
name: qemu
description: Create, reset, snapshot and drive the QEMU Windows 11 ARM test VM (quickemu
  on an Apple-silicon Mac), and install or test Flowpad inside it. Use when asked
  to test something "on Windows" or "in the VM", reset/reinstall/start/stop the Windows
  VM, take or restore a VM snapshot, run a command or open a URL in the guest, type
  or paste into it, fix its window size or clipboard, reach a guest port from the
  Mac (or a Mac service from the guest), or reproduce a Windows-only Flowpad bug.
  Cloud sandboxes are the e2b-builder skill's job, Docker rigs live with their own tests.
tags:
- qemu
- windows
- vm
- testing
---

# QEMU Windows test VM

One VM = one folder (`VM_DIR`, default `~/VMs/windows-11-arm`) plus `<name>.conf` next to it.
Every script in `scripts/` reads `VM_DIR`, so the same skill drives any VM laid out that way.

> Invariants (inline by design; each topic file repeats the ones it needs, with the why):
> the guest reaches the Mac at `10.0.2.2`; drive the guest with `scripts/vmrun.py` (queue server
> up — `scripts/start.sh`), not SSH or computer-use; snapshot/reset only with the VM off; the VM
> is shared — `scripts/qmp.py shot` + `vmrun.py --status` and ask before stopping or wiping it;
> runtime port forwards die with QEMU — re-run `scripts/expose-port.sh` after a restart.

## Routing

| When you need to… | Load |
|---|---|
| build a VM from nothing, or reinstall Windows unattended | `create.md` |
| start / stop / screenshot, window size, clipboard, snapshots & reset, host-side traps (disk full, swap, clock) | `operate.md` |
| run commands, click or type in the guest; the job rig's lanes, timeouts and failure modes | `control.md` |
| guest↔Mac ports, hub-must-be-localhost, file transfer, driving Edge over CDP | `network.md` |
| install / launch / log in Flowpad in the guest; Windows bugs to watch for | `flowpad-in-guest.md` |

## Symptom → where

| Symptom | Load |
|---|---|
| boot loop `INACCESSIBLE_BOOT_DEVICE`, Setup error `0x80070103-0x40031` | `create.md` |
| window stuck at 800×600, paste doesn't work, VM frozen / `paused (io-error)`, guest clock off | `operate.md` |
| `vmrun.py` hangs or a lane stops answering, exit code always 1, `0xc0000142` | `control.md` |
| Mac `curl` to a guest port returns `000`, guest can't log in to the hub | `network.md` |
| `WinError 3` / `WinError 2` on install or clone, `flow upgrade` no-op, git "Checking access…" hang | `flowpad-in-guest.md` |
| a `flowpad://` link "does nothing" in Edge, the app never opens from a page | `network.md` (the browser's prompt), `flowpad-in-guest.md` (the app's deep-link log) |
| a job returns nothing at all, `qmp.py click` changes nothing | `control.md` |

## Scripts

`start.sh` · `snapshot.sh NAME [--replace] [--boot]` · `reset.sh [SNAPSHOT] [--boot]` ·
`vmrun.py [-a] [-t SECS] 'ps'` · `qmp.py status|shot|key|type|click|wake` ·
`expose-port.sh GUEST_PORT [HOST_PORT] [--remove]` · `ui-invoke.ps1` (press a native dialog button
by name, via `vmrun.py -`) · `build-unattend.sh` ·
`quickemu-aarch64-windows.patch` · `windows-11-arm.conf.example` · `guest/` (answer file,
first-logon setup, agent). Shared settings live in `scripts/vm_env.sh`.
