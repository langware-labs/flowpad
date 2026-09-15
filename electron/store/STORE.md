---
id: 784b9d7b-b458-4269-ba7d-acb358bdfd49
---

# Microsoft Store distribution — plan and status (2026-09-08)

Why: the Store is the only channel Microsoft documents as free of the SmartScreen
"Windows protected your PC" prompt — packages are re-signed by Microsoft and installed
without a Mark-of-the-Web. Direct-download `.exe` reputation accrues per file hash and
cannot be pre-seeded (see `../signing/SMARTSCREEN.md`).

## Status

| Step | Owner | State |
| --- | --- | --- |
| 1. Partner Center: developer account (company), reserve the name "Flowpad" | you | **to do — start now, identity verification is the slow part** |
| 2. Store build variant (`FLOWPAD_STORE_BUILD=1` → unsigned `.appx`) | done | `electron-builder.config.cjs`, `main.js` (no electron-updater in Store builds) |
| 3. CI job `build-windows-store` (input `store_package=true`, artifact `windows-store-package`) | done | flowpad-desktop `build-desktop.yml`; needs the 3 repo variables from step 1 |
| 4. Bundle the runtime so first launch does not download code | to do | design below — the main review risk |
| 5. Windows App Certification Kit on the package | to do | on the Windows VM once a package exists |
| 6. Submission, listing, screenshots, privacy policy URL | you, with the write-up | after 4 and 5 |
| 7. Website: Store button primary, GitHub `.exe` secondary | you | after approval |

## 1. Partner Center — what I need from you

After reserving the app name, Partner Center → Product management → Product identity shows
three values. Put them in flowpad-desktop as **repository variables** (Settings →
Secrets and variables → Actions → Variables; they are not secrets):

| Variable | Partner Center field | Example |
| --- | --- | --- |
| `STORE_IDENTITY_NAME` | Package/Identity/Name | `LangwareINC.Flowpad` |
| `STORE_PUBLISHER` | Package/Identity/Publisher | `CN=0a1b2c3d-…` |
| `STORE_PUBLISHER_DISPLAY_NAME` | Package/Properties/PublisherDisplayName | `Langware INC.` |

The build fails closed if the first two are missing or if the publisher is not `CN=…`.
The company account fee is one-time; identity verification of the legal entity typically
takes a few business days and is the critical path.

## 2. How the Store build works

`FLOWPAD_STORE_BUILD=1` switches `electron-builder.config.cjs` into Store mode: target
`appx` x64, `azureSignOptions` removed (the package must be **unsigned** — Microsoft signs it
on ingestion; signing with our certificate would stamp the wrong publisher), no
verification gates, `appx.identityName/publisher/publisherDisplayName` from the variables,
`electronUpdaterAware: false`. The NSIS/direct-download build is untouched.

In the app, `process.windowsStore` is true inside an AppX. `main.js` then skips
electron-updater entirely (the Store delivers desktop updates; electron-updater does not
support AppX) while the hourly PyPI package check keeps running.

CI: run the workflow with `store_package=true`; the `build-windows-store` job builds, checks
the package is unsigned and that the manifest `<Identity>` matches the variables, and
uploads `Flowpad-<version>-store.appx` as an artifact. Nothing is published; you upload the
`.appx` in Partner Center.

## 3. First-run dependencies — the review risk, and the design

Today the wrapper downloads `uv`, a CPython 3.10 and the `flowpad` package from the
internet on first launch. Store policy (10.2.x) is strict about executable code fetched at
runtime; a reviewer may reject this or ask for justification. Two options:

**A. Bundle the runtime (recommended).** Ship inside the package, under
`resources/runtime/`:

* `uv.exe` (pinned version),
* a uv-managed CPython 3.10 (`uv python install 3.10 --install-dir <staging>` at build time),
* the `flowpad` wheel and all its dependency wheels for `win_amd64`/py310
  (`uv pip download`/`pip wheel` into a local `--find-links` directory at build time).

First launch then runs `uv tool install flowpad --python <bundled cpython> --find-links
<bundled wheels> --offline` — no network, deterministic, faster than today, and the same
code path the current wrapper already uses (`uv-manager.js`). Package size grows by roughly
150–250 MB. Later `flow upgrade` runs keep using PyPI, which is ordinary package-manager
behaviour and defensible in review, but the *install* no longer depends on it.

This is the same design that fixes two things you already hit: no Python on the machine
(the bundled interpreter is always there) and slow first launches.

**B. Submit as-is and argue.** Cheaper, and some Electron apps that fetch runtimes are in the
Store, but a rejection costs a review cycle and the outcome depends on the reviewer.

Plan: A, implemented in `uv-manager.js` + `build-flow-rs.js`-style build step, behind a
check for the bundled directory so unbundled builds keep the current behaviour.

## 4. Certification (WACK) — things to look at

* Full-trust desktop bridge app (electron-builder sets `runFullTrust`): allowed, standard
  for Electron.
* `flow-rs.exe` reads/writes the Windows Credential Manager. Runs fine under full trust;
  verify once inside the packaged app (AppContainer is not used, but the package identity
  changes the credential namespace? — check that an existing SOD key is found or re-minted
  cleanly).
* File system: the app must write under `%LOCALAPPDATA%`/`%APPDATA%` (uv tool dir,
  `~/.flow`), not under its install dir — already the case.
* Icons: Store needs the tile assets electron-builder generates from `resources/icons`;
  check WACK for missing scales.

## 5. What does not change

* Direct download from GitHub stays, fully signed, with the honest SmartScreen note on the
  site. Its reputation accrues on its own.
* electron-updater keeps serving the direct-download installs.
* winget serves developers today (`../winget/README.md`).
