---
id: 684208ee-360e-50e6-a71e-b642ca95ac57
---

# PyPI Deployment Guide

## Prerequisites

- PyPI credentials configured (either `TWINE_API_TOKEN` env var or `~/.pypirc`)
- `uv` installed (or `python3 -m build` / `python3 -m twine` as fallback)

## Quick Deploy (bump + publish in one shot)

> **Deploy from the release branch.** PyPI is released from the highest
> `release/vX.Y` branch, and the version bump must land on that same branch so
> its `flow_sdk/_version.py` always equals the version published to PyPI. Never
> release from a feature branch or `main` — the bump would diverge and the
> branch/PyPI versions would drift apart (a real bug we've hit).

```bash
# 0. Check out the highest release/vX.Y branch — the deploy source.
git fetch origin --prune
RELEASE_BRANCH=$(git branch -r | grep -oE 'release/v[0-9]+\.[0-9]+' | sort -t. -k2,2n -u | tail -1)
git checkout "$RELEASE_BRANCH" && git pull --ff-only origin "$RELEASE_BRANCH"

# 1. Bump version — base off the HIGHER of PyPI and the branch's current
#    version (never go backwards), then increment the patch.
curl -s https://pypi.org/pypi/flowpad/json | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['version'])"
echo '__version__ = "0.2.X"' > flow_sdk/_version.py

# 2. Clean old artifacts
rm -rf dist/ build/ flowpad.egg-info/

# 3. Build UI assets (required — embeds frontend into wheel)
python3 build_ui.py

# 4. Build wheel + sdist (uv reads the version from _version.py; no `build` module needed)
uv build

# 5. Publish to PyPI
python3 -m twine upload dist/flowpad-0.2.X*

# 6. Commit + push the bump to the release branch so it matches PyPI.
git add flow_sdk/_version.py
git commit -m "chore: bump version to 0.2.X for PyPI release"
git push origin HEAD
```

## Validate Before Publishing

Check the wheel contains no unexpected heavy deps (e.g. `lancedb`):

```bash
unzip -p dist/flowpad-0.1.X-py3-none-any.whl "flowpad-0.1.X.dist-info/METADATA" | grep "Requires-Dist" | sort
```

## Validate After Publishing

Test in a clean isolated environment:

```bash
# Using venv
python3 -m venv /tmp/flowpad-test && /tmp/flowpad-test/bin/pip install flowpad==0.1.X

# Using uv tool
uv tool install flowpad --force

# Smoke test
/tmp/flowpad-test/bin/flow --help
```

## Local Deployment

Rehearse a release end-to-end on your own machine — exactly as if the package had
shipped to PyPI and the desktop app pulled the update — **without publishing
anything**. Give the build a throwaway local version so you can prove the running
server is *your* build and not the installed/published one.

> Give it `<version>+local` (e.g. `0.2.38+local`). This is a PEP 440 *local
> version label* — the `+` is required; a bare `-local` will not build.
>
> **Redeploying the same base version?** Check what's installed first (bare
> `flow` prints it). If that version already carries a local label, use the
> next number as the suffix: `+local2`, `+local3`, … Never reuse a label that
> is already deployed — with an identical version string you can't tell from
> `flow` / `upgrade --info` whether the running server is the new build or the
> previous one.

### 1. Stop the desktop app if it's running (and remember whether it was)

```bash
WAS_UP=$(pgrep -f "Flowpad.app" >/dev/null && echo 1 || echo 0)
[ "$WAS_UP" = 1 ] && osascript -e 'quit app "Flowpad"'
```

### 2. Build + install locally with a `+local` version

```bash
echo '__version__ = "0.2.38+local"' > flow_sdk/_version.py
rm -rf dist build flowpad.egg-info
python3 build_ui.py            # REQUIRED — bakes the UI into the wheel
python3 -m build               # or: uv build

# Install the freshly built wheel the SAME way your `flow` is installed
# (this is what `flow upgrade` auto-detects):
uv tool install --force ./dist/flowpad-*.whl
#   ...or for a pip install:
#   pip install --force-reinstall ./dist/flowpad-*.whl
```

### 3. Verify the prod server starts on 9007 and is the updated build

The desktop runs the **uv-tool** `flow`, so verify against that binary explicitly —
a repo editable install on your `PATH` reads `_version.py` live and would give a
false positive. The version is printed by **bare `flow`** (no subcommand);
`flow --version` is not a flag.

```bash
FLOW=~/.local/share/uv/tools/flowpad/bin/flow   # or `which flow` for a pip install

"$FLOW"                         # → flow 0.2.38+local   (bare flow prints version)
"$FLOW" stop                    # drop any old server/monitor first
FLOWPAD_NO_BROWSER=1 "$FLOW" start   # prod → http://127.0.0.1:9007 (no browser, like Electron)

# Wait for health — BOUNDED. A healthy start binds 9007 in a few seconds; if it
# doesn't, the start FAILED (it didn't just need more time — see the pitfall
# below), so fail loud and print the server log instead of polling forever.
for i in $(seq 1 15); do
  curl -fsS http://127.0.0.1:9007/api/v1/graph/bootstrap >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS http://127.0.0.1:9007/api/v1/graph/bootstrap >/dev/null 2>&1; then
  echo "FAILED: nothing bound 9007 — start did not come up. Last server log:"
  tail -20 "$(ls -t ~/.flow/instances/prod/logs/server/*.log | head -1)"
  exit 1
fi

"$FLOW" upgrade --info          # JSON status; "version" must read 0.2.38+local
echo "9007 OK"
```

