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

## Hub UI with hot reload against prod (localhost:4121)

Run the hub UI from this working tree, with Vite HMR, against the real prod hub (`app.flowpad.ai`).
Edits under `ui/src` show up live on prod data. A deploy or a hub-served SPA cannot show them,
because the hub serves the released `flowpad` bundle.

```bash
cd ui
PROXY_TARGET=https://app.flowpad.ai VITE_API_URL=http://localhost:4121 \
PROD_READ_ONLY=1 HUB_LOGIN=1 node_modules/.bin/vite --port 4121 --strictPort
```

Then open `http://localhost:4121/dock/hub/home`.

What each variable does (all in `ui/vite.config.ts`):

- `VITE_API_URL=http://localhost:4121`: the SPA calls its own origin, so the browser stays same-origin.
- `PROXY_TARGET`: where the dev server forwards `/api` (plus `/assets`, `/sdk`, the WS). Point it straight at
  the hub, not at a desktop on 9007. Through the desktop, the bootstrap says "desktop", and you get the desk
  page instead of the hub UI.
- `HUB_LOGIN=1`: signs the dev server in to the hub like the desktop does, through the hub's own OAuth
  (`client_id=flowpad-desktop`, PKCE S256, loopback redirect `http://localhost:4121/__hub_login/callback`).
  The SPA's `/api/v1/login` is answered by the dev server. The token is kept in the Vite process's memory
  only, and goes on every proxied request (HTTP and WS) as `Authorization: Bearer`. Restarting Vite means
  signing in again.
- `PROD_READ_ONLY=1`: only GET, HEAD and OPTIONS pass. Every write gets a 403, except the auth paths
  (`login`, `logout`, `auth`, `token`, `oauth`).

Why the login is needed: the prod session cookie belongs to `app.flowpad.ai`, so `localhost` has no session.
A plain proxy bounces you to the hub's login, which lands back on `app.flowpad.ai`. Never copy that cookie or
the JWT by hand; the OAuth path above is the sanctioned one.
