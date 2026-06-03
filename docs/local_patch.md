---
id: 23897332-8b35-504e-8b94-1234fe32ea0b
---

# Local Hot-Patch Runbook

How to apply a **single-commit hot-patch** to the locally-installed `flowpad` (the
uv-tool deployment from [`pypi-deploy.md`](./pypi-deploy.md) → _Local Deployment_) **in
place, without rebuilding the wheel and without running tests.**

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
