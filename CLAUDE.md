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

## Package Structure

The repo has three top-level concerns: the Python SDK (`flow_sdk/`), the server (`server/`), and the frontend (`ui/`). The TypeScript SDK lives at `ts_sdk/`.

```
flow-cli/
├── flow_sdk/                  # Python SDK package
│   ├── __init__.py            # version + public API re-exports
│   ├── _version.py            # version string
│   ├── fs_records/            # File system record CRUD
│   ├── fs_store/              # File system storage
│   ├── hooks/                 # Hook system
│   ├── utils/                 # General utilities
│   ├── discovery/             # Service discovery
│   ├── mcp_server/            # MCP server
│   ├── client.py              # FlowpadClient
│   ├── core/                  # Core infrastructure
│   ├── api/                   # API types (includes api_types/ stubs)
│   ├── db/                    # Database drivers (SQLite)
│   ├── builtin/               # Built-in entities
│   ├── actions/               # Action system
│   ├── request_context/       # Request-scoped context
│   ├── responses/             # API response models
│   ├── config.py              # Configuration management
│   ├── service_log.py         # Service logging
│   └── cli/                   # CLI (Typer app)
├── ts_sdk/                    # TypeScript SDK
├── server/                    # FastAPI server (standalone package)
│   ├── run.py                 # Server entry point
│   ├── server.py              # FastAPI app
│   ├── launch.py              # Server launcher & monitor
│   ├── state.py               # Server state
│   ├── routes/                # API endpoints
│   ├── middleware/             # Request middleware
│   ├── reporters/             # Event reporters
│   └── static/                # Built UI assets
├── ui/                        # Frontend source (React/Vite)
│   ├── src/
│   ├── vite.config.ts
│   └── package.json
├── tests/
└── pyproject.toml
```

### Import Convention

SDK imports use the `flow_sdk.` prefix. Server imports use the `server.` prefix:

```python
# Public SDK
from flow_sdk.fs_records import AgenticProcess
from flow_sdk.fs_store import FsRecord
from flow_sdk.hooks import HookFile

# SDK internals
from flow_sdk.core.loaders import load_entities
from flow_sdk.builtin.user import User
from flow_sdk.db.database import init_db
from flow_sdk.config import load_server_info
from flow_sdk.responses.response import ApiResponse
from flow_sdk import service_log

# Server (standalone package at repo root)
from server.app import app
from server.routes import auth_router
from server.launch import start_monitor_detached

# CLI
from flow_sdk.cli.cli_context import CLIContext
from flow_sdk.cli.config_manager import get_config_value
```

## API & Request Architecture

### Auth Model (Local/Desktop)

flow-cli uses a **zero-auth** model. There is no signup, login, JWT, or multi-user system.

The `RequestTransactionMiddleware` auto-authenticates every HTTP request:
1. Parses the URL path into `request_info` (action, resource_type, target_entity)
2. Looks up the `@local` user: `User.get_one({"uname": "local"})`
3. Sets `auth_result = AuthResult(allowed=True, target_roles=["owner"])` and `su=True`
4. **All requests are authorized as owner** — no permission checks


### Bootstrap & Local Entities

The bootstrap endpoint (`/api/v1/graph/bootstrap`) creates and returns these @local entities on first call:

| Entity | uname | Purpose |
|--------|-------|---------|
| **User** | `local` | The single desktop user |
| **Project** | `local` | Default project container |
| **Workspace** | `local` | Default workspace |
| **Agent** | `local` | Local Claude CLI agent |
| **ComputeNode** | `local` | Local machine (mounts root filesystem) |

These entities must exist for graph route operations (CRUD, actions, fs) to work. API tests that use the graph route need to call bootstrap first or ensure the DB is initialized.

### Response Format

**All API responses use `ApiResponse` format** — never raw FastAPI `{"detail": "..."}`. Even errors return:
```json
{"status": "FAIL", "message": "...", "data": null}
```
The graph catch-all handler catches `HTTPException` and wraps it in `ApiFailResponse(message=exc.detail)` with the appropriate status code. Tests should always parse responses using `ApiResponse.parse_json(response.text)`.

