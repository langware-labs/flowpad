---
id: b8a6495b-ab2a-4729-ab6b-c9fb4c58545d
---
# SmartScreen investigation — separate from signing correctness

Status (2026-09-07): **investigation only, no conclusion on root cause, no Windows test run
yet.** Signing hygiene changes are in `WINDOWS-SIGNING.md`; they are not claimed to change
SmartScreen behaviour.

## 1. What SmartScreen scores

Microsoft's own statement (learn.microsoft.com, "SmartScreen reputation for Windows app
developers", updated 2026-08): reputation is two signals — **publisher reputation** (is the
file signed, by a known trusted publisher?) and **file-hash reputation** (download history of
this exact file). "Even when signed, a newly created binary could still show a SmartScreen
warning until its hash or publisher certificate accumulates sufficient evidence." "There is
no need (or mechanism) to manually submit a file for SmartScreen reputation review for
consumer endpoints." "EV certificates no longer bypass SmartScreen." For Artifact Signing:
"reputation accumulates over time based on download volume and behavior."

Every Flowpad release is a new file hash, so file-hash reputation starts at zero each time.
What can carry across releases is publisher reputation, keyed on the durable identity in the
certificate, not on the 3-day leaf.

## 2. Evidence: what the shipped v0.2.41 installer contains

Audited offline from the GitHub release asset (PE security directory parsed, embedded
`app-64.7z` carved and extracted):

| File | Signature |
| --- | --- |
| `Flowpad-Setup.exe` | Langware INC., Public Trust chain, RFC 3161 timestamp — valid |
| `Flowpad.exe`, `resources/elevate.exe`, `resources/flow-rs/flow-rs.exe` | Langware INC., timestamped |
| `d3dcompiler_47.dll`, `dxil.dll` | Microsoft, timestamped |
| `ffmpeg.dll`, `libEGL.dll`, `libGLESv2.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`, `dxcompiler.dll` | **unsigned** |

The installer itself — the file SmartScreen evaluates on download — was fully and correctly
signed, and SmartScreen still warned. **We have not proven, and do not claim, that the
unsigned DLLs caused SmartScreen.** They are fixed for hygiene (`signExts`).

## 3. Historical comparison — last 12 releases

All values measured from the `Flowpad-Setup.exe` asset of each GitHub release. "SmartScreen
result" is **unknown** for every row: we have user reports of the prompt but no per-release,
per-hash evidence. Leaf SHA-1 / issuing-CA SHA-1 are certificate thumbprints. Offline
Authenticode status means the PKCS#7 parsed and the chain reaches the Microsoft Identity
Verification Root CA 2020; Windows-side `Status: Valid` still needs a Windows run.

