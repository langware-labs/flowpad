---
id: 01cbc022-128b-4df5-8ef5-837cdb499570
---

# Fresh-Mac QA with Tart

A QA session that installs FlowPad the way a real user does — download from
flowpad.ai, install, launch — needs a Mac that has never seen FlowPad. Your dev
Mac cannot be that machine, and neither can a rented shared account: both carry
`~/.flow/` and a login keychain that has accumulated state from every prior build.

[Tart](https://tart.run/) runs macOS VMs on Apple silicon via Apple's
Virtualization.framework. A clone of a pristine base image is a genuinely fresh
Mac, produced in ~0.04s at zero disk cost (APFS copy-on-write), and thrown away
after the session.

## Why fresh matters here

The install validation in `install-flowpad-test-build` turns on whether
`Flowpad.ai.sod_key` in the keychain lists `flow-rs` as a trusted application and
*not* `python3.12`, and whether the Account attribute reads `prod.flow-rs` rather
than the legacy `prod`.

On a dirty Mac that test is close to worthless: the keychain item already exists
with an ACL accreted from earlier runs, so a migration that silently no-ops still
looks correct — the right answer is already sitting there. On a fresh VM the item
does not exist, so you observe it being **created** with the right ownership.
Same for `~/.flow/` bootstrapping, first-launch profile creation, and Gatekeeper
evaluating the quarantine bit on a genuinely downloaded build.

## One-time setup

```bash
brew install cirruslabs/cli/tart
tart clone ghcr.io/cirruslabs/macos-tahoe-vanilla:latest flowpad-qa-base
```

Homebrew gates `cirruslabs/cli` as an untrusted tap. Grant per-formula trust
rather than blanket-trusting the tap (`tart` pulls in `softnet` as a dependency):

```bash
brew trust --formula cirruslabs/cli/tart
brew trust --formula cirruslabs/cli/softnet
```

The pull is ~25 GB and takes a while. Transient layer timeouts auto-retry.

### Why `-vanilla`

Images come in `-vanilla` (base system only), `-base` (developer tools), and
`-xcode` (full Xcode). **Use `-vanilla.`** A real user's Mac has no `uv`, no
Homebrew, and no Xcode Command Line Tools. Preinstalling them into the base hides
exactly the missing-prerequisite bugs the session exists to find.

The corollary is a standing rule: **never install anything into the base.** Every
convenience added makes it less like a user's Mac, and a clean-install test that
runs on a not-clean machine has quietly stopped testing anything.

## Verified baseline

`flowpad-qa-base` was probed on first build and confirmed:

| Property | Value |
| --- | --- |
| macOS | 26.5 Tahoe (build 25F71) |
| Boot to network | ~10s |
| Credentials | `admin` / `admin`, SSH enabled |
| `~/.flow` | does not exist |
| `Flowpad.ai.sod_key` | not in keychain |
| `uv`, `brew` | not installed |
| Disk | 50 GB virtual, ~27 GB actual |

`/usr/bin/git` and `/usr/bin/python3` do exist, but they are Apple's stub shims —
invoking them without Command Line Tools installed pops the "install developer
tools" dialog rather than running. That is genuinely what a user's Mac looks like;
leave it alone.

## Running a QA session

```bash
tart clone flowpad-qa-base qa-run    # ~0.04s, zero additional disk
tart run qa-run                      # opens a GUI window; log in admin / admin
```

Then, inside the VM, the actual user journey:

1. Safari → flowpad.ai → Download
2. Install, launch, complete cloud login
3. Open **Keychain Access**, search `Flowpad.ai.sod_key`
4. **Access Control** must list `flow-rs`, and must **not** list `python3.*`
5. **Attributes** → Account should read `prod.flow-rs`, not `prod`
6. Confirm no `python3.12 wants to use your confidential information` dialog appears

Tear down when finished:

```bash
tart delete qa-run
```

The base is untouched, so the next clone is another untouched Tahoe.

## Gotchas

**Do the keychain check in the GUI, not over SSH.** An SSH session runs in a
different security context where the login keychain is not unlocked the way a real
desktop session's is. `security find-generic-password` over SSH can report
misleading results. Use Keychain Access in the VM's own desktop session.

**Apple caps you at 2 running macOS VMs per host.** This is a sequential-QA setup.
A parallel version matrix is not available on one machine.

**Never boot `flowpad-qa-base` directly.** Always clone first. Booting the base
writes first-boot state into the template and erodes the guarantee the whole setup
rests on.

**Apple ID sign-in inside a VM has historically been unreliable.** Local keychain
(which is what SOD uses) is unaffected, but verify early if a session needs a
signed-in Apple ID.

**Hardware passthrough is thin** — camera, mic, and some peripherals are absent.

## Useful commands

```bash
tart list --source local     # local VMs and their state
tart ip <vm>                 # VM IP (also a readiness signal)
tart stop <vm>               # graceful shutdown
tart delete <vm>             # remove
du -sh ~/.tart               # disk footprint (COW-shared; overstates real usage)
```

SSH in without `sshpass` (not on macOS) using the built-in `expect`:

```bash
expect -c 'spawn ssh -o StrictHostKeyChecking=no admin@'$(tart ip qa-run)' "whoami"
expect { "assword:" { send "admin\r"; exp_continue } eof }'
```

Optionally reduce the DHCP lease time if you churn many VMs daily:

```bash
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.InternetSharing.default.plist \
  bootpd -dict DHCPLeaseTimeSecs -int 600
```

## Cost

Free, on hardware you own. For contrast, MacinCloud's pay-as-you-go entry is a
~$25 non-refundable 25-hour prepaid bundle (credits expire after 60 days without
login, and the account auto-recharges on overage) — and it provisions a *shared,
persistent* managed account, which cannot perform a clean-install test at any
price. Rented dedicated hardware (MacStadium ~$119/mo, AWS EC2 Mac with a 24-hour
minimum host allocation) only makes sense if you don't want to own a Mac.
