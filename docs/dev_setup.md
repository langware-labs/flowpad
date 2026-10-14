---
id: ca3d6613-3fc8-50e1-a0a5-92fa6da3638c
---

# Developer Setup

## PyCharm Import Resolution

### Problem

PyCharm may show unresolved import errors (red underlines) for `flow_sdk.*` imports even though the code runs correctly. For example:

```python
from flow_sdk.mcp_server.mcp_api import flow_ping  # PyCharm: "Cannot find reference"
```

No code changes are needed — the imports work at runtime.

### Root Cause

`flow_sdk` is a plain package at the repo root (`flow_sdk/`), found by `[tool.setuptools.packages.find]` (`include = ["flow_sdk*"]`) in `pyproject.toml`. When installed in editable mode (`uv sync` / `pip install -e .`), setuptools does not add the repo to `sys.path`; it generates an `_EditableFinder` meta path hook in `site-packages/` that maps the import name to the checkout:

| Import path | Actual filesystem path |
|---|---|
| `flow_sdk` | `<repo>/flow_sdk/` |
| `flow_sdk.mcp_server` | `<repo>/flow_sdk/mcp_server/` |

Key details:

- The mapping lives in `.venv/lib/python3.*/site-packages/__editable___flowpad_*_finder.py` (`MAPPING = {'flow_sdk': '<repo>/flow_sdk'}`, plus a `NAMESPACES` table for data-only directories), which hooks into `sys.meta_path`.
- An IDE that resolves imports from filesystem paths only, without running that finder, may not see the package unless the repo root is on its source path.

### How to Verify

The imports resolve correctly at runtime:

```bash
uv run python -c "import flow_sdk.mcp_server; print(flow_sdk.mcp_server.__file__)"
# -> <repo>/flow_sdk/mcp_server/__init__.py
```

### Workaround

Mark the repo root (the directory that contains `flow_sdk/`) as a **Sources Root** in PyCharm, so `flow_sdk.*` imports resolve from the filesystem.

The remaining red underlines on `flow_sdk.*` imports are cosmetic — they do not affect runtime behavior, tests, or builds.

## Cookie gate off switch

Every backend refuses requests that don't carry its local cookie-gate token
(`<flow_home>/instances/<instance>/.cookie_gate`, see [cookie-gate](cookie-gate.md)). A Vite dev
frontend on another port, or a bare `curl`, has no token, so dev backends run with the gate off:

```bash
FLOWPAD_COOKIE_GATE=off uv run -m flow_sdk.server.run
```

`scripts/instance_ctl.sh`, `docker/docker-compose.yml`, CI e2e and the test suite already set it.
The switch is read when the backend starts: restart the backend after changing it.
