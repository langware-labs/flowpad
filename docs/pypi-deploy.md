---
id: 684208ee-360e-50e6-a71e-b642ca95ac57
---

# PyPI Deployment Guide

## Prerequisites

- PyPI credentials configured (either `TWINE_API_TOKEN` env var or `~/.pypirc`)
- `uv` installed (or `python3 -m build` / `python3 -m twine` as fallback)

## Quick Deploy (bump + publish in one shot)

```bash
# 1. Bump version
echo '__version__ = "0.1.X"' > flow_sdk/_version.py

# 2. Clean old artifacts
rm -rf dist/ build/ flowpad.egg-info/

# 3. Build UI assets (required — embeds frontend into wheel)
python3 build_ui.py

# 4. Build wheel + sdist
python3 -m build

# 5. Publish to PyPI
python3 -m twine upload dist/flowpad-0.1.X*
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
# wait for health, then check the version the server reports:
until curl -fsS http://127.0.0.1:9007/api/v1/graph/bootstrap >/dev/null 2>&1; do sleep 1; done
"$FLOW" upgrade --info          # JSON status; "version" must read 0.2.38+local
echo "9007 OK"
```

Bare `flow` and the `version` field of `flow upgrade --info` must both read
`0.2.38+local`, and the server must answer on **9007** (prod port; dev is 9008).

### 4. Restart the desktop only if it was up at the start

```bash
[ "$WAS_UP" = 1 ] && open -a Flowpad
```

When done rehearsing, `git checkout flow_sdk/_version.py` to discard the `+local`
marker.

## Known Pitfalls

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
