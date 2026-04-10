# Claude Guidelines for flow-cli

## Quick Start

### Prerequisites (Windows)

This repo uses git symlinks. On Windows, enable symlink support so they are checked out correctly:

```bash
# Enable symlinks globally (requires Developer Mode or elevated shell)
git config --global core.symlinks true
```

### Backend

```bash
# Install Python dependencies and start the backend server (port 9007)
uv run -m server.run
```

The server runs at `http://localhost:9007`. Bootstrap endpoint: `http://localhost:9007/api/v1/graph/bootstrap`

### Frontend

```bash
# Install Node dependencies
cd ui && npm install

# Start the Vite dev server (port 4097)
npm run dev
```

The frontend runs at `http://localhost:4097` and calls the backend at `http://localhost:9007` via the `__API_URL__` define in `vite.config.ts`.

### Building for pip install

```bash
# Build UI assets into server/static/ (REQUIRED before packaging)
python build_ui.py

# Build the wheel
uv build
```

`build_ui.py` must run before `uv build` — it compiles the frontend into `server/static/assets/` which gets included in the wheel via `package-data` in `pyproject.toml`. Without this step, the pip-installed server will serve the HTML shell but 404 on JS/CSS assets. The deploy script (`scripts/deploy_to_github.sh`) runs `build_ui.py` automatically.

