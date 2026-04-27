---
name: "dual-env"
description: "Set up and run flow-cli in dual mode: a production instance (flow-cli-prod) and a development instance (flow-cli) side by side"
tags: "[dev, setup, environment, dogfooding]"
---

# Dual Environment Setup (Prod + Dev)

Run two flow-cli instances simultaneously: a stable **production** instance for daily use and a **development** instance for code changes with HMR.

## Port Allocation

| Instance | Backend | Frontend | Folder                      |
| -------- | ------- | -------- | --------------------------- |
| **Prod** | 9007    | 4097     | `~/Developer/flow-cli-prod` |
| **Dev**  | 9008    | 4098     | `~/Developer/flow-cli`      |

## Shared State (IMPORTANT)

Both instances share **the same** **`~/.flow/`** **directory**, which means:

* **Database**: `~/.flow/db/flowpad_db` — both read/write the same SQLite DB. Entities created in one are visible in the other.

* **Hooks**: `~/.flow/hooks/` — hook registrations are shared.

* **Sessions**: `~/.flow/sessions/` — Claude CLI session data is shared.

* **Records**: `~/.flow/records/` — file-system records are shared.

* **Server info**: `~/.flow/server.json` — only tracks the last `flow start` instance. `flow stop` may target the wrong instance if both use `flow start`.

* **Logs**: `~/.flow/server.log` and `~/.flow/monitor.log` — written by whichever instance uses `flow start`. The dev instance run from PyCharm/terminal logs to its own console, avoiding interleaving.

* **CLI commands** (`flow hooks report`, etc.) — use `LOCAL_SERVER_PORT` env var to decide which server to talk to. In a shell with the prod venv active, they'll hit 9007. In the dev venv, they'll hit 9008.

* **DB path override**: Set `SQLITE_DATABASE_PATH` in `.env.local` if you want fully isolated databases per instance.

## Setup Instructions

### Prerequisites

Both folders must exist. If not:

```bash
cd ~/Developer
# If flow-cli doesn't exist:
git clone <your-flow-cli-repo-url> flow-cli

# If flow-cli-prod doesn't exist (clone from flow-cli):
git clone flow-cli flow-cli-prod
```

### 1. Set up Production Instance (flow-cli-prod)

```bash
cd ~/Developer/flow-cli-prod
uv venv
uv sync
cd ui && npm i && cd ..
source .venv/bin/activate
```

Create/verify `.env.local` in `flow-cli-prod/`:

```env
LOCAL_SERVER_PORT=9007
VITE_PORT=4097
HTTP_REPORT_ENDPOINT=http://localhost:9007
API_BASE_URL=http://localhost:9007/api/v1
```

Start the production server:

```bash
flow start
# View logs:
tail -f ~/.flow/server.log
```

### 2. Set up Development Instance (flow-cli)

Create/verify `.env.local` in `flow-cli/`:

```env
DEVELOPMENT=True
MINIHUB_RELOAD=True
LOCAL_SERVER_PORT=9008
VITE_PORT=4098
VITE_API_URL=http://localhost:9008
HTTP_REPORT_ENDPOINT=http://localhost:9008
API_BASE_URL=http://localhost:9008/api/v1
```

Start the dev backend (from PyCharm or terminal):

```bash
cd ~/Developer/flow-cli
uv run -m server.run
```

Start the dev frontend (separate terminal):

```bash
cd ~/Developer/flow-cli/ui
npm run dev
```

The `vite.config.ts` reads `VITE_PORT` and `VITE_API_URL` from `.env.local` via `loadEnv()`.

### 3. Verify Isolation

* Open `http://localhost:4097` — should be the prod frontend

* Open `http://localhost:4098` — should be the dev frontend

* Changes in `flow-cli/` code (Python + React) should only affect the dev instance via HMR

* The prod instance stays stable on the last `git pull` / `flow start`

## Startup Order

Does not matter. The instances use different ports and don't interfere with each other.

## Stopping

```bash
# Stop prod (from flow-cli-prod with its venv active):
flow stop

# Stop dev: Ctrl+C in the PyCharm/terminal running the server
# Stop dev frontend: Ctrl+C in the terminal running npm run dev
```

## Updating Production

```bash
cd ~/Developer/flow-cli-prod
git pull
uv sync
cd ui && npm i && cd ..
flow stop
flow start
```

## Executable Steps (for Claude)

When asked to set up dual-env, execute these steps:

1. Check if `~/Developer/flow-cli-prod` exists. If not, `git clone ~/Developer/flow-cli ~/Developer/flow-cli-prod`.
2. In `flow-cli-prod`: run `uv venv && uv sync && cd ui && npm i`.
3. Write `.env.local` in `flow-cli-prod` with prod ports (9007/4097).
4. Write `.env.local` in `flow-cli` with dev ports (9008/4098) and `DEVELOPMENT=True`.
5. Kill any processes on ports 9007, 9008, 4097, 4098.
6. Start prod: `cd ~/Developer/flow-cli-prod && source .venv/bin/activate && flow start`.
7. Inform user to start dev instance from PyCharm or via `uv run -m server.run` + `cd ui && npm run dev`.