### Graph Route & Action System

All entity operations flow through a single catch-all graph route at `/api/v1/graph/{path}`:

```
Request → Middleware (parse URL, auto-auth) → Graph Route → Action Registry → Handler
```

**URL pattern**:
- `GET /api/v1/graph/{type}` → `read` action (list all of type)
- `POST /api/v1/graph/{type}` → `create` action
- `GET /api/v1/graph/{type}/{id}` → `read` action (get by id)
- `PUT /api/v1/graph/{type}/{id}` → `update` action
- `DELETE /api/v1/graph/{type}/{id}` → `delete` action
- `GET /api/v1/graph/{type}/{id}/{action_name}` → custom action on entity instance
- `GET /api/v1/graph/{type}/{action_name}` → custom action on entity class

**CRUD actions** are registered in `flow_sdk/app/actions/graph_crud_actions.py`:
- `@action.all(action_name="read", methods="get", types="all")`
- `@action.all(action_name="create", methods="post", types="all")`
- `@action.all(action_name="update", methods=["put", "patch"], types="all")`
- `@action.all(action_name="delete", methods=["delete"], types="all")`

**Custom actions** are registered via `@action.all()` / `@action.get()` / `@action.post()` decorators on entity methods (e.g., `@action.post(action_name="terminal-command")` on ComputeNode). The action registry (`flow_sdk/actions/action_registry.py`) maps action names to handlers.

### Dedicated Routes

These routes bypass the graph/action system and are direct FastAPI endpoints. They should rarely be changed:

| Route file | Endpoints | Purpose |
|-----------|-----------|---------|
| `health.py` | `/health/status` | Health check |
| `bootstrap.py` | `/api/v1/graph/bootstrap` | Entity initialization |
| `auth.py` | `/api/auth/*` | OAuth/login flows |
| `directory.py` | `/api/directory/*` | Working directory management |
| `chat.py` | `/api/chat/*` | Claude CLI sessions |
| `hooks.py` | `/api/hooks/*` | Hook management |
| `testing.py` | `/ping`, `/prompt` | Test/debug endpoints |
| `websocket.py` | `/api/v1/connect/ws/*` | WebSocket connections |
| `ui.py` | `/` | Serves the frontend |

### Tests

```bash
# All backend tests (from repo root)
python -m pytest tests/ -v

# Backend unit tests only
python -m pytest tests/unit/ -v

# Backend API tests only
python -m pytest tests/api/ -v

# Backend CLI tests only
python -m pytest tests/cli/ -v

# Long tests (require DEEP_TESTING=true — always set this when running long tests)
DEEP_TESTING=true python -m pytest tests/long_tests/ -v

# Frontend build validation
cd ui && npm run build && npm run lint
```


## Performance Debugging

Use `TimeIt` to measure step-by-step timing anywhere in the codebase. It prints a formatted report only when total elapsed exceeds a threshold — zero noise in the normal path.

```python
from flow_sdk.utils import TimeIt

t = TimeIt("My operation")
do_step_a()
t.time("step_a")
do_step_b()
t.time("step_b")
t.done(0.5)  # prints if total > 500ms, silent otherwise
```

Output (only when slow):
```
────────────────────────────────
  My operation slowness detected (1234ms > 500ms threshold)
────────────────────────────────
  step_a       45.2ms  ████
  step_b     1188.8ms  ████████████████████████████████████████
────────────────────────────────
  TOTAL      1234.0ms
────────────────────────────────
```

## Known Pitfalls

### Circular Import Stubs (api/api_types/)

The SDK has stub modules in `flow_sdk/api/api_types/` that break circular import chains:

**Re-exports (unified, safe):**
- `api/api_types/type_id.py` → re-exports from `api/type_id.py`
- `core/responses/response.py` → re-exports from `responses/response.py`

