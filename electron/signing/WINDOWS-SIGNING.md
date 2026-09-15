---
id: 2aa6cdf6-4d0b-41a8-80cc-f7506ec1bed4
---

# Windows code signing — architecture, verification, CI gates

Status: **code + CI changes made, NOT committed. Validated on a real Windows build
(2026-09-07, Windows 11 ARM64 VM, electron-builder 26.8.1, real Azure Artifact Signing
credentials): 12/12 binaries Valid, Langware INC., timestamped — see §6.** SmartScreen is a
separate topic: see `SMARTSCREEN.md`. Signing correctness does not fix SmartScreen and is
not claimed to.

## 1. What electron-builder actually does (app-builder-lib 26.8.1, installed)

Traced from `electron/node_modules/app-builder-lib/out/`.

| Question | Answer | Source |
| --- | --- | --- |
| How does `win.azureSignOptions` sign? | `WinPackager.signingManager` picks `WindowsSignAzureManager` whenever `azureSignOptions != null`, else `WindowsSignToolManager`. The Azure manager installs the `TrustedSigning` PowerShell module, checks `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` + secret or certificate env, and signs each file with `Invoke-TrustedSigning -Endpoint … -CodeSigningAccountName … -CertificateProfileName … -FileDigest SHA256 -TimestampRfc3161 http://timestamp.acs.microsoft.com -TimestampDigest SHA256 -Files <file>`. Missing env → `InvalidConfigurationError` (build fails). Non-zero exit → throws (build fails). | `winPackager.js:33-41`, `codeSign/windowsSignAzureManager.js` (`initialize`, `signFile`) |
| Does `signExts` apply with Azure signing? | Yes. The file filter is `WinPackager.shouldSignFile`, evaluated before any manager is involved; the manager only signs what it is handed. | `winPackager.js:197-215`, `signIf` at `106` |
| Default extensions | `.exe` only (`backwardCompatibility = file.endsWith(".exe")`). With `signExts` set, positive suffixes match first, then `!` negatives, then the `.exe` fallback. A negative cannot exclude a file already matched by a positive suffix. | `winPackager.js:197-215` |
| Are `extraResources` `.exe` files signed? | **Only when `from` is a directory.** `WinPackager.createTransformerForExtraFiles` builds a signing `CopyFileTransformer`, and `doPack` passes it to `copyFiles`; but `copyFiles` hands the transformer only to `copyDir` (directory sources). A **single-file** `from` — our `../flow_sdk/rust/target/release/flow-rs.exe` — goes through `copyOrLinkFile` with no transformer and arrives **unsigned**. Confirmed on the real build: the `afterSign` gate failed with `resources\flow-rs\flow-rs.exe: UNSIGNED` until the hook below was added. The original `sign-flow-rs-win.js` premise was right for our entry. | `winPackager.js:216-228`, `platformPackager.js:240-242`, `fileMatcher.js:267-291` |
| When are Electron runtime binaries processed? | `WinPackager.signApp`: every file in the app root passing `shouldSignFile` (Flowpad.exe via `signAndEditResources` after rcedit; DLLs only when `.dll` is in `signExts`), then a walk of `resources/app.asar.unpacked` and `swiftshader` (native `.node` modules live there). | `winPackager.js:229-255` |
| `elevate.exe` | Copied to `resources/elevate.exe` and `signIf`-ed by `CopyElevateHelper` **during the NSIS target build**, i.e. after `afterSign`. | `targets/nsis/nsisUtil.js:112-130` |
| NSIS uninstaller | Built first, extracted by running the installer, then `packager.signIf(uninstallerPath)`. | `targets/nsis/NsisTarget.js:346-376` |
| NSIS installer (`Flowpad-Setup.exe`) | `makensis`, then `packager.signIf(installerPath)`, then `emitArtifactBuildCompleted`. | `NsisTarget.js:300-313` |
| Hook order | `afterPack` (`platformPackager.js:246`) → `signApp` → `afterSign` only if signing happened (`:333-335`) → targets build (NSIS: elevate copy, uninstaller, installer, signing) → `artifactBuildCompleted` per artifact (`NsisTarget.js:313`) → `afterAllArtifactBuild` once at the end (`index.js:56`). | |
| Which hook can verify `win-unpacked`? | `afterSign` (tree without `elevate.exe`) and `artifactBuildCompleted` (tree complete). | |
| Which hook can verify the final installer? | `artifactBuildCompleted` (fires after `signIf(installerPath)`) or `afterAllArtifactBuild`. **Not** `afterSign` — the installer does not exist yet. `afterAllArtifactBuild` is already taken by `signing/notarize.js` (mac). | |

