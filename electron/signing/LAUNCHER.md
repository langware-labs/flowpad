---
id: 70fcb7e9-915c-4f53-a2cb-d498ea33dc22
---

# The launcher: a `Flowpad-Setup.exe` whose bytes never change

Status (2026-10-09): **ACTIVATED on `launcher-v2`.** Published and pinned; the next
production release is the first to ship it. Deactivation is deleting the two variables.

| | |
| --- | --- |
| pre-release | [`launcher-v2`](https://github.com/langware-labs/flowpad/releases/tag/launcher-v2) in langware-labs/flowpad (prerelease, never "latest") |
| file | `Flowpad-Setup.exe`, 956,696 bytes, built from app commit `102354aa` (PR #586, the tip merged into `release/v0.2`) by [build-launcher.yml run 37871979125](https://github.com/langware-labs/flowpad-desktop/actions/runs/37871979125) |
| manifest | embedded `RT_MANIFEST`: `requestedExecutionLevel=asInvoker` — see "Why v2" below |
| signature | Valid, `CN=Langware INC.`, RFC 3161 timestamped |
| pin | SHA-256 `d00468a3115541721d0b9c465b08d6d3a1bd68395f6a869a7a42a6592c546c9d` (CI `SHA256SUMS` = independent local download) |
| variables (flowpad-desktop) | `LAUNCHER_VERSION=2`, `LAUNCHER_SHA256=<pin>`, set 2026-10-09 01:59 UTC; copy in 1Password (Employee, "flowpad-desktop launcher pin") |
| provenance | `LAUNCHER-SOURCE.txt` on the release: source commit + LF-normalized SHA-256 over the five launcher inputs (`f99ab4ed…`); the release workflow compares it to the release's source and prints a notice on drift (never fails) |
| still to verify | the first production release (asset names, pinned hash attached, `latest.yml` pointing at the versioned installer, drift step "unchanged"), a browser download on a real Windows PC (SmartScreen yes, UAC no), the in-app updater |

**Why v2 (2026-10-09).** `launcher-v1` (pin `0da5b684…`, run 37661840336) had no application
manifest. Launched from the desktop, Windows' installer-detection heuristic (name or
version strings containing "setup"/"install") demanded elevation: a UAC prompt before the
launcher even ran, and the launcher, the installer and the app would all have run as
administrator. Found on the Windows VM through a scheduled task in the interactive session
(`consent.exe` waiting, exit 1 when the prompt timed out, no log); the same binary under a
neutral file name behaved the same. The ssh-session dry run had passed only because an
OpenSSH admin session has an unfiltered token. Fix: `flowpad-install.manifest` embedded from
`flowpad-install.rc` (PR #586). Verified on the VM with the manifest injected into a copy of
v1 (no UAC, full run, installer started) and then with the CI build. v1 never shipped in a
release; its pre-release stays as history.

Every signing yields new bytes (a no-publish dry run of the same source gives a different
hash), so only the published run's hash is the pin, and a launcher is rebuilt only for a
change in the launcher itself.

Earlier, measured on Windows 11 (x64 build, ARM64 VM), 2026-09-14, before the CI run existed:

| Check | Result |
| --- | --- |
| `cargo test --bin flowpad-install` (native) | 6/6 pass, incl. end-to-end against a local HTTP server |
| binary | 839,680 bytes unsigned; version resource embedded (ProductName Flowpad, CompanyName Langware INC., OriginalFilename Flowpad-Setup.exe); `flow-rs.exe` unaffected |
| signed with Azure Artifact Signing | Valid, `CN=Langware INC.`, issuer CS AOC CA 04, timestamped 2026-09-14 20:37:10; `signtool verify /pa /v` OK; **SHA-256 `83a4deff27f8b04e4c6e92bb1111a40beee01b3fbf816452370eebf7cc5ad7e2`** (854,456 bytes) — a VM build, not the CI pin |
| run, wrong expected publisher | fetched prod `latest.yml` (v0.2.43), downloaded 96,634,808 bytes, checksum OK, read the signer as `Langware INC.`, **refused** ("expected Nobody Inc."), deleted the file, exit ≠ 0 |
| run, dry run | same download + checksum; **Authenticode OK: signed by Langware INC.**; stopped before launch; the file on disk is the real prod installer (sha256 `63d2992d…` matches the release) and carries **no Mark-of-the-Web** |
| not done then | the actual launch of the installer (dry run only), a browser download of the launcher itself; the `build-launcher.yml` CI run has since succeeded (see the status table above) |

## Why

SmartScreen's "Windows protected your PC" is decided per file hash plus publisher. Every
app release is a new installer hash, so the download button starts from zero each time.
The launcher is the file users actually download: a ~1 MB signed executable that fetches
the versioned installer itself, verifies it, and runs it. A file written by a local
process carries no Mark-of-the-Web, so the real installer is never evaluated by
SmartScreen; the launcher's own hash stops changing, so its reputation, once earned,
carries across releases. It does not remove the first cold start of the launcher itself.

## What it does (`flow_sdk/rust/src/bin/flowpad-install.rs`)

1. GET `https://github.com/langware-labs/flowpad/releases/latest/download/latest.yml`
   (the same feed electron-updater trusts).
2. Read the top-level `version`, `path`, `sha512`; refuse any `path` that is not a plain
   `*.exe` name (no separators, no spaces).
3. Download `…/latest/download/<path>` to `%LOCALAPPDATA%\Flowpad\bootstrap\<path>`
   (`.partial` while streaming), hashing on the fly; keep it only if the SHA-512 equals
   the feed's; previously downloaded installers in that folder are deleted first.
4. `WinVerifyTrust` with the default Authenticode policy; the signer's subject CN must be
   `Langware INC.` (an expired 3-day leaf with a valid timestamp passes, as designed).
5. Start the installer, exit 0. Any failure: one message box with the reason and the
   release page URL; details in `%LOCALAPPDATA%\Flowpad\bootstrap\flowpad-install.log`.

No retries, no fallback to an unverified file, no packing, no telemetry, no UI toolkit.
TLS is the platform stack (schannel + Windows root store). Version resource and icon are
embedded into this binary only (`build.rs` + `resources/flowpad-install.rc`); `flow-rs.exe`
and the Python extension are untouched. On non-Windows the binary is a stub, so
`cargo build --release` (which `npm run build:flow-rs` runs) keeps working everywhere.

Testing overrides (never set for users): `FLOWPAD_RELEASE_BASE`, `FLOWPAD_EXPECTED_PUBLISHER`,
`FLOWPAD_BOOTSTRAP_DIR`. Unit tests: `cargo test --bin flowpad-install`.

## How it ships — one file, pinned

```
build-launcher.yml (flowpad-desktop, manual, once per launcher version N)
   cargo test + build (x64) → sign (Azure Artifact Signing) → verify (Valid, Langware INC.,
   timestamped, signtool) → SHA-256 → artifact → [publish] pre-release `launcher-vN` in
   langware-labs/flowpad (prerelease + make_latest=false: it can never become "latest")
        │
        ▼  you set repo variables LAUNCHER_VERSION=N, LAUNCHER_SHA256=<hash> in flowpad-desktop
        │
build-desktop.yml (every app release)
   build-windows:  FLOWPAD_LAUNCHER=1 → electron-builder names the installer
                   Flowpad-<version>-Setup.exe (electron-builder.config.cjs); latest.yml
                   and the blockmap follow the new name automatically
   create-release: downloads launcher-vN/Flowpad-Setup.exe, FAILS unless its SHA-256
                   equals LAUNCHER_SHA256, FAILS if a name clash or a missing versioned
                   installer is detected, attaches it → release assets:
                     Flowpad-Setup.exe               (launcher, identical bytes every release)
                     Flowpad-<version>-Setup.exe     (real installer)
                     Flowpad-<version>-Setup.exe.blockmap, latest.yml
```

`https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-Setup.exe` —
the website link — keeps resolving on every release; from activation on it serves the
launcher. electron-updater keeps working: it reads the installer name from `latest.yml`.

**Before the variables are set nothing changes**: the installer is still named
`Flowpad-Setup.exe`, no launcher is attached, and the create-release step logs a notice.

## Rules

* **Never rebuild the launcher casually.** A rebuild re-signs with a fresh certificate and
  timestamp, which is a new hash and a new cold start. Rebuild for a launcher bug only,
  bump `launcher_version`, republish, update the two variables. The release workflow's
  drift step says when the source has moved past the published binary.
* **Test it the way a user runs it.** A terminal or ssh launch skips SmartScreen and, for an
  admin session, UAC too. The dialog tests are a browser download plus a double-click, or a
  scheduled task in the interactive session (`consent.exe` in the process list = UAC).
* **Never change its file name** (`Flowpad-Setup.exe`) or the website link.
* The feed base is hard-coded to production. A test-repo release still attaches the same
  launcher, which would install PRODUCTION's latest — fine for the pipeline rehearsal,
  wrong for testing the launcher itself: for that run it with `FLOWPAD_RELEASE_BASE`
  pointing at the test release.
* winget must reference the versioned installer, never the launcher (`publish-winget`
  regex already does). winget is not a SmartScreen bypass — it stamps the Mark of the Web.

## Activation checklist

1. ~~Merge the app branch (launcher source + electron config) and the flowpad-desktop branch (workflows).~~ done
2. ~~Run **Build Launcher (Windows)** with `publish=true`.~~ done: v1 2026-10-07 (run 37661840336, retired), v2 2026-10-09 (run 37871979125)
3. ~~On the Windows VM: run the published launcher from the desktop session (scheduled task),
   confirm the versioned installer is downloaded to the bootstrap dir, verified and started;
   run it with `FLOWPAD_EXPECTED_PUBLISHER=Nobody Inc.` to see it refuse.~~ done 2026-10-09:
   refusal path OK; dry run OK (installer = v0.2.51, no Mark-of-the-Web); real run with the
   v2 manifest started the Setup wizard, no UAC. Still open: a browser download on a real
   Windows PC (SmartScreen text, no UAC) — brief in `~/Desktop/launcher-windows-test/`.
4. ~~Set `LAUNCHER_VERSION` and `LAUNCHER_SHA256` in flowpad-desktop.~~ done 2026-10-09 (v2)
5. Cut a `test_release=true` build: assets must show both `Flowpad-Setup.exe` (launcher)
   and `Flowpad-<version>-Setup.exe`; download `latest/download/Flowpad-Setup.exe` from
   the test repo and compare its hash with the pin.
6. Next production release: same check; the release job must log `launcher v2 attached`
   and the drift step `unchanged`; add the measurement row (`SMARTSCREEN-PLAN.md`).
   winget needs no change: `winget-submit` reads the installer name from `latest.yml`, so
   the manifest follows the versioned installer automatically, and it holds new submissions
   while a new-package PR is pending.