**Stubs (must stay as-is, break circular imports):**
- `api/api_types/messages.py` — local `AuthContext` stub (avoids `request_context` → `db.db_entity` → `api.api_types.messages` cycle)
- `api/api_types/api_request.py` — local `is_entity_type()` stub (same circular chain)
- `api/api_types/fs_api.py` — local `RequestInfo`, `ApiFailResponse`, `get_current_request_info()` stubs
- `api/api_types/ws_stream.py` — local `InMemoryCache` stub

These stubs exist to break circular import chains through `request_context`. Do NOT convert them to re-exports. If you see Pydantic validation errors like "Input should be a valid dictionary or instance of X" where the input IS an instance of X, it's a duplicate class issue — check which module path the class comes from.

### TypeScript SDK Circular Dependency

The process module lives under `ts_sdk/src/process/`. Shared types are extracted to `ts_sdk/src/process/agentic-types.ts` to keep circular dependencies manageable. When re-exporting interfaces, use `export type { ... }` for Rollup compatibility.

### Test Execution

- API tests run in ~6s. If a test run seems to hang, check for piped commands (`| tail`, `| head`) that buffer all output — use direct output instead.
- The SQLite DB at `/tmp/flowpad_test.db` persists between test runs. The `clean_db` session fixture in `tests/api/conftest.py` deletes it at session start. If you see stale entities leaking between tests, that's the cause.
- Frontend react/unit tests use 15s timeouts (`hookTimeout` and `testTimeout` in `ui/tests/react/vitest.config.ts`).
- Some react tests (useFS, reactivity) require a running backend at `localhost:9007` — they can't reach it from jsdom.

## Work Standards

### No "Pre-existing" Excuses

Never dismiss failing tests, broken code, or issues as "pre-existing" and move on. If you encounter a failing test or broken behavior during your work, fix it. The only exception is if the user explicitly tells you to skip it. Leaving broken things behind is not acceptable — own the state of the codebase after your changes.

### Fix What You Find

If a test is failing when you run the suite, fix it before committing. If you introduce a change that exposes an existing bug, fix the bug. If you see an import mismatch, a missing mock, or a misconfigured test — fix it. Do not label things as "pre-existing" or "unrelated" as a reason to ignore them.

### Never Use "Not My Failure" as an Excuse

Never use the excuse "it's not my failure" or "this was already broken" to avoid debugging a test failure. If a test fails during your run, investigate it. The failure may be caused by your changes interacting with existing code, test ordering issues, or a latent bug your changes exposed. Debug it, understand the root cause, and fix it — unless the user explicitly tells you to skip it.

## Architecture Rules

### Database Access Pattern

**Do not use SQLAlchemy inside anything but its driver**

Structure:
```
DBBaseRecord  (Pydantic model — schema fields, serialization)
    ↓
DBEntity      (DB operations via _db driver, relationships, roles, children)
    ↓
Entity        (search, record sync, blobs, env vars, storage)
    ↓
Builtin entities (User, Shell, ComputeNode, Asset, etc.)
    ↓
Action Handlers  (call Entity methods, never import SQLAlchemy)
    ↓
REST/WebSocket API

SQLiteDriver / EntitySchema / RelationshipSchema  ← all SQLAlchemy contained here
```

Rules:
- **DBBaseRecord** (`flow_sdk/db/drivers/db_base_record.py`): Pydantic model — schema fields and serialization only
- **DBEntity** (`flow_sdk/db/db_entity.py`): All DB operations via `self._db` (a `DBDriver` instance) — CRUD, relationships, roles, children, observers. No direct SQLAlchemy imports.
- **Entity** (`flow_sdk/core/entity/entity_model.py`): Business logic — search, record sync (`store()`, `from_record()`), blobs, env vars. No direct SQLAlchemy imports.
- **Action handlers**: Call Entity methods, never import SQLAlchemy
- **SQLiteDriver** (`flow_sdk/db/drivers/sqlite/sqlite_driver.py`): All SQLAlchemy queries contained here. `EntitySchema` / `RelationshipSchema` are the ORM models, internal to the SQLite driver.

This keeps the SDK portable across different backends (Neo4j, PostgreSQL, etc.)
