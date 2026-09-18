---
id: d1b6da8e-04dd-4b29-9d69-92ef4d31f96a
---

# Plan: getting past SmartScreen on first install (2026-09-14)

Goal: a Windows user who clicks the download button installs Flowpad without the
"Windows protected your PC" prompt. Constraint: Microsoft decides that prompt from
reputation; we cannot force it. So the plan (a) stops resetting the signal on every
release, (b) gives the identity every chance to accrue, (c) adds the one channel that
is prompt-free by construction, and (d) measures instead of guessing.

## Phase 0 — ship the clean pipeline (this week, 1–2 days)

| # | Step | Owner | Done when |
| --- | --- | --- | --- |
| 0.1 | Merge `FLOWPAD-2097` (app repo) into `release/v0.2` and `main`; merge `FLOWPAD-2097` (flowpad-desktop) into `main` | you | both mains carry `signExts`, the `signIf` hook, `win-verify.js`, the hardened Windows job |
| 0.2 | Cut one production release from the merged branches | you | CI `signing-report.md` shows 12/12; offline audit of the published installer shows every nested binary signed (I run it) |
| 0.3 | Submit the evidence package to Microsoft Security Intelligence; open the Azure support case (brief on the Desktop) | you, browser | two ticket ids recorded |
| 0.4 | Release cadence policy: desktop releases batched (target ≤ 1 per 2 weeks); PyPI package releases unaffected | team | written in the release checklist |

Why first: every later phase assumes releases are fully and identically signed, and the
Microsoft tickets need a production file, not a test-repo one.

## Phase 1 — launcher stub: stop resetting the hash (week 1–2)

| # | Step | Owner | Done when |
| --- | --- | --- | --- |
| 1.1 | Build `flowpad-install` (Rust, in `flow_sdk/rust`): fetch `latest.yml` from the production release, download the versioned installer to `%LOCALAPPDATA%\Flowpad\bootstrap`, verify SHA-512 from the feed AND Authenticode subject `Langware INC.` (WinVerifyTrust), run it, exit; one message box on failure with the release-page link. No packing, no UI toolkit, no telemetry | me | **done 2026-09-14** (`src/bin/flowpad-install.rs`, 6 tests incl. a real download of prod v0.2.43 with checksum OK; Windows target type-checked; signed + run on the Windows VM 2026-09-14: refuses a wrong publisher, verifies the real v0.2.43 installer, no Mark-of-the-Web on the payload) |
| 1.2 | `build-launcher.yml` in flowpad-desktop: build, sign through the same Azure pipeline, verify, upload to a dedicated `launcher-vN` pre-release (never "latest"); record SHA-256 as repo variables `LAUNCHER_VERSION` / `LAUNCHER_SHA256` | me | **done 2026-09-14** (workflow written, actionlint clean; not yet run) |
| 1.3 | `create-release` attaches the pinned launcher unchanged to every app release as `Flowpad-Setup.exe`; the versioned installer is attached as `Flowpad-<version>-Setup.exe` (electron-builder `FLOWPAD_LAUNCHER=1`); step fails on hash mismatch, name clash or missing versioned installer; **inert until the two repo variables are set** | me | **done 2026-09-14** (gated; activation checklist in `LAUNCHER.md`) |
| 1.4 | electron-updater feed keeps pointing at the versioned installer (`latest.yml` `path`), so existing installs are unaffected | me | by construction (electron-builder writes the name into `latest.yml`); N→N+1 update still to be watched on the VM |
| 1.5 | Website button → `releases/latest/download/Flowpad-Setup.exe` (the launcher); secondary link "full installer" → versioned file | you | live |

Effect: the downloaded file's hash stops changing. The launcher takes one cold start
(weeks, real downloads), then the prompt disappears for the button path and stays gone
until the launcher itself is rebuilt. Rebuild the launcher only for a bug in it.

## Phase 2 — Microsoft Store: the prompt-free channel (weeks 1–4, parallel)

| # | Step | Owner | Done when |
| --- | --- | --- | --- |
| 2.1 | Partner Center company account, reserve "Flowpad", set the 3 repo variables (`STORE_IDENTITY_NAME`, `STORE_PUBLISHER`, `STORE_PUBLISHER_DISPLAY_NAME`) | you | variables set; identity verification started (critical path, days) |
| 2.2 | Bundle runtime into the package: `uv.exe`, uv-managed CPython 3.10, `flowpad` wheel + dependency wheels; first launch installs offline (`uv tool install --offline --find-links`) | me | packaged app boots on a VM with networking disabled |
| 2.3 | `store_package=true` CI run → `.appx` artifact; WACK on the VM; fix findings | me | WACK pass |
| 2.4 | Submission: listing, screenshots, privacy policy URL, age rating | you + my write-up | certified |
| 2.5 | Website: Store button primary; launcher secondary; full installer tertiary | you | live |

## Phase 3 — winget (optional, 1 day) — NOT a SmartScreen remedy

**Corrected 2026-09-14:** winget stamps the installer it downloads with the Mark of the Web
(`ZoneId=3`, verified on the VM) and SmartScreen prompted on the winget install of
v0.2.43 exactly as it does for a browser download. winget remains a convenient
distribution channel for developers and a manifest is validated in `electron/winget/`,
but it does not remove the prompt and gives no measurable reputation effect. Only the
launcher (payload written without a Mark of the Web) and the Store address the prompt.

## Measurement — know instead of guess

Per production release, on a clean Windows 11 VM snapshot (reset each time):

1. Download the launcher through Edge from the production URL (Mark of the Web present).
2. Run it. Record: dialog shown yes/no, exact text, publisher line, Windows build, date.
3. Same for the versioned installer once, as a control.
4. Log the row in `SMARTSCREEN.md` §3's table (SmartScreen column stops being "unknown").

Signals that the plan is working, in the order they should appear:
* Launcher: prompt on releases 1–k, then none — hash reputation reached.
* Versioned installer: still prompts on release day, then over months less often — publisher reputation accruing.
* Microsoft ticket answers: whether the identity is attributed as expected; any account issue.

Signals that something is wrong: a prompt naming "Unknown publisher" (signature not seen),
a Defender threat name (AV, not SmartScreen — submit as false positive), Smart App Control
block on a machine with it enabled (reputation for SAC is separate).

## What we will not do

Disable or tell users to disable SmartScreen; pack, encrypt or obfuscate binaries; re-sign
or repack a published installer; switch signing identities; buy an EV certificate for this
purpose (no SmartScreen effect any more); ship any new mechanism that fetches executables
without hash + signature verification.

## Timeline summary

* Week 1: Phase 0 complete; launcher built and shipped with the first merged release; Partner Center started.
* Weeks 2–4: launcher accruing; Store bundling + WACK; measurement rows per release.
* Week 4+: Store live → button switches; launcher stays for direct download; winget optional (no SmartScreen benefit).
