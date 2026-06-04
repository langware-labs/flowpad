---
id: "e829214c-f5bf-5eb1-a8f7-d5509c0f859b"
---

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

| Variable            | File         | Purpose                                                                                                                                  |
| ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_SERVER_PORT` | `.env.local` | Backend server port                                                                                                                      |
| `VITE_PORT`         | `.env.local` | Frontend dev server port                                                                                                                 |
| `FLOW_INSTANCE`     | `.env.local` | Instance **name** the `flow` CLI targets (per-instance state under `~/.flow/instances/<name>/`). Default `prod`. This checkout is `oss`. |

> **The** **`flow`** **CLI is instance-scoped.** `FLOW_INSTANCE=<name> flow …` reads that instance's `~/.flow/instances/<name>/server.json` for the port; unset → `prod`. Agentic-process **workers inherit this automatically** — the backend pins `FLOW_INSTANCE` to its own instance when spawning a worker, so a worker's `flow record/navigate/context` calls always hit the backend that spawned it (not prod). A clear `Instance '<name>' is not running` error is raised when that instance has no `server.json`.

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

> **Hub at** **`$FLOWPAD_HUB_URL`** **(default** **`localhost:8093`) is served by the sibling checkout** **`../test_flowpad/FlowPad/`** **(run via** **`flowpad/run.py`, ships** **`flowpad/hub/routers/auth.py`** **with** **`/api/v1/login`) — NOT the minimal** **`flow-hub/`** **stub in this tree. Don't** **`pkill`/install into the wrong one.**

### Spinning up an extra named instance (`scripts/instance_ctl.sh`)

To run a second, fully-isolated backend+frontend pair out of **this** checkout — e.g. to
stand in for the separate "bob"/app instance in conversation/collaboration testing, or to
verify a change in a real browser without touching your main dev server — use the launcher:

```bash
scripts/instance_ctl.sh launch <name> [--email E] [--password P] [--hub URL]
scripts/instance_ctl.sh status [<name>]
scripts/instance_ctl.sh list
scripts/instance_ctl.sh kill   <name> [--keep-env]
```

What `launch <name>` does (all isolated per instance):

* **Ports** follow the trailing digit of the name: `dev-1` → frontend `5001`, backend `6001`
  (band `500X` / `600X`; scans upward if busy). Backend avoids `6000` (ERR\_UNSAFE\_PORT),
  frontend avoids `5000` (macOS AirPlay).

* **Data dir** `~/.flow/instances/<name>/` — own DB, sodot, singleton lock, and launcher
  logs (`launcher-backend.log` / `launcher-frontend.log`).

* **Hub user** `<name>@local.test` (password `<name>-pw-1234` by default) is auto-signed-up
  on the hub (idempotent) and the instance is auto cloud-logged-in after the backend is healthy.

* Writes `.env.<name>.local` at the repo root; the frontend is started with
  `vite --mode <name>` so that file out-precedences `.env.local`. `FLOWPAD_SKIP_DOTENV=true`
  and `MINIHUB_RELOAD=False` are set so the injected env isn't clobbered and the backend
  stays single-process (PID/port kill is sufficient).

Both processes are spawned detached and survive the shell. Stop with `kill <name>` (removes
the registry + `.env.<name>.local` unless `--keep-env`). Example:

```bash
scripts/instance_ctl.sh launch dev-1            # → http://localhost:5001 (be 6001), user dev-1@local.test
scripts/instance_ctl.sh kill   dev-1
```

### Building for pip install

```bash
# Build UI assets into server/static/ (REQUIRED before packaging)
python build_ui.py

# Build the wheel
uv build
```

`build_ui.py` must run before `uv build` — it compiles the frontend into `server/static/assets/` which gets included in the wheel via `package-data` in `pyproject.toml`. Without this step, the pip-installed server will serve the HTML shell but 404 on JS/CSS assets. The deploy script (`scripts/deploy_to_github.sh`) runs `build_ui.py` automatically.

## URL-first navigation (non-negotiable)

The only allowed flow for any tab / view / asset / entity click in the UI is:

```
click → navigate(url) → react-router runs the loader → loader writes context
       → context-derived hooks update → UI renders
