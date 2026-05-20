---
id: 4e876bca-361e-5f79-9239-b138b7a4951b
---

# Contributing to Flowpad

## Prerequisites

- Python 3.10+
- Node.js 18+
- [uv](https://docs.astral.sh/uv/) for Python dependency management

### Windows: Git Symlinks

This repo uses git symlinks. On Windows, enable symlink support before cloning:

```bash
git config --global core.symlinks true
```

(Requires Developer Mode or an elevated shell.)

---

## Development Setup

### Backend

```bash
uv sync                    # install Python dependencies
uv run -m server.run       # start backend server on port 9007
```

The backend serves the API at `http://localhost:9007`. Bootstrap endpoint: `http://localhost:9007/api/v1/graph/bootstrap`

### Frontend

```bash
cd ui
npm install                # install Node dependencies
npm run dev                # start Vite dev server on port 4097
```

The frontend runs at `http://localhost:4097` and proxies API calls to the backend.

---

## Project Structure

```
flowpad/
├── flow_sdk/                  # Python SDK package
│   ├── __init__.py            # version + public API re-exports
│   ├── _version.py            # version string
│   ├── cli/                   # CLI (Typer app)
│   ├── core/                  # Core infrastructure
│   ├── api/                   # API types
│   ├── db/                    # Database drivers (SQLite)
│   ├── builtin/               # Built-in entities
│   ├── actions/               # Action system
│   ├── hooks/                 # Hook system
│   ├── discovery/             # Service discovery
│   ├── fs_records/            # File system record CRUD
│   ├── fs_store/              # File system storage
│   ├── mcp_server/            # MCP server
│   └── client.py              # FlowpadClient
├── ts_sdk/                    # TypeScript SDK
├── server/                    # FastAPI server
│   ├── run.py                 # Server entry point
│   ├── server.py              # FastAPI app
│   ├── routes/                # API endpoints
│   ├── middleware/            # Request middleware
│   ├── reporters/             # Event reporters
│   └── static/                # Built UI assets (generated)
├── ui/                        # Frontend source (React/Vite)
│   ├── src/
│   ├── vite.config.ts
│   └── package.json
├── electron/                  # Electron desktop app wrapper
├── tests/                     # Backend tests (unit, api, cli)
├── pyproject.toml
└── build_ui.py                # Builds UI into server/static/
```

---

## Running Tests

```bash
# All backend tests (from repo root)
python -m pytest tests/ -v

# Unit tests only
python -m pytest tests/unit/ -v

# API tests only
python -m pytest tests/api/ -v

# CLI tests only
python -m pytest tests/cli/ -v

# Frontend tests
cd ui && npx vitest run

# Frontend build + lint
cd ui && npm run build && npm run lint
```

---

## Building for pip install

```bash
# 1. Build UI assets into server/static/ (required before packaging)
python build_ui.py

# 2. Build the wheel
uv build
```

`build_ui.py` must run before `uv build`. It compiles the frontend into `server/static/assets/` which gets included in the wheel via `package-data` in `pyproject.toml`. Without this step, the pip-installed server will serve the HTML shell but 404 on JS/CSS assets.
