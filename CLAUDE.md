# Claude Guidelines for flow-cli

## Quick Start

### Prerequisites (Windows)

This repo uses git symlinks. On Windows, enable symlink support so they are checked out correctly:

```bash
# Enable symlinks globally (requires Developer Mode or elevated shell)
git config --global core.symlinks true
```

### Local Environment

Ports are configured in `.env.local` (repo root) and `ui/.env.local`:

| Variable | File | Purpose |
|----------|------|---------|
| `LOCAL_SERVER_PORT` | `.env.local` | Backend server port |
| `VITE_PORT` | `.env.local` | Frontend dev server port |

### Backend

```bash
# Install Python dependencies and start the backend server
uv run -m flow_sdk.server.run
```

The server runs at `http://localhost:$LOCAL_SERVER_PORT`. Bootstrap endpoint: `http://localhost:$LOCAL_SERVER_PORT/api/v1/graph/bootstrap`

### Frontend

```bash
# Install Node dependencies
cd ui && npm install

# Start the Vite dev server
npm run dev
```

The frontend runs at `http://localhost:$VITE_PORT` and calls the backend at `http://localhost:$LOCAL_SERVER_PORT` via the `__API_URL__` define in `vite.config.ts`.

> **Hub at `$FLOWPAD_HUB_URL` (default `localhost:8093`) is served by `/Users/shlom/Documents/dev/test_flowpad/FlowPad/` (run via `flowpad/run.py`, ships `flowpad/hub/routers/auth.py` with `/api/v1/login`) — NOT the minimal `flow-hub/` stub in this tree. Don't `pkill`/install into the wrong one.**

### Building for pip install

```bash
# Build UI assets into server/static/ (REQUIRED before packaging)
python build_ui.py

# Build the wheel
uv build
```

`build_ui.py` must run before `uv build` — it compiles the frontend into `server/static/assets/` which gets included in the wheel via `package-data` in `pyproject.toml`. Without this step, the pip-installed server will serve the HTML shell but 404 on JS/CSS assets. The deploy script (`scripts/deploy_to_github.sh`) runs `build_ui.py` automatically.
