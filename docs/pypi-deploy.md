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
