---
id: c84add08-2253-4e11-a84f-8725e57292a8
---
# Desktop <-> Backend Version Compatibility

The Electron desktop app and the PyPI `flowpad` backend (the "engine") release independently
(desktop `0.2.5x`, backend `0.2.2xx`). This contract guarantees they are never *automatically*
combined into a pair that cannot work together.

## The contract

Two floors, each owned and shipped by the side that declares it:

| File | Key | Meaning |
|---|---|---|
| `electron/engine-compat.json` (in the app asar) | `min_backend_version` | the oldest engine this desktop build accepts |
| `flow_sdk/compat.json` (in the wheel, via `package-data`) | `min_desktop_version` | the oldest desktop this engine release supports |

A pair is compatible only when **both** hold — a newer version is never assumed compatible:

```
backend_version  >= desktop.min_backend_version
desktop_version  >= backend.min_desktop_version
```

Comparisons use the shared semver pair (`electron/semver.js` ↔ `flow_sdk/utils/semver.py`),
including its deliberate "an extra tag sorts newer" rule, so both sides always agree. The files
are plain JSON objects; **unknown keys are ignored**, so the format can grow explicit ranges,
maximums, or per-version exceptions without breaking older readers.

**Pre-release and local tags satisfy a floor of the same `X.Y.Z`** (a floor is a comparison; whether a release
may be *chosen* is the separate final-release rule above). Under the project-wide rule
(a tag after the patch number sorts *newer* than the bare version) `0.2.50-rc1` and
`0.2.50+local1` both meet a floor of `0.2.50`, and `0.2.49-rc1` still does not meet it. This is
accepted on purpose: a floor names the first release that supports a contract, and the
release candidates and locally stamped builds of that release carry the contract too. The flip
side: a candidate cut *before* the breaking change that motivated the floor also passes, so set a
floor to the first version that actually contains the change. Changing the rule would change
`semver.js` and `flow_sdk/utils/semver.py` together and every version decision in the project,
not just these floors.

**Legacy policy:** a missing file or missing key means *no constraint* — releases that predate
the contract never declared one. An **unparseable** version against a *declared* floor is
rejected, with one deliberate exception: invalid metadata found in an already-installed engine
only logs a warning (it must not brick startup); upgrades to such a release are refused.

Logic lives in `electron/engine-compat.js` and `flow_sdk/utils/compat.py` (twins, with matching
failure wording). Both floors currently sit at `0.2.0`, so nothing changes until release
engineering raises one.

`compat.json` is deliberately **not** a `DataSpec` schema, and that exception to the "every shape that
travels is a `DataSpec`" rule was **approved by the repository owner on 2026-10-19**. The reason is the
constraint, not convenience: the file travels inside a wheel and must be readable as plain data by the
desktop (JavaScript, before any Python runs) and by a stdlib-only CI script, without importing
`flow_sdk` or its schema registry. The contract above is the whole schema; `flow_sdk/utils/compat.py`
validates it (`CompatError`). The same holds for `electron/engine-compat.json`. Do not extend the
exception to other shapes -- the small verdict types (`CompatVerdict`, `PairRollback`) stay in-process
and are not part of it.

## How each flow enforces it

**Desktop installing/upgrading the engine** (`electron/uv-manager.js`):

1. Candidates come from the PyPI JSON `releases` map, newest first, filtered to **final releases**
   (`isFinalRelease`: `X.Y.Z` or `X.Y.Z.postN` — a release candidate, dev build or tagged build is
   never chosen automatically; the version picker still lets a person choose one by hand),
   non-yanked, that meet the desktop's `min_backend_version`. The restriction to final releases is
   not cosmetic: the shared semver rule ranks any tag newer than the bare version, so left to the
   sort `0.2.223rc1` would beat `0.2.223`. A version string must also be release-shaped
   (`isInstallableVersion` — anchored, because it later becomes a `flowpad==X` argument). A release
   with no files left counts as withdrawn, exactly as the backend's own release list treats it.
2. A candidate's `min_desktop_version` is read **without executing package code** and, normally,
   without downloading the wheel: `electron/wheel-compat.js` asks the wheel's file host
   (`files.pythonhosted.org`, https only) for its end-of-central-directory record, the central
   directory, and just the bytes of `flow_sdk/compat.json` with HTTP Range requests — tens of KB,
   CRC-checked, so the pre-start update check never waits on a whole-wheel download. When that cannot
   be done (no Range support, ZIP64, an unexpected wheel URL) it falls back to
   `uv pip install --no-deps --only-binary :all: --target <tmp> flowpad==X`, which unpacks only that
   wheel (wheels run nothing at install time, and `--only-binary` means a release that ships only a
   source distribution is never built just to read one JSON file) and leaves it in uv's cache for the
   activation install. A wheel without `compat.json` is a pre-contract release (legacy).
   Both reads are bounded, so none of this can hold the app back from starting: a ranged request is
   abandoned after 20 seconds; once a server has answered a Range request with the whole file it is
   not asked again; and at most **two** whole wheels are unpacked per resolution — a proxy that strips
   `Range` therefore costs two downloads, not ten. A candidate whose floor stays unknown is accepted
   as legacy, and step 4 has the last word. Only each candidate's *floor* is cached for the session
   (`_readCandidateMinDesktop`); the resolution itself runs again on every call. Integrity rests on TLS
   plus the post-install check in step 4; PyPI's whole-file digest cannot cover a partial read.