Consequence of `signExts: [".dll"]`: electron-builder does not skip already-signed files, so
`d3dcompiler_47.dll` and `dxil.dll` (shipped by Electron with Microsoft signatures) will be
re-signed with our identity. There is no native way to exclude them without listing every
other DLL by name. This is accepted; the verification policy allows either outcome.

## 2. Signing flow after the change

```
cargo build flow-rs.exe          (unsigned)
        │
electron-builder pack
        ├─ copy extraResources  → resources/flow-rs/flow-rs.exe   (NOT signed: single-file copy)
        ├─ afterPack → signSingleFileExtraResources → packager.signIf(flow-rs.exe) ──┐
        ├─ signApp: Flowpad.exe (rcedit → sign), *.dll, app.asar.unpacked/**  │ win.azureSignOptions
        ├─ afterSign  → win-verify.afterSign  (gate: win-unpacked)             │ Invoke-TrustedSigning
        └─ NSIS: resources/elevate.exe ── signIf ──                            │
                 uninstaller      ── signIf ──                                 │
                 Flowpad-Setup.exe── signIf ──────────────────────────────────┘
                 artifactBuildCompleted → win-verify.artifactBuildCompleted
                        (gate: installer + win-unpacked incl. elevate.exe; writes signing-report.*)
CI: node signing/win-verify.js release --publisher "Langware INC."   (independent re-check)
    signtool verify /pa /v Flowpad-Setup.exe                          (second opinion)
    → PASS → upload artifacts → create-release
```