Bare `flow` and the `version` field of `flow upgrade --info` must both read
`0.2.38+local`, and the server must answer on **9007** (prod port; dev is 9008).
Note `flow upgrade --info` reports the *installed* binary's version even when no
server is listening — so it is **not** proof the server came up. The bound-port
check above is what proves it; don't skip it.

### 4. Restart the desktop only if it was up at the start

```bash
[ "$WAS_UP" = 1 ] && open -a Flowpad
```

When done rehearsing, `git checkout flow_sdk/_version.py` to discard the `+local`
marker.

> **"Patch desktop" (the full prod-parity operation):** the steps above deploy the
> **backend wheel**. "Patch desktop" means BOTH halves built from the **latest release
> branch published on PyPI** (never the dev checkout): the backend wheel as
> `<latest>+local<count>`, and the Electron shell's `main.js` from the release tip stamped
> `<latest>-patch<count>` — incl. the macOS App-Management / asar-integrity / ad-hoc-resign
> gotchas — see
> [`local_patch.md` → Patching the desktop app (Electron shell)](./local_patch.md#patching-the-desktop-app-electron-shell).

## Known Pitfalls

### `flow start` silently no-ops when another instance backend is alive

`flow start` runs a singleton check and **exits without binding 9007** if it
detects an already-running `flow_sdk.server.run`, logging
`[singleton] Server already running (pid=…) — exiting`. A repo `.venv` dev
backend (e.g. the `oss`/`dev` instance on **9008**) trips this, so prod never
comes up. Worse, `"$FLOW" stop` can report **"Nothing was running"** — it only
manages the prod server it launched, not that other instance — giving false
comfort that the port is free.

Symptom: the verify loop never sees 9007 (the old unbounded `until curl …`
hung forever here). Diagnose, don't widen the wait:

```bash
tail -5 "$(ls -t ~/.flow/instances/prod/logs/server/*.log | head -1)"  # → the singleton line + offending pid
lsof -nP -p <pid> -iTCP -sTCP:LISTEN          # confirms it's a *different* instance (9008), not prod
```

If that process is your own dev instance, stop **that** instance (or run the
rehearsal on a port it isn't using) — do not just kill an unknown backend, and
never paper over it by extending the health-wait.

### Branch version drifts from the published PyPI version

If you deploy from a feature branch (or don't push the bump), the release
branch's `flow_sdk/_version.py` falls behind what's on PyPI. Always release from
the highest `release/vX.Y` branch (Quick Deploy step 0) and push the bump back
to it (step 6) so the two never diverge.

### `No module named build`

`python3 -m build` needs the `build` package, which isn't always installed. Use
`uv build` instead — it reads the version from `_version.py` and produces the
same `dist/flowpad-<version>-py3-none-any.whl` + `.tar.gz`.

### `npm: command not found` during `build_ui.py`

`build_ui.py` shells out to `npm`, which isn't on the PATH when node is
nvm-managed. Put it on the PATH first, e.g.:

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
```

### Server module paths must use `flow_sdk.server.*`

The server was merged from a standalone `server/` package into `flow_sdk/server/`. Any subprocess spawn must use the new path:

- `python -m flow_sdk.server.run` (NOT `python -m server.run`)
- `python -m flow_sdk.server.launch` (NOT `python -m server.launch`)
- uvicorn app string: `"flow_sdk.server.app:app"` (NOT `"server.app:app"`)

These appear in `flow_sdk/server/launch.py` (`start_server_process`, `start_monitor_detached`) and `flow_sdk/server/run.py` (uvicorn reload mode).

### Build UI before building wheel

`build_ui.py` compiles the React frontend into `flow_sdk/server/static/`. Without it, the wheel ships a stale or empty static dir and the server 404s on all JS/CSS.

### Heavy transitive deps break installs on new Python versions

`lancedb[embeddings]` was previously a dep and pulled in `ibm-watsonx-ai` → `pandas<2.2.0` which fails to build on Python 3.14+. It has been removed. If adding new ML-related deps, verify they install cleanly on Python 3.12–3.14 before publishing.

### PyPI propagation delay

After `twine upload`, the version may not be immediately available via `pip install`. Wait ~15–30 seconds before testing.

### `uv tool run flow` conflict

`uv tool run flow` resolves to a different package named `flow` on PyPI. Use `uvx --from flowpad flow` or the installed binary path directly (`~/.local/share/uv/tools/flowpad/bin/flow`).