3. The newest release passing both directions is installed with the existing pinned
   `uv tool install flowpad==X` path — all existing recovery machinery (interrupted-install
   marker, failed-upgrade restore, tool-dir lock handling) is unchanged. The target usually
   comes from PyPI's JSON API while uv resolves the pin against its own cached `/simple/` index
   (served with `max-age=600`), so a release published minutes ago can be "unsatisfiable" to uv
   (the 0.2.238 incident). Two defenses: `upgrade()` always passes `--refresh-package flowpad`
   (one conditional request revalidating that single index entry), and any other pinned install
   whose whole strategy ladder fails with uv naming the engine pin itself
   (`isEnginePinResolutionError`) is retried exactly once with the refreshed index — never under
   `--offline`, and never for a dependency conflict a refresh cannot fix.
4. After `installLatest` and `upgrade` the installed pair is re-verified from disk
   (`_verifyInstalledPairOrRollback`); if it fails (the selection ran on indeterminate
   metadata, or the engine ships invalid `compat.json`), the previous release is put back — from
   uv's cache first (`--offline`), because the network may be exactly what just failed or may never
   have held that version (a local build) — and a user-readable error is raised. When the old engine
   cannot be restored (or there was none) the error says so instead of claiming the installation was
   preserved, gives the command to run by hand, and the desktop repairs the pair at its next launch
   (step 6). `reinstall` (the broken-install repair) resolves the newest compatible release but does
   not verify afterwards: there is no healthy engine to roll back to, and step 6 is its backstop.
5. The pre-start update offer (`_pypiUpdateStatus`) names the newest **compatible** release, so
   the dialog never offers a version the install would then refuse. If PyPI's latest is
   incompatible and nothing newer than the installed engine is, no update is offered. The
   post-boot check, which asks the cloud for *its* latest, is filtered the same way
   (`_applyCompatToStatus`): otherwise the dialog would name one version and `upgrade()` install an
   older one — a silent downgrade, offered again on every launch. An agreed version that was
   withdrawn from PyPI in the meantime is replaced by the newest *compatible* release, not by
   "latest".
6. At startup, `main.js` checks the installed pair (`installedPairIssue`) — a desktop
   downgrade or a hand-moved engine is repaired by installing the newest compatible release,
   under the same `engineChangePolicy` gate as every other engine change. The repair has a
   **direction**: when the *engine* is the old side (below the desktop's floor) it is a plain
   upgrade and is done silently; when the *desktop* is the old side (the engine demands a newer
   desktop) the repair would move the engine backward — a newer engine may already have written
   state an older one cannot read — so the user is asked first ("Keep the current engine" is the
   default). Normally a newer desktop is already on offer in that case and the engine is held for
   it; the question appears only when the update feed says "current" while the engine disagrees.
   If repair is impossible or declined (offline, held, "Keep"), the app starts what is installed
   and warns, retrying next launch.
7. If PyPI answered and **no** release is compatible, the install/upgrade aborts with an
   actionable error and the existing installation is preserved.

When the contract cannot be evaluated (PyPI unreachable, no app version in dev runs), the
pre-contract behaviour is kept — install `latest` — and step 4 has the last word.

**The version panel** (FLOWPAD-2310): the UI's version popover drives the same machinery over IPC,
with in-app surfaces instead of native dialogs. Before `upgrade-flowpad`, the panel pre-flights the
latest release through `update:get-info` (`uv-manager.engineUpdatePreflight`: the candidate's floor
via the step-2 wheel read against this desktop). An incompatible latest opens the "Desktop Update
Required" popup — *Update Both* saves a consented `pending-engine.json` with `source: 'panel'` and
downloads the desktop (`update:both`); *Update Desktop Only* just downloads (`update:download-desktop`);
the panel's *Update Now* (`update:apply-desktop`) restarts into the new desktop, which installs the
saved engine version exactly as in the dialog flow and reports the outcome back to the panel
(`engine-update-resumed`, or pulled once via `update:get-info`). A desktop update downloaded in the
background and postponed with the native "Later" shows in the panel as ready, so it can be installed
from there at any time without waiting for the next quit. An indeterminate pre-flight
(`latestCompatible: null` — offline, unreadable metadata) proceeds, and steps 3–4 stay the
authoritative gates. The panel's engine upgrade (`upgrade-flowpad` →
`upgradeFlowpadAndRestart`) resolves its target while the backend still runs — a definitive
refusal returns as an error with nothing stopped — and a failure after the stop restores the old
engine through the same recovery the dialog path uses (`recoverAfterFailedUpgrade`), so the app
is never left on the loading splash over a dead backend.

