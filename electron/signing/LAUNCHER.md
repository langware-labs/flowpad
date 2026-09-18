---
id: 70fcb7e9-915c-4f53-a2cb-d498ea33dc22
---

# The launcher: a `Flowpad-Setup.exe` whose bytes never change

Status (2026-09-14): **built, signed and exercised on the Windows VM; NOT committed, NOT
activated.** Activation is one pair of repository variables and is reversible.

Measured on Windows 11 (x64 build, ARM64 VM):

| Check | Result |
| --- | --- |
| `cargo test --bin flowpad-install` (native) | 6/6 pass, incl. end-to-end against a local HTTP server |
| binary | 839,680 bytes unsigned; version resource embedded (ProductName Flowpad, CompanyName Langware INC., OriginalFilename Flowpad-Setup.exe); `flow-rs.exe` unaffected |
| signed with Azure Artifact Signing | Valid, `CN=Langware INC.`, issuer CS AOC CA 04, timestamped 2026-09-14 20:37:10; `signtool verify /pa /v` OK; **SHA-256 `83a4deff27f8b04e4c6e92bb1111a40beee01b3fbf816452370eebf7cc5ad7e2`** (854,456 bytes) — a VM build, not the CI pin |
| run, wrong expected publisher | fetched prod `latest.yml` (v0.2.43), downloaded 96,634,808 bytes, checksum OK, read the signer as `Langware INC.`, **refused** ("expected Nobody Inc."), deleted the file, exit ≠ 0 |
| run, dry run | same download + checksum; **Authenticode OK: signed by Langware INC.**; stopped before launch; the file on disk is the real prod installer (sha256 `63d2992d…` matches the release) and carries **no Mark-of-the-Web** |
| not yet done | the actual launch of the installer (dry run only), a browser download of the launcher itself, the `build-launcher.yml` CI run |

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
  bump `launcher_version`, republish, update the two variables.
* **Never change its file name** (`Flowpad-Setup.exe`) or the website link.
* The feed base is hard-coded to production. A test-repo release still attaches the same
  launcher, which would install PRODUCTION's latest — fine for the pipeline rehearsal,
  wrong for testing the launcher itself: for that run it with `FLOWPAD_RELEASE_BASE`
  pointing at the test release.
* winget must reference the versioned installer, never the launcher (`publish-winget`
  regex already does). winget is not a SmartScreen bypass — it stamps the Mark of the Web.

## Activation checklist

1. Merge the app branch (launcher source + electron config) and the flowpad-desktop branch (workflows).
2. Run **Build Launcher (Windows)** with `publish=true`, `launcher_version=1`.
3. On the Windows VM: download the published launcher through Edge, run it, confirm the
   versioned installer is downloaded to `%LOCALAPPDATA%\Flowpad\bootstrap`, verified and
   started; check the log file. Also run it with `FLOWPAD_EXPECTED_PUBLISHER=Nobody` to see
   it refuse.
4. Set `LAUNCHER_VERSION=1` and `LAUNCHER_SHA256=<hash from the run summary>` in flowpad-desktop.
5. Cut a `test_release=true` build: assets must show both `Flowpad-Setup.exe` (launcher)
   and `Flowpad-<version>-Setup.exe`; download `latest/download/Flowpad-Setup.exe` from
   the test repo and compare its hash with the pin.
6. Next production release: same check; add the measurement row (`SMARTSCREEN-PLAN.md`).
