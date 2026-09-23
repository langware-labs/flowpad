---
id: d8492ea3-e0cc-4ac4-94b1-b09b83a07fef
---
# winget — submitted by CI, every production release

`winget install Langware.Flowpad` gives a one-line install and automatic version bumps.
**It is not a SmartScreen bypass**: winget stamps the downloaded installer with the Mark of
the Web (`ZoneId=3`) and SmartScreen evaluates it like a browser download (measured on the
VM, 2026-09-14, on production v0.2.44). Treat it as convenience only.

## How it works

The `publish-winget` job in flowpad-desktop `build-desktop.yml` runs after `create-release`
for production releases only (not dry runs, not `test_release`):

1. Reads the release's `latest.yml` (installer file name) and `checksums.sha256` (hash) and
   its publish date — the version and tag come from `resolve-release-tag`, the same place
   the release itself gets them.
2. Renders `template/*.yaml` with `render.sh` into `manifests/l/Langware/Flowpad/<version>/`.
   The template is the manifest that was validated with `winget validate` (winget 1.29,
   schema 1.12) and whose Apps & Features entry (ProductCode
   `01ea153f-315f-5cd5-8810-48807d21bb7d`, Publisher `Langware Labs`) was read from a real
   install.
3. Syncs the org fork `langware-labs/winget-pkgs` from `microsoft/winget-pkgs`, creates a
   branch `Langware.Flowpad-<version>` there and adds the three files through the GitHub
   API (no clone of the upstream repo).
4. Opens the pull request on `microsoft/winget-pkgs` with the title winget-pkgs expects —
   `New package: Langware.Flowpad version X.Y.Z` the first time, `Update: Langware.Flowpad
   to X.Y.Z` afterwards — using `pr-body.md`.
5. Skips, with a notice, when that version is already upstream or already has an open PR.

The installer name is taken from `latest.yml`, so the job works both today
(`Flowpad-Setup.exe`) and in launcher mode (`Flowpad-<version>-Setup.exe`).

## Requirements

* Secret `WINGET_TOKEN` in flowpad-desktop: a **classic** PAT, scope `public_repo`, of a
  GitHub user with push rights to the fork (set 2026-09-14, user `mtzahi`). Fine-grained
  tokens cannot open PRs on Microsoft's repository — do not use one.
* The Microsoft CLA must be signed once by that user (the winget-pkgs bot asks on the first PR).
* Fork `langware-labs/winget-pkgs` (exists). No `WINGET_FORK_USER` needed.

## Submissions

* 0.2.44 — New package: https://github.com/microsoft/winget-pkgs/pull/434707 (opened 2026-09-14 from the org fork, branch `Langware.Flowpad-0.2.44`)

## Local check

```bash
electron/winget/render.sh 0.2.44 v0.2.44 Flowpad-Setup.exe <sha256> 2026-09-14 /tmp/out
# on Windows: winget validate --manifest /tmp/out/manifests/l/Langware/Flowpad/0.2.44
```