| release | published | SHA-256 of `Flowpad-Setup.exe` | size (bytes) | Authenticode | signer CN | leaf SHA-1 | leaf validity (UTC) | issuing CA | issuing CA SHA-1 | RFC 3161 | TSA chain | timestamp (UTC) | SmartScreen result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v0.2.28 | 2026-06-10 | `2308842429caa53e5ecca36071e0c0aa8098742933c03519c9d8da0b8fdd96e9` | 96,620,496 | signed, chain OK (offline parse) | Langware INC. | B1E1D1F646BB728C43803AA424E7344D66122E0E | 2026-06-09 09:32 → 2026-06-12 09:32 | Microsoft ID Verified CS EOC CA 03 | C1E16A2011AA98EAA598F759A13BDA2E742D8881 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-06-10 15:42:18Z | unknown |
| v0.2.31 | 2026-06-29 | `7c392e80fe359d0680b5edf36cfea0aee886bae68c8defcd50ff80d1eee9610b` | 96,920,336 | signed, chain OK (offline parse) | Langware INC. | FE23D8CEA5E176DFF5584260B1C45436E45D6DB4 | 2026-06-28 11:01 → 2026-07-01 11:01 | Microsoft ID Verified CS AOC CA 03 | 06F826F5DDBB0A47AFC6BED6549B936461FFA7D0 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-06-29 10:58:04Z | unknown |
| v0.2.32 | 2026-06-29 | `aa00ff1f3dfa496b7a3e1a7bb0e0b481de80ee019cf6174989bfc6514bd57f73` | 96,916,560 | signed, chain OK (offline parse) | Langware INC. | FE23D8CEA5E176DFF5584260B1C45436E45D6DB4 | 2026-06-28 11:01 → 2026-07-01 11:01 | Microsoft ID Verified CS AOC CA 03 | 06F826F5DDBB0A47AFC6BED6549B936461FFA7D0 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-06-29 09:45:53Z | unknown |
| v0.2.33 | 2026-06-29 | `3ad75693a66b275da63fb06833a120f4fb6a3c1ab229c09152ddac7c3802235b` | 96,921,048 | signed, chain OK (offline parse) | Langware INC. | FE23D8CEA5E176DFF5584260B1C45436E45D6DB4 | 2026-06-28 11:01 → 2026-07-01 11:01 | Microsoft ID Verified CS AOC CA 03 | 06F826F5DDBB0A47AFC6BED6549B936461FFA7D0 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-06-29 10:58:04Z | unknown |
| v0.2.34 | 2026-06-29 | `ae10df95ca867fb59c6ee9e295db788fb6d6a72446a3af183f77110af5f0db96` | 96,911,864 | signed, chain OK (offline parse) | Langware INC. | FE23D8CEA5E176DFF5584260B1C45436E45D6DB4 | 2026-06-28 11:01 → 2026-07-01 11:01 | Microsoft ID Verified CS AOC CA 03 | 06F826F5DDBB0A47AFC6BED6549B936461FFA7D0 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-06-29 08:04:00Z | unknown |
| v0.2.35 | 2026-06-29 | `b99e30d65975c5f218487402af7605799881955444269c056d816c5f2ee05fcb` | 96,921,192 | signed, chain OK (offline parse) | Langware INC. | FE23D8CEA5E176DFF5584260B1C45436E45D6DB4 | 2026-06-28 11:01 → 2026-07-01 11:01 | Microsoft ID Verified CS AOC CA 03 | 06F826F5DDBB0A47AFC6BED6549B936461FFA7D0 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-06-29 10:58:04Z | unknown |
| v0.2.36 | 2026-06-29 | `e558d185cd12ca6ce2ad2982997e0eb3e5feefc906dfe8f933a1f10f262db3ed` | 96,918,112 | signed, chain OK (offline parse) | Langware INC. | FE23D8CEA5E176DFF5584260B1C45436E45D6DB4 | 2026-06-28 11:01 → 2026-07-01 11:01 | Microsoft ID Verified CS AOC CA 03 | 06F826F5DDBB0A47AFC6BED6549B936461FFA7D0 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-06-29 15:42:18Z | unknown |
| v0.2.37 | 2026-07-06 | `e9ccc675393fbf09a4bc2f910623af21160b8059e73b1bc172f53e99a506f9af` | 96,581,456 | signed, chain OK (offline parse) | Langware INC. | F34835FBEABEAA3169214E8E7AF869BC1B4C9A32 | 2026-07-05 11:19 → 2026-07-08 11:19 | Microsoft ID Verified CS EOC CA 03 | C1E16A2011AA98EAA598F759A13BDA2E742D8881 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-07-06 08:04:00Z | unknown |
| v0.2.38 | 2026-07-27 | `2799574a7bd35e1548030fb30cc4796259372cf6e8ffe5daf508846057608753` | 96,591,472 | signed, chain OK (offline parse) | Langware INC. | 9D5ADC771B6AA3359A8CF44D3BDF82FDFDA1EB57 | 2026-07-26 12:31 → 2026-07-29 12:31 | Microsoft ID Verified CS AOC CA 03 | 06F826F5DDBB0A47AFC6BED6549B936461FFA7D0 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-07-27 12:40:05Z | unknown |
| v0.2.39 | 2026-07-29 | `afb3c48c86c0814d9c9e682a7eba38707037752aee03df01f377748be5b9580e` | 96,591,480 | signed, chain OK (offline parse) | Langware INC. | 4453D3D7C4528ED1B37D8A28E04CBBF35B22D064 | 2026-07-28 12:34 → 2026-07-31 12:34 | Microsoft ID Verified CS EOC CA 03 | C1E16A2011AA98EAA598F759A13BDA2E742D8881 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-07-29 12:19:50Z | unknown |
| v0.2.40 | 2026-08-03 | `4212fa243d3d04027aaf415acb4d3d34d6f5643777e2379b9878f9bd502f5a88` | 96,588,736 | signed, chain OK (offline parse) | Langware INC. | 346819EF44F8E1A4ACD08F5530ADC7F255615ED0 | 2026-08-02 12:56 → 2026-08-05 12:56 | Microsoft ID Verified CS EOC CA 03 | C1E16A2011AA98EAA598F759A13BDA2E742D8881 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-08-03 12:49:15Z | unknown |
| v0.2.41 | 2026-09-02 | `0c0dc4a3b9d7fc39eebea44cd4a97862cc8e78f4eae93e3a210a63fbb83090a9` | 96,636,960 | signed, chain OK (offline parse) | Langware INC. | CBA1CDC786ECF3336C4EDFD5293112A042EEF9F5 | 2026-09-01 15:04 → 2026-09-04 15:04 | Microsoft ID Verified CS EOC CA 03 | C1E16A2011AA98EAA598F759A13BDA2E742D8881 | present | Microsoft Public RSA Timestamping CA 2020 | 2026-09-02 14:28:25Z | unknown |