```

That means, on every click handler that changes "what is shown":

1. **The click handler only calls** **`navigation.openDock(...)`** **(or another** **`navigation.*`** **shortcut).** Nothing else.
2. **No optimistic writes to** **`dataContext`, viewer stores, or any global state from the click handler.** Not "for instant feel", not "to avoid the loader's async work", not "the loader will overwrite it with the same value anyway". Those rationales are how the inversion keeps creeping back. The loader is the single writer.
3. **The component's** **`active`** **/** **`selected`** **state must be derived from** **`currentDock`** **(URL)**, not from `dataContext.activeX` set by an upstream click. If `useDockNavigation().currentDock` says "this is the active pointer", that is the active pointer.
4. **Loaders must be fast.** If a loader awaits a WS-bound or PTY-bound side effect, move that side effect into a `useEffect` on the mounted view. The loader resolves entity identity; the view does its own attach/connect on mount. Don't compensate for a slow loader with optimistic-write hacks elsewhere — fix the loader.

If you find yourself writing `dataContext.set*(...)` immediately before `navigation.openDock(...)` in a click path, stop. That is the broken pattern. Delete the writes and make the active-key derivation URL-first.

## Test timeouts (non-negotiable)

**NEVER raise a test timeout to make a test pass. EVER. No exceptions without explicit user approval, every time.**

Applies to every form: `@pytest.mark.timeout(N)`, `--timeout=N`, `stream_transcript(timeout=…)`, Playwright `expect.timeout` / `actionTimeout` / `testTimeout`, any `waitFor(timeout=…)`, any in-test polling budget.

If a test fails on time, the production code is too slow or stalls — that's the bug. Fix the slow path; keep the cap. Moving a test into `tests/long_tests/` does NOT grant license to bump its in-file timeout — the cap stays unless the user says otherwise. If you genuinely believe an exception is warranted, STOP and ask before editing. Don't add `@pytest.mark.flaky` / `reruns` as a workaround either.

**This is not limited to tests, and "it's not technically a test timeout" is not an out.** The rule is about the INTENT: never raise — or newly add — ANY wait/timeout/retry/backoff/poll budget anywhere (test OR production/runtime code) in order to make an error, flake, hang, or contention symptom go away. This explicitly includes, without limitation: SQLite/DB `busy_timeout`, SQLAlchemy/driver `connect_args={"timeout": …}` or `pool_timeout`, HTTP/client `timeout=…`, `asyncio.wait_for(…)`, lock-acquire timeouts, retry counts / `max_attempts`, `sleep`/backoff durations, and debounce/throttle intervals. A symptom like `database is locked`, a 5xx, a race, or "it's slow" means there is real contention or a real slow/stalling path — **fix that root cause** (remove the contention, isolate the writer, make the call fast, fix the stall). Widening a wait to ride past the symptom is the same banned move as bumping a test timeout. If you think a longer wait is genuinely the correct fix (not a mask), STOP and get explicit user approval first, every time — do not decide unilaterally on "spirit."

## Entity id policy (non-negotiable)

**An entity id is always a UUID v4 (random) or v5 (deterministic). Never any other version.** v4 = no stable key (random); v5 = derived from a stable key (a file path or a natural key, via `uuid5`). Nothing else is a valid entity id.

* **Mint through one place.** Construct ids only via `mint_uuid(key=None, *, namespace=...)` in `flow_sdk/api/api_types/identifier.py` (re-exported from `flow_sdk/fs_store/identifier.py`): `uuid5(namespace, key)` when a stable key is given, else `uuid4`. Don't hand-roll `uuid.uuid4()` / `uuid5(...)` at call sites — route through the minter (or `Entity.allocate_id`, or a type's `gen_id_fn`, which themselves use it).

* **Validate on adopt.** Any id taken from outside the minter — a markdown/asset **frontmatter** **`id:`**, a slug, a client-supplied id — must pass `is_valid_entity_id` (UUID v4/v5) before it's adopted. If it doesn't (e.g. a hand-authored v7), **ignore it and derive a stable v5 instead** — never let a foreign id become an entity id. The per-type `_read_*_frontmatter_id` readers and `Entity.allocate_id` already enforce this; new id-adopting paths must too.

* **Two predicates, don't confuse them.** `is_valid_uuid` / `UUID_PATTERN` are deliberately **version-agnostic** (URL/VFS path matchers and `@local` parsing depend on that) — do NOT tighten them. `is_valid_entity_id` is the **mint/adopt policy gate** (v4/v5 only) — use it wherever an id is born or adopted.

* **Validators must agree at v4/v5.** The frontend `ts_sdk/src/models/TypeId.ts` regex (`…-[45]xxx-…`) and the hub `flowpad/hub/api/identifier.py` must accept exactly v4/v5. A mismatch (e.g. a stricter frontend) means a backend-minted id can poison entity resolution — see the v7 incident where one fixture's v7 frontmatter id broke `useEntityByPath`'s whole bulk list.

