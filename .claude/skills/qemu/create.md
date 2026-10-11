# Create or reinstall the VM

> Invariants (inline by design): the guest reaches the Mac at `10.0.2.2`; snapshot/reset only
> with the VM off; the VM is shared — screenshot + `vmrun.py --status` and ask before wiping it.

A from-zero build is hands-off once the pieces exist: about 45 minutes from empty disk to a
logged-in desktop with the agent polling. Every step below exists because skipping it cost hours.

## 1. Host tooling

- **quickemu** is not in Homebrew: `git clone https://github.com/quickemu-project/quickemu ~/.local/share/quickemu`,
  plus `brew install bash cdrtools coreutils jq qemu socat zsync`. It needs bash 5, so run it with
  `PATH=/opt/homebrew/bin:$PATH` when the login shell's bash is the macOS 3.2.
- **Apply `scripts/quickemu-aarch64-windows.patch`** (`git -C ~/.local/share/quickemu apply …`).
  Upstream quickemu assumes x86 for Windows and each of these crashes QEMU on an ARM guest:
  x86 CPU flags (`+hypervisor,+invtsc,l3-cache`), `ICH9-LPC.disable_s3`/`hpet`, `virtio-vga`
  (no VGA on ARM → the patch selects `ramfb`), and `-rtc driftfix=slew`. Pulling a new quickemu
  drops the patch; re-apply it.
- Free disk: the ISO is ~8.5 GB and the installed disk grows past 25 GB.

## 2. Windows ARM64 ISO and virtio drivers

- `quickget windows 11` fetches only the **x64** ISO, which would run fully emulated. Get the
  ARM64 ISO from `https://www.microsoft.com/software-download/windows11arm64` in a browser (scripted
  calls to Microsoft's download API are rejected); the link is valid 24 h. Download resumably and
  check the size before booting:
  `curl -L --fail -C - -o "$VM_DIR/windows-11-arm64.iso" "<link>"`.
- Drivers: `curl -L -o "$VM_DIR/virtio-win.iso" https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso`
  — each driver's ARM64 build sits at `<driver>/w11/ARM64/` in that ISO (`viostor`, `vioscsi`,
  `NetKVM`, `viogpudo`, `vioserial`, `Balloon`); `build-unattend.sh` copies exactly these.

## 3. Config and answer file

- Copy `scripts/windows-11-arm.conf.example` to `~/VMs/<name>.conf` (next to `VM_DIR`); its comments explain
  each `extra_args` item. `tpm`, `secureboot` and sound are off because Homebrew QEMU has no TPM
  for the ARM `virt` machine — the answer file bypasses the Windows 11 checks instead.
- Build the answer ISO: `WIN_TZ="<Windows tz id>" scripts/build-unattend.sh`. Set `WIN_TZ` to the
  Mac's zone: QEMU feeds the guest the Mac's local time, and NTP does not work over user
  networking, so a mismatched zone leaves the clock off by hours.
- `scripts/guest/autounattend.xml` does: LabConfig TPM/SecureBoot/RAM bypass, a wiped GPT disk,
  a generic (non-activating) Pro key to pick the edition, `BypassNRO` + hidden online-account
  pages, local admin `flowpad` with a blank password and autologon, and on first logon
  `setup-vm.ps1` (agent tasks, no sleep/lock screen, spice-vdagent for the clipboard).

### Boot-disk driver injection — the part that breaks

The system disk is virtio-blk, so Windows needs `viostor` both **during Setup** and **in the
installed image**. Get both with this recipe (it is what the shipped answer file does):

1. `windowsPE` RunSynchronous: `drvload` viostor + vioscsi from the USB CD **and** `xcopy` them
   to `X:\vdrv` (the WinPE RAM disk — the only path guaranteed to exist).
2. An `offlineServicing` pass with `Microsoft-Windows-PnpCustomizationsNonWinPE` DriverPaths
   `X:\vdrv` — this injects them into the applied image before its first boot.

Why not the alternatives: `drvload` alone lets Setup see the disk, but the installed system then
boot-loops with `INACCESSIBLE_BOOT_DEVICE (0x7B)`; a `pnputil` in `specialize` runs too late (after
that first boot). `PnpCustomizationsWinPE` DriverPaths makes 24H2 Setup abort with
`0x80070103 - 0x40031` before partitioning. To rescue an already-looping install, boot the
installer, press Shift+F10, and run `dism /image:C:\ /add-driver /driver:<CD>:\drivers /recurse`, where `<CD>` is the drive
letter WinPE gave the unattend CD (`dir D:\drivers`, `E:\drivers`, … to find it).

## 4. Install

This wipes the VM's disk. When reinstalling an existing VM, first `scripts/qmp.py shot` and
`scripts/vmrun.py --status`: a live desktop or recently polling lanes mean someone may be using
it — ask, and offer `scripts/snapshot.sh <name>` to keep their state before you start.

Keep a pristine copy of the UEFI vars quickemu creates on the very first launch
(`cp OVMF_VARS.fd OVMF_VARS.fd.bak`); a reinstall starts from it, because stale vars keep boot
entries pointing at the old disk.

```bash
export VM_DIR=~/VMs/<name>                            # every script below reads it
sed -i '' 's|^#iso=|iso=|' ~/VMs/<name>.conf          # attach the Windows ISO
cp "$VM_DIR/OVMF_VARS.fd.bak" "$VM_DIR/OVMF_VARS.fd"  # reinstall only: pristine UEFI vars
scripts/start.sh --no-wait
for i in $(seq 1 12); do scripts/qmp.py key ret; sleep 0.5; done   # "Press any key to boot from CD"
```

Press Enter only for those first ~6 seconds: once Setup's UI is up its focused button is
**Cancel**, and later presses abort the install. Check progress with `scripts/qmp.py shot`; the
UEFI logo can sit for minutes — growth of `disk.qcow2` over 30 s tells working from stuck.
Setup reboots several times; when both agent lanes check in (`vmrun.py --status`) it is done.
Then comment `iso=` out again, verify (`vmrun.py '$PSVersionTable; Get-PnpDevice -PresentOnly | ? Status -ne OK'`
— devices reporting "Code 28" with IDs like `ACPI\LNRO0005` are QEMU virtio-mmio stubs that
no Windows driver claims; ignore them), and take the baseline: `scripts/snapshot.sh clean-win11 --boot`.

## Older images: Sysprep dialog at logon

A VM built by hand that reached the desktop through audit mode (Ctrl+Shift+F3 at the account
page) shows a **System Preparation Tool** dialog at every logon. Click **Cancel** (`qmp.py click`):
OK runs sysprep and sends Windows back to first-run setup.