### Identity consistency

| Property | Across all 12 releases (v0.2.28 … v0.2.41, 2026-06-10 … 2026-09-02) |
| --- | --- |
| Signer subject | identical: `C=US, ST=Delaware, L=Wilmington, O=Langware INC., CN=Langware INC.` |
| Durable identity OID (EKU) | identical: `1.3.6.1.4.1.311.97.426392453.944483782.46922171.284290401` |
| Artifact Signing EKU `1.3.6.1.4.1.311.97.1.0` | present on every release |
| Root | Microsoft Identity Verification Root Certificate Authority 2020 (every release) |
| Policy CA | Microsoft ID Verified Code Signing PCA 2021 (every release) |
| Issuing CA | **alternates**: `Microsoft ID Verified CS EOC CA 03` (v0.2.28, .37, .39, .40, .41) and `Microsoft ID Verified CS AOC CA 03` (v0.2.31–.36, .38) |
| Leaf certificate | new every release (3-day validity; same leaf reused within a 3-day window, e.g. v0.2.31–.36 all on one leaf) |
| RFC 3161 timestamp | present on every release, TSA chain Microsoft Public RSA Timestamping CA 2020 (timestamp.acs.microsoft.com) |
| Signing account / profile | `langware-signing` / `langware-public` per CI config; cannot be read from the binary, but the identical durable OID implies the same certificate profile identity throughout |

So: **same organisation identity, same publisher CN, same durable OID, same account, on
every release**. The only variation is Microsoft's issuing CA, which alternates between two
sibling CAs (AOC 03 / EOC 03) under the same policy CA. We have **no evidence** that the
alternation affects reputation; it is noted, not concluded. If Microsoft support asks, the
table above is the answer.

## 3a. First measurement (2026-09-14)

Windows 11 Pro 10.0.26200 (the UTM VM, not a clean machine), Defender engine 1.1.26080.3,
Smart App Control off. Production `Flowpad-Setup.exe` v0.2.43 (SHA-256 `63d2992d…`,
published 2026-09-09, five days of public downloads), fetched by **winget** (which stamps
`ZoneId=3`) and launched by winget: **"Windows protected your PC — Microsoft Defender
SmartScreen prevented an unrecognized app from starting"**, buttons "Don't run" / "More info".
Publisher line under "More info": FILL IN. Classification: Defender SmartScreen reputation
prompt. The same file, written to disk by the launcher (no Mark of the Web), was verified and
would have started without any prompt (dry run).

## 4. How to test SmartScreen correctly (not yet done)

1. Clean Windows 11 VM (the UTM VM), Edge or Chrome, signed in to nothing special.
2. Download `Flowpad-Setup.exe` **through the browser** from the GitHub release URL so the
   Mark of the Web is applied. Do not copy the file in via shared folder or scp.