**Backend self-update** (`flow upgrade`, `POST /api/v1/version/install`):

- A desktop-managed backend knows its desktop through env vars the Electron shell sets at
  `flow start`: `FLOWPAD_DESKTOP_VERSION` and `FLOWPAD_DESKTOP_MIN_BACKEND_VERSION`
  (`flow_sdk/utils/compat.py`). Headless/CLI installs see neither and are **never constrained**.
- Targets below the desktop floor are refused *before* installing
  (`self_update.desktop_compat_block`, reason `incompatible_desktop`).
- After an in-place reinstall, the **new** on-disk `flow_sdk/compat.json` is checked against the
  running desktop (`verify_installed_against_desktop`); on failure the previous version is
  reinstalled (from uv's cache first, then the network) and the endpoint reports
  `backend_requires_newer_desktop` — an incompatible pair
  is never scheduled to boot.
- `flow upgrade` applies the same pre-check and the same post-install verify→rollback
  (`self_update.rollback_if_incompatible`, shared by the route, the CLI and the detached Windows
  relay `upgrade_after_exit`, which records the outcome in its log file and loads `flow_sdk.utils.compat` from the
  running release *before* the install replaces it on disk, so a later release that renames what the check calls
  cannot kill the detached process with no log and no rollback). The desktop's startup
  pair check remains the backstop for anything that slips past.

**CLI check** (works against a staged install, no server, no network):

```bash
flow compat --desktop-version 0.2.45 [--desktop-min-backend 0.2.50] [--json]
# exit 0 = compatible, 1 = incompatible or broken metadata
```

With `--json` the verdict uses the shared CLI envelope: `{"ok": true, "compatible": ..., "reasons": [...], ...}`
(`ok` means the check ran; read `compatible` for the verdict). Broken metadata is
`{"ok": false, "error_code": "INVALID_COMPAT_METADATA", "error": ...}` on stderr.

## Releasing

- **Raising a floor** is a one-line edit to the owning file, in the same PR as the change that
  needs it (e.g. a breaking `flow start` contract change → bump `min_desktop_version`).
  Never hardcode the floors anywhere else.
- `scripts/check_version_compat.py` is the release gate:
  - It loads the contract itself (`flow_sdk/utils/compat.py`, from its file, under stub parent
    packages so no installed flowpad is needed) — it holds no second copy of the rules, so the
    gate cannot drift from the code it guards. Wheel URLs are accepted only on
    `files.pythonhosted.org` over https, and a yanked wheel is never the one read.
  - no flags: both files parse, floors are semver-parseable, and the backend version satisfies
    the desktop floor it bundles. `scripts/deploy_to_github.sh` runs it **first** — before the test
    run, the remote flow-rs signing and the version write, so a failure costs nothing — passing
    `--backend-version <the release about to be cut>`, so a floor raised to exactly the release it
    ships in is not rejected for the version it replaces. `tests/unit/test_version_compat.py`
    enforces the same invariants in CI.
  - `--resolve --desktop-version X`: proves desktop release X can resolve at least one
    compatible PyPI backend (reads candidate wheels' `compat.json` from the zip — no code
    executed). The desktop build pipeline (private `langware-labs/flowpad-desktop`,
    `build-desktop.yml`) runs this as its `check-compatibility` job against its checkout of
    this repo, and `create-release` is gated on it; a flowpad branch that predates the script
    skips the gate with a warning (the legacy policy). The PyPI fetch carries a unique query
    string, so the CDN edge lag after a fresh upload does not hide the newest release.

## Troubleshooting

- *"FlowPad Desktop X is not compatible with FlowPad Backend Y"* — the pair on disk violates a
  floor. The desktop repairs it on the next launch when it may; manually:
  `uv tool install flowpad==<compatible version> --force`.
- *Update dialog shows an older version than PyPI latest* — latest requires a newer desktop;
  the log line `[compat] latest <X> is not compatible with Desktop <Y> — using <Z>` says so.
  Update the desktop app to get latest.
- *`/version/install` refuses with `incompatible_desktop`* — the target is below the desktop's
  floor; pick a newer backend or update the desktop first.
- Diagnostic logging is tagged `[compat]` in the Electron log and
  `[version/install]` / `[self-update]` in the backend log.
