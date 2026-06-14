---
id: 23897332-8b35-504e-8b94-1234fe32ea0b
---

# Local Hot-Patch Runbook

How to apply a **single-commit hot-patch** to the locally-installed `flowpad` (the
uv-tool deployment from [`pypi-deploy.md`](./pypi-deploy.md) → _Local Deployment_) **in
place, without rebuilding the wheel and without running tests.**

> **Two surfaces, two patch paths.** This runbook (sections below) patches the **backend**
> (`flow_sdk` Python in `site-packages`). To patch the **Electron desktop shell** itself —
> `electron/main.js` bundled inside the installed `Flowpad.app`'s `app.asar` — jump to
> [Patching the desktop app (Electron shell)](#patching-the-desktop-app-electron-shell). The
> two are independent: a backend patch never touches the `.app`, and a shell patch never
> touches `site-packages`.

This is the **local mirror** of the hub's [`cloud_patch.md`](../../test_flowpad/FlowPad/docs/cloud_patch.md).
Same principle — `git archive` a commit, overlay it straight onto the running
deployment, restart the service:

| | Cloud (hub VM) | Local (uv-tool install) |
| --- | --- | --- |
| capture | `git archive <SHA>` | `git archive <ref>` |
| transport | `… \| ssh --tunnel-through-iap` | (none — same machine) |
| overlay | `sudo tar -xf - -C /opt/flowpad_app/flowpad-hub-X.Y.Z` | `tar -xf - -C <site-packages>` |
| restart | `sudo systemctl restart flowpad` | `flow stop && flow start` |
| health | `$(hostname -i):8000/api/v1/health/version` | `127.0.0.1:9007/api/v1/graph/bootstrap` |

> ⚠️ **This is the fast inner-loop path, not the deploy path.** The supported way to ship
> a build is the full **Local Deployment** in [`pypi-deploy.md`](./pypi-deploy.md)
> (`build_ui.py` → `uv build` → `uv tool install`). Use this runbook to iterate quickly on
> backend code already installed. **No tests are run** — that is by design; verify behavior
> yourself. Any patch is wiped the next time you run the full local deployment (see
> _Lifetime_).

---

## TL;DR

```bash
scripts/local_patch.sh                              # overlay flow_sdk @ HEAD + restart
scripts/local_patch.sh <ref>                        # overlay flow_sdk @ <ref> + restart
scripts/local_patch.sh -- flow_sdk/server/app.py    # single-file patch @ HEAD (cleaner)
scripts/local_patch.sh <ref> --ui                   # backend + rebuilt frontend
scripts/local_patch.sh --dry-run -- flow_sdk/...    # list what would change; apply nothing
```

The raw mechanism the script runs (backend, one file):

```bash
SP=$(~/.local/share/uv/tools/flowpad/bin/python3 -c 'import sysconfig;print(sysconfig.get_paths()["purelib"])')
git archive HEAD flow_sdk/server/app.py | tar -xf - -C "$SP"
( cd ~ && flow stop && FLOWPAD_NO_BROWSER=1 flow start )
```

`git archive` emits a tar of **tracked files at that commit** (no `.git`, no working-tree
noise). `tar -xf -` **overlays** them in place — it overwrites matched files but does
**not** delete untracked ones.

---

## Why it works (topology facts)

The uv-tool install is **not** a container and **not** an editable/`-e` link — it is a
plain **copy** of the wheel's `flow_sdk/` package under the tool's `site-packages`. So
overwriting `.py` files there + restarting the process re-imports the patched code, exactly
like the hub's source-tree systemd service.

- **Install dir** (the local `<APP_DIR>`): `~/.local/share/uv/tools/flowpad/lib/python3.13/site-packages`.
  Resolve it cwd-independently with
  `~/.local/share/uv/tools/flowpad/bin/python3 -c 'import sysconfig;print(sysconfig.get_paths()["purelib"])'`.
  **Do not** resolve it by importing `flow_sdk` from the repo — cwd shadows the install and
  you'd get the working tree instead.
- **Installed package**: the wheel ships **only `flow_sdk`** (`top_level.txt`). Paths
  outside `flow_sdk` are not part of the running program — the script warns and the server
  ignores them.
- **Restart**: `flow stop && flow start` against the prod instance on **port 9007**. Run it
  from a **neutral dir** (the script uses `$HOME`): `run.py` loads the repo's `.env.local`
  with `override=True`, so a repo-cwd `flow start` would hijack `FLOW_INSTANCE=oss` / port
  9008 instead of prod. (Same `.env.local` override trap noted in the local-deploy notes.)
- **Python pin**: the install must be on **Python 3.13** — the wheel deadlocks on startup
  under 3.14. The patch does not change the interpreter; the deployment already pinned it.

---

## The flow

### 0. Prereqs
- A local deployment exists (`flow` at `~/.local/share/uv/tools/flowpad/bin/flow`). If not,
  run **Local Deployment** in [`pypi-deploy.md`](./pypi-deploy.md) first.
- The commit you want to ship exists in your repo. **Uncommitted edits are not captured** —
  commit them, or pass `git stash create`'s sha as `<ref>`.

### 1. Capture the baseline (the script prints this)
Current installed version + whether 9007 is answering — so you can prove the change and
roll back.

### 2. Patch + restart
```bash
scripts/local_patch.sh <ref> -- <path> ...
```
The script: `git archive <ref> -- <paths>` → tar → overlay into `site-packages` →
**sha-verify** the first `.py` against the ref (proves the bytes landed) → `flow stop` →
`flow start`.

### 3. Verify
The script polls `127.0.0.1:9007/api/v1/graph/bootstrap` until healthy (a few seconds warm)
and prints `flow upgrade --info`.

> **Note:** like cloud patch, a **code-only** patch does **not** change the reported
> `version` — verify the **behavior** (or instance logs), not the version string, unless you
> intentionally bumped `flow_sdk/_version.py` in the commit.

---

## Timing

| Phase | Expected |
| --- | --- |
| `git archive \| tar` overlay | < 1s |
| `flow stop` | ~1s |
| `flow start` → healthy on 9007 | ~1–5s warm (cold first boot longer) |

No network hop, no VM, no 30s Neo4j connect — the local loop is seconds, not ~30s.

---

## Special cases

- **Frontend change (`ui/**`)**: the served bundle is the **built** `flow_sdk/server/static/`,
  not source. Pass `--ui` — the script runs `build_ui.py` then overlays the rebuilt static
  into the install. (Local analog of the hub's "rebuild on the box".) Heavier (~30s build);
  skip it for backend-only patches.
- **Dependency change (`pyproject.toml` / `uv.lock`)**: an overlay does **not** install deps.
  Re-run the full **Local Deployment** (`uv tool install`) — the script warns if a manifest
  is in the patch set.
- **Backend-only change**: the TL;DR is complete. Nothing extra.
- **Deleted files**: `tar -x` overlays, it does **not** remove files the commit deleted. If a
  deletion matters, delete the file from `site-packages/flow_sdk/...` by hand (or re-run the
  full local deployment).

---

## Rollback

Symmetric — re-ship the original file(s) from the prior commit/tag and restart:

```bash
scripts/local_patch.sh <original-ref> -- <path> ...
```

Or re-run the full **Local Deployment** to realign the install with a freshly-built wheel.

---

## Lifetime — what survives, what wipes the patch

- ✅ **Survives `flow stop` / `flow start` and a machine reboot** — the patched files live in
  `site-packages`; restarting just re-imports them.
- ❌ **Wiped by the next `uv tool install`** (i.e. running the full Local Deployment again) —
  that replaces the whole `flow_sdk/` copy with the wheel's. So a local patch lasts **until
  your next full local build**, which then "aligns" the install.

So if a fix matters beyond your next local build, **commit it to the branch** — don't leave
it only in the overlaid `site-packages`.

---

## Validated end-to-end (2026-06-03)

`scripts/local_patch.sh -- flow_sdk/server/app.py` against the `0.2.39+local` install:
baseline (up on 9007) → capture (1 file) → overlay → **sha-verified in place** → `flow stop`
→ `flow start` → healthy on 9007 in **~1s**. `--dry-run`, bad-ref, and dep-manifest-warning
paths all behaved.

---

# Patching the desktop app (Electron shell)

The sections above patch the **backend**. This one patches the **Electron shell** — the code
in `electron/` (`main.js`, `preload.js`, …) that ships **bundled inside the installed
`Flowpad.app`** as `Contents/Resources/app.asar`. Reach for this when you change main-process
behaviour (window/IPC/menu, deep-link, mouse back-forward, updater, secrets) and need to see
it run inside the real desktop shell — not just `MINIHUB_DEV=true electron .`.

The user-stated workflow is: **kill the app naturally → patch the app → start the app**, and
it must behave **"as if it were truly production"** (same hardened-runtime launch, same
`flow`-spawned backend on **9007**).

## What "patch desktop" means (canonical definition)

**"Patch desktop" is two halves, from ONE source, never mix-and-match. The SDK half always
runs; the shell half runs ONLY when `electron/` actually changed:**

1. **The SDK / backend local deployment — ALWAYS.** Build the wheel (`build_ui.py` →
   `uv build`) and `uv tool install --force --python 3.13` it, so the server on **9007** is
   your code (Local Deployment in [`pypi-deploy.md`](./pypi-deploy.md)). This is **not
   optional** — a shell-only asar patch leaves the backend + served UI stale and the two
   halves drift (observed 2026-06-14: backend at `0.2.53+local`, shell still `0.2.52-patch1`,
   tabs broken). After installing, **restart the app** (quit → `open`) so the shell respawns
   the new backend and serves the rebuilt UI — even when the shell asar itself is untouched.
2. **The Electron shell asar patch — ONLY IF `electron/` CHANGED.** The asar repack + integrity
   rewrite + ad-hoc re-sign is the expensive half; skip it entirely when `main.js` (etc.) is
   byte-identical to what's already in the deployed `~/Flowpad-patched.app` asar. Gate it:
   ```bash
   git show HEAD:electron/main.js > /tmp/main_head.js
   node -e 'const a=require("./electron/node_modules/@electron/asar"),fs=require("fs");
     const inAsar=a.extractFile(process.env.HOME+"/Flowpad-patched.app/Contents/Resources/app.asar","main.js");
     process.exit(Buffer.compare(inAsar,fs.readFileSync("/tmp/main_head.js"))?1:0)' \
     && echo "unchanged — SKIP repack" || echo "changed — repack (steps below)"
   ```
   When skipped, the shell keeps its existing `-patch<count>` stamp (no bump — nothing in the
   bundle changed); only bump `-patch<count>` on an actual repack.

Both halves MUST come from the **same source**, and the versions prove it:

* **Default source = the latest release published on PyPI.** Fetch `origin/release/v0.2`,
  verify its tip's `_version.py` equals the live PyPI latest
  (`curl -fsS https://pypi.org/pypi/flowpad/json` → `info.version`); take the wheel from a
  worktree of that tip and `main.js` via `git show origin/release/v0.2:electron/main.js`.
  Backend installs as `<latest>+local<count>`, shell stamps `<latest>-patch<count>`
  (the *release* version + counter, not the Electron bundle base, so About/logs name the
  release at a glance). Counters take the next free number; restart `-patch` at 1 when
  `<latest>` moves; never reuse a deployed label.
* **Building from the dev branch is a legitimate variant** when you want the in-flight work
  (e.g. a feature not yet released) — both halves still come from that one branch
  (`flow_sdk/_version.py` is `X.Y.Z`, stamp `X.Y.Z+local<count>` / `X.Y.Z-patch<count>`).
  Say which source you used; the rule is *no mixing*, not *release-only*.

> **Build OOM (large bundles):** `vite build` can exhaust node's default heap on big bundles
> (seen on 0.2.53). It's a real resource need, not a flake — run the UI build with
> `NODE_OPTIONS="--max-old-space-size=8192"`. Concurrent `instance_ctl` dev servers eat
> headroom; this is the clean fix, not killing their processes.

> **Which app is "the patched version"? (resolving the ambiguity.)** macOS TCC
> **App-Management** blocks editing `/Applications/Flowpad.app` from the terminal, so the
> canonical, unambiguous patched app is the **`~/Flowpad-patched.app` clone** produced below —
> **that is the build to launch and test**, not `/Applications/Flowpad.app` (which stays the
> pristine original). If you specifically need the patch to live in `/Applications` (so you can
> launch it the normal way), grant your terminal **App Management** once in System Settings →
> Privacy & Security → App Management, then point the steps below at `/Applications/Flowpad.app`
> instead of the clone. Default = the clone.

## What actually needs patching (and what doesn't)

The desktop backend is the **uv-tool install** on 9007 — the same plain *copy* of `flow_sdk`
under `~/.local/share/uv/tools/flowpad/.../site-packages` that the top of this runbook patches
(**not** an editable link to the repo; importing `flow_sdk` from the repo cwd shadows it and
*looks* editable — it isn't). So:

| Change | How it reaches the running app | Need to touch `app.asar`? |
| --- | --- | --- |
| **Backend `.py`** | overlay the file into the install + restart — `scripts/local_patch.sh` | no |
| **Frontend (`ui/**` / `ts_sdk/**`)** | `scripts/local_patch.sh <ref> --ui` — runs `build_ui.py` then overlays the rebuilt `static/` **into the install**; reload the window | no |
| **Electron `main.js` / `preload.js`** | **bundled in `app.asar` at build time** — stale until you repack | **yes** |

So a UI-only change needs the `--ui` overlay + a reload — **not** an asar repack. Only
main-process (`electron/`) changes require the steps below.

> ⚠️ **Most common miss.** Shell and renderer are independent surfaces, and a bare `build_ui.py`
> writes the **repo**'s `static/` while 9007 serves the **install** copy — so a UI change can be
> built and still not appear (the asar repack below ships `main.js`, never `ui/**`). Use
> `--ui` (it overlays into the install), then prove the renderer landed — swap in a string your
> change adds:
> ```bash
> curl -s http://localhost:9007/ | grep -oE '/assets/index[^"]+\.js' | head -1 \
>   | xargs -I{} curl -s http://localhost:9007{} | grep -c "inbox-search-input"   # >0 = live
> ```
> Validated 2026-06-10: an inbox text-search (`ui/` + `ts_sdk/` only) stayed invisible after a
> `main.js` asar patch — `build_ui.py` had run but the rebuilt bundle was never overlaid into the
> install. Overlay + reload fixed it; no asar repack needed.

## Version tag — `<pypi-latest>-patchN` (answer: yes, this works)

`electron/semver.js` (mirrored 1:1 in `flow_sdk/utils/semver.py`) treats any trailing "extra"
tag as **newer** than the bare triple — `0.2.52-patch1 > 0.2.52`, the *opposite* of the
SemVer pre-release rule, and intentional here. The triple is the **PyPI-latest release
version** (canonical definition above), not the Electron bundle's own base — early
iterations stamped the bundle base (`0.2.28-patchN`) and it made the About box useless for
telling which release the machine ran. Stamping `<latest>-patch1`, `-patch2`, … :

- survives the auto-updater (it never looks "older" → won't be auto-replaced), and
- is unmistakable in the log — boot prints `[update] desktop upgraded <prev> → 0.2.52-patch1`.

Stamp it in **two** places: the packed `app.asar/package.json` `version` (authoritative for
`app.getVersion()`) **and** `Info.plist:CFBundleShortVersionString` (Finder/About display).
Use the next `patchN` each iteration so you never confuse two patched builds; the counter
restarts at 1 when the release version moves.

## The four blockers (lessons — all hit on macOS 2026-06-10)

1. **`/Applications/Flowpad.app` is TCC App-Management protected.** Writing into a signed
   bundle there fails with `Operation not permitted` — and worse, `asar pack` **silently
   no-ops** (the file size/integrity hash stay identical, so it *looks* like it worked).
   Either grant your terminal **App Management** (System Settings → Privacy & Security), or —
   simpler and non-destructive — **clone the bundle out** (`ditto … ~/Flowpad-patched.app`)
   and patch the copy. The copy spawns the same `flow` backend on 9007, so it is functionally
   "production".
2. **`app.asar` has an integrity hash in `Info.plist`** (`ElectronAsarIntegrity:Resources/app.asar:hash`).
   After any repack you **must** rewrite it or the app refuses to load. The hash is **not**
   `sha256` of the file — it is `sha256` of the asar **header string**:
   `sha256( require('@electron/asar').getRawHeader(asarPath).headerString )`. (Verify your
   method first by reproducing the *unmodified* hash — it must match byte-for-byte.)
3. **The app is Developer-ID signed with hardened runtime** — any edit to the bundle breaks
   the signature and the OS kills it on launch. **Ad-hoc re-sign** with the checkout's
   entitlements (they grant `allow-jit` / `disable-library-validation`, which Electron's
   helpers need): result flags should read `adhoc,runtime`.
4. **Transplant only `main.js`, and take it from the release tip.** Ship
   `git show origin/release/v0.2:electron/main.js`, not the working tree — a checkout copy
   can smuggle unreleased shell features (validated 2026-06-11: a working-tree transplant
   shipped the unreleased `win/` focus-windows handler ahead of its frontend). Leave every
   other extracted file as the production build — don't wholesale-replace from the checkout
   (its `electron/package.json` version may have drifted).

> **Keychain note:** an **ad-hoc** copy has a different code signature than the Developer-ID
> original, so the OS may prompt once for keychain access to the existing `sod_key` item
> (created under `ai.flowpad.desktop`). Click **Allow** — it's not a failure.

## The flow

```bash
cd <repo-root>                              # this checkout
SRC=/Applications/Flowpad.app
DST="$HOME/Flowpad-patched.app"
ASAR="$DST/Contents/Resources/app.asar"
PLIST="$DST/Contents/Info.plist"
ASARBIN="$PWD/electron/node_modules/.bin/asar"

# 0a. Resolve the release: PyPI latest must equal the release tip's version
git fetch origin release/v0.2
LATEST=$(curl -fsS https://pypi.org/pypi/flowpad/json | python3 -c 'import json,sys;print(json.load(sys.stdin)["info"]["version"])')
git show origin/release/v0.2:flow_sdk/_version.py | grep -q "\"$LATEST\"" || echo "MISMATCH — release tip != PyPI $LATEST, stop and reconcile"
PATCHVER="${LATEST}-patch1"                 # next free patchN; counter restarts when LATEST moves

# 0b. Backend prerequisite: the wheel from that SAME tip, installed as <latest>+local<count>
#     (Local Deployment in pypi-deploy.md, built in a worktree of origin/release/v0.2).
#     Skip only if `flow` already prints that exact version.

# 0c. UI changes only: rebuild + overlay into the install — NO asar repack needed (see --ui above).

# 1. Kill the app naturally (quits the shell AND its child backend on 9007)
osascript -e 'tell application "Flowpad" to quit'
until ! pgrep -f "Flowpad.app/Contents/MacOS/Flowpad" >/dev/null; do sleep 0.5; done

# 2. Back up the originals (trivial rollback)
mkdir -p "$HOME/flowpad-patch-backup"
cp -p "$SRC/Contents/Resources/app.asar" "$HOME/flowpad-patch-backup/app.asar.orig"
cp -p "$SRC/Contents/Info.plist"         "$HOME/flowpad-patch-backup/Info.plist.orig"

# 3. Clone the bundle out of TCC-protected /Applications, then patch the copy
rm -rf "$DST"; ditto "$SRC" "$DST"
TREE=$(mktemp -d)/app
"$ASARBIN" extract "$ASAR" "$TREE"
git show origin/release/v0.2:electron/main.js > "$TREE/main.js"       # transplant ONLY main.js, FROM THE RELEASE TIP
python3 -c 'import json,sys; p,v=sys.argv[1:3]; d=json.load(open(p)); d["version"]=v; json.dump(d,open(p,"w"),indent=2)' \
        "$TREE/package.json" "$PATCHVER"                             # stamp app.getVersion()
rm -f "$ASAR"; "$ASARBIN" pack "$TREE" "$ASAR"                        # repack (no --unpack: this build has 0 unpacked entries)

# 4. Recompute the asar integrity hash and write it + the version into Info.plist
NEWHASH=$(node -e 'const c=require("crypto"),a=require("'"$PWD"'/electron/node_modules/@electron/asar");process.stdout.write(c.createHash("sha256").update(a.getRawHeader(process.argv[1]).headerString).digest("hex"))' "$ASAR")
/usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $NEWHASH" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PATCHVER" "$PLIST"

# 5. Ad-hoc re-sign (hardened runtime + checkout entitlements) and verify
codesign --force --deep --options runtime --entitlements electron/entitlements.mac.plist --sign - "$DST"
codesign --verify --deep --strict "$DST" && echo "codesign OK"        # flags should show: adhoc,runtime

# 6. Start the patched app
open "$DST"
```

## Verify

```bash
LOG="$HOME/.flow/logs/main_desktop/$(ls -t "$HOME/.flow/logs/main_desktop" | head -1)"
grep -E "desktop upgraded|nav-debug|Backend is ready|Loading UI" "$LOG"   # log path from electron/main.js
curl -fsS http://localhost:9007/health/status && echo " 9007 OK"
```

Expect `[update] desktop upgraded <base> → <base>-patch1`, then your main-process log lines,
then `Backend is ready!` / `Loading UI from http://localhost:9007`. **All Electron main-process
logs land in `~/.flow/logs/main_desktop/<ts>.log`** (electron-log); renderer `console.*` only
reaches that file if `main.js` forwards it (e.g. a `console-message` listener).

## Rollback

```bash
osascript -e 'tell application "Flowpad-patched" to quit' 2>/dev/null
rm -rf "$HOME/Flowpad-patched.app"            # the copy — the /Applications original was never touched
```

The pristine `/Applications/Flowpad.app` keeps running production. (Originals are also in
`~/flowpad-patch-backup/` if you patched in place after granting App Management.)

## Lifetime

- ✅ Survives relaunch/reboot — the patched copy is a normal `.app`.
- ❌ Wiped/superseded by the next desktop **release install or auto-update**, which replaces
  `/Applications/Flowpad.app` (the copy is independent and just goes stale vs. the new base).
- If a `main.js` fix matters beyond local debugging, **commit it to `electron/`** and ship a
  real desktop build — don't leave it only in the patched copy's `app.asar`.

## Validated end-to-end (2026-06-10)

Installed `Flowpad.app` `0.2.28` (hardened-runtime, Developer-ID "Langware Labs", asar
integrity present, 0 unpacked entries; packed `main.js` byte-identical to `HEAD`). Added
`[nav-debug]` logging to `electron/main.js`, `build_ui.py` for the renderer side, then:
in-place `/Applications` patch **blocked** by TCC App-Management (asar repack silently no-op'd)
→ pivoted to `ditto` clone → transplanted `main.js` + stamped `0.2.28-patch1` → repack →
integrity hash recomputed via `getRawHeader` (reproduced the original exactly, then the new
one) → ad-hoc re-sign (`adhoc,runtime`, verify OK) → launched. Log confirmed
`[update] desktop upgraded 0.2.28 → 0.2.28-patch1` and live `[nav-debug] main.did-navigate …`,
backend healthy on 9007.