3. `Get-FileHash` — must equal the CI/release SHA-256 (table above).
4. `Get-AuthenticodeSignature` — `Valid`, `Langware INC.`, `TimeStamperCertificate` set.
5. Double-click. Record the exact dialog title and body text, and screenshot it.
6. Classify the dialog. These are different systems with different remedies:
   * "Windows protected your PC" + "More info" → **Defender SmartScreen** (reputation).
   * "This app has been blocked … Smart App Control" → **Smart App Control** (Win11, signed +
     reputation, cannot be bypassed per-file).
   * A named threat (`Trojan:Win32/…`, `Program:Win32/…`) → **Defender antivirus** detection
     (false-positive submission path, different from SmartScreen).
   * Browser "isn't commonly downloaded" bar → **browser download protection** (Edge uses
     SmartScreen too; Chrome uses Safe Browsing).
   * UAC "Verified publisher: Langware INC." → not a warning; expected.
7. Repeat with the winget/electron-updater path (no Mark of the Web) to confirm the dialog is
   specific to browser downloads.

## 5. If SmartScreen still appears on a fully verified build

Treat it as a Microsoft reputation matter. Do not redesign signing again. Do not tell users
to disable SmartScreen; do not implement bypasses.

Evidence package to assemble (template — fill from the CI run and the VM test):

```
Product / version:           Flowpad <version>
Installer:                   Flowpad-Setup.exe
SHA-256:                     <from release/signing-report.json>
Download URL:                https://github.com/langware-labs/flowpad/releases/download/<tag>/Flowpad-Setup.exe
Artifact Signing account:    langware-signing   (endpoint https://eus.codesigning.azure.net/)
Certificate profile:         langware-public    (Public Trust)
Publisher / subject:         CN=Langware INC., O=Langware INC., L=Wilmington, ST=Delaware, C=US
Durable identity OID:        1.3.6.1.4.1.311.97.426392453.944483782.46922171.284290401
Chain:                       Langware INC. ← Microsoft ID Verified CS {AOC|EOC} CA 03 ← Microsoft ID Verified Code Signing PCA 2021 ← Microsoft Identity Verification Root CA 2020
signtool verify /pa /v:      <paste output>
Timestamp:                   RFC 3161, http://timestamp.acs.microsoft.com, <date>
SmartScreen dialog:          <exact title/body text> + screenshot
Windows version:             <winver build>
Tested at:                   <UTC date/time>
Signing history:             12 releases since 2026-06-10, identical identity (table in SMARTSCREEN.md §3)
```

Submission paths:
* Microsoft Security Intelligence, https://www.microsoft.com/wdsi/filesubmission — as
  "Software developer"; the form is interactive (Microsoft account), there is no public API.
  Microsoft states this influences enterprise/managed reputation, not a guaranteed consumer
  bypass.
* Azure support case on the Artifact Signing resource — attach the same package; ask whether
  the account's durable identity carries the expected SmartScreen reputation and whether the
  AOC/EOC CA alternation is expected.

## 6. Distribution options (research only — not implemented)

| Channel | First-install SmartScreen prompt | Notes |
| --- | --- | --- |
| GitHub direct `.exe` (today) | yes, per new hash, until reputation accrues | browser applies Mark of the Web |
| MSIX sideloaded from a browser | yes | App Installer runs the same reputation check; format change alone does not remove it |
| winget | **yes** (measured 2026-09-14) | winget stamps the downloaded installer with `ZoneId=3` and launches it, so SmartScreen evaluates it like a browser download; not a bypass. Still a valid distribution channel, not a SmartScreen remedy |
| electron-updater (existing updates) | none | downloads without Mark of the Web and verifies SHA-512 + publisher; already the case |
| Launcher / bootstrapper (permanent signed stub that downloads the setup) | yes while the stub is new, then none until the stub's bytes change | must never be rebuilt per release; must verify what it runs; no packing/encryption |
| Microsoft Store | never | Microsoft re-signs and distributes; the only channel Microsoft documents as free of the prompt; separate Partner Center submission, `appx` target |

No claim is made that changing the installer format eliminates SmartScreen; only the Store
path (Microsoft-signed) and no-Mark-of-the-Web installs (electron-updater, the launcher's
payload) avoid it. **Correction 2026-09-14:** winget was previously listed here as prompt-free;
it is not — it applies the Mark of the Web to the installers it downloads.