One signing mechanism (electron-builder's), one verifier (`signing/win-verify.js`), nothing
signed twice.

## 3. Files

| File | Change | Why |
| --- | --- | --- |
| `electron-builder.json` | `+ win.signExts: [".exe", ".dll", ".node"]` | Six Electron DLLs shipped unsigned in v0.2.41 because the default is `.exe` only. `azureSignOptions` untouched. |
| `electron-builder.config.cjs` | `- afterPack` custom `Invoke-TrustedSigning` hook; `+ afterPack = signSingleFileExtraResources` (calls electron-builder's own `packager.signIf` for every single-file extraResource ending in .exe/.dll/.node — one signing mechanism, no metadata file, ~15 lines); `+` signing-mode logic; `+ afterSign` / `artifactBuildCompleted` gates | Single-file extraResources bypass electron-builder's copy transformer (§1). Explicit LOCAL vs REQUIRED modes (below). |
| `signing/sign-flow-rs-win.js` | deleted | Replaced by the `signIf` hook above: same Azure manager, no second implementation, fails instead of skipping. |
| `signing/metadata.json` | deleted | Only consumer was the deleted hook. |
| `signing/win-verify.js` | new, verification only | Gate + report. Uses `Get-AuthenticodeSignature` (WinVerifyTrust) and .NET SHA-256; no signtool discovery, no certificate parsing, no retries, no timeouts. Prefers `pwsh.exe`; falls back to Windows PowerShell 5.1 with a clean `PSModulePath` (a 5.1 spawned under a pwsh 7 parent — GitHub's default `pwsh` shell, SSH — otherwise loads pwsh 7's security module and `Get-AuthenticodeSignature` fails; hit on the VM). |
| flowpad-desktop `.github/workflows/build-desktop.yml` | Windows job hardened | See §5. |

### Signing modes (`electron-builder.config.cjs`)

| Condition | Behaviour |
| --- | --- |
| `FLOWPAD_SIGNING=required` (CI) and identity or credentials missing | config load throws; nothing is built |
| `FLOWPAD_SIGNING=required`, everything present | sign + verify; hooks wired |
| local, everything present | sign + verify, same as CI |
| local, anything missing | `azureSignOptions` removed, loud `UNSIGNED` warning, no hooks (electron-builder signs nothing) |

## 4. Verification policy (`signing/win-verify.js`)

For every `*.exe`, `*.dll`, `*.node` under `win-unpacked` and every `*.exe` in `release/`:

1. an Authenticode signature exists (`NotSigned` → FAIL),
2. `Status` is `Valid` (chain validates under WinVerifyTrust; anything else → FAIL),
3. an RFC 3161 timestamp is present (`TimeStamperCertificate` set; otherwise → FAIL),
4. publisher:
   * **ours** — `Flowpad.exe`, `flow-rs.exe`, `elevate.exe`, `Uninstall*.exe`, `*-Setup.exe`,
     every `*.node` — must be issued to `win.azureSignOptions.publisherName` (`Langware INC.`),
   * **anything else** — accepted with a `Valid` signature from another publisher and reported
     as `upstream`,
   * unsigned executable content is always FAIL.

Runs at `afterSign` (tree, pre-NSIS), `artifactBuildCompleted` (installer + complete tree,
writes `release/signing-report.md` and `.json`), and as a CLI in CI. The report lists path,
verdict, status, publisher, issuer, timestamp status, leaf validity and SHA-256 for every
binary, so an unexpected unsigned file is visible at a glance.

## 5. CI (`build-desktop.yml`, `build-windows` job)

Conditions that now fail the job (and therefore block `create-release`, which requires
`build-windows == success`):

| Condition | Where it fails |
| --- | --- |
| `codeSigningAccountName` / `certificateProfileName` / `endpoint` / `publisherName` not patched | "Prepare Windows signing config" (`node -e` check) |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` missing | "Require Azure signing credentials" (`exit 1`) |
| token request for `codesigning.azure.net` fails | same step (`throw`) |
| identity/credentials missing at config load | `electron-builder.config.cjs` throws (`FLOWPAD_SIGNING=required`) |
| `Invoke-TrustedSigning` non-zero | electron-builder throws |
| any unsigned / invalid / untimestamped / wrong-publisher binary in win-unpacked | `afterSign` hook throws |
| same for the installer or the completed tree | `artifactBuildCompleted` hook throws |
| independent re-check of installer + tree | "Verify Authenticode signatures" (`exit 1`) |
| `signtool verify /pa /v` on the installer | same step (`exit 1`) |

Removed: the `metadata.json` `sed` block (file deleted), the warning-only credential check,
the warning-only verification. Kept: the three `sed` lines that patch
`electron-builder.json`, the `AZURE_*` env on the build step. Added: `FLOWPAD_SIGNING=required`
on the build step, `signing-report.md/.json` uploaded with the artifacts and appended to the
job summary. Upload happens after verification.

## 6. Verification results (real Windows build, 2026-09-07)

Environment: UTM VM, Windows 11 Pro 10.0.26200 **ARM64**, PowerShell 7.5.4, Node 24.12,
electron-builder 26.8.1, Rust 1.93 with the `x86_64-pc-windows-msvc` target, real
`langware-signing` / `langware-public` credentials from 1Password. `flow-rs.exe` was built
for x64 and staged where `extraResources` expects it (the `build:flow-rs` script builds for
the host, which on this VM would be arm64); electron-builder was then run directly with
`FLOWPAD_SIGNING=required`. Two VM-only preconditions: the x64 .NET 8 runtime (the x64
signtool + dlib exit 3 silently without it on an ARM64 host) — irrelevant on x64 CI runners.

Build log (electron-builder): `signing with Azure Trusted Signing` for flow-rs.exe (from the
afterPack hook, first), then d3dcompiler_47.dll, dxcompiler.dll, dxil.dll, ffmpeg.dll,
Flowpad.exe, libEGL.dll, libGLESv2.dll, vk_swiftshader.dll, vulkan-1.dll; `afterSign` gate
10/10 OK; NSIS: elevate.exe, uninstaller, Flowpad-Setup.exe signed; `artifactBuildCompleted`
gate 12/12 OK; exit 0 in 106 s.

Independent re-check (CLI gate, `Get-AuthenticodeSignature`, and `signtool verify /pa /v`
on the installer and flow-rs.exe) — all agree:

| file | status | issued to | issuing CA | timestamp |
| --- | --- | --- | --- | --- |
| Flowpad-Setup.exe | Valid | Langware INC. | Microsoft ID Verified CS AOC CA 03 | 2026-09-07 14:27:52, Microsoft Public RSA Time Stamping Authority |
| Flowpad.exe | Valid | Langware INC. | same | present |
| resources/flow-rs/flow-rs.exe | Valid | Langware INC. | same | 2026-09-07 14:26:36 |
| resources/elevate.exe | Valid | Langware INC. | same | present |
| ffmpeg.dll, libEGL.dll, libGLESv2.dll, vk_swiftshader.dll, vulkan-1.dll, dxcompiler.dll | Valid | Langware INC. | same | present |
| d3dcompiler_47.dll, dxil.dll (were Microsoft-signed) | Valid | Langware INC. (re-signed, expected) | same | present |
| `.node` modules | none present in this build | | | |

Leaf certificate valid 2026-09-05 → 2026-09-08 17:27:57Z (3-day Artifact Signing leaf), chain
Langware INC. ← Microsoft ID Verified CS AOC CA 03 ← Microsoft ID Verified Code Signing PCA
2021 ← Microsoft Identity Verification Root CA 2020. Full per-file SHA-256 in the generated
`release/signing-report.md` (copied to the session scratchpad).

Not yet exercised: a run of the hardened `build-desktop.yml` on GitHub (needs the branch
pushed), and the SmartScreen desktop test (`SMARTSCREEN.md` §4).
