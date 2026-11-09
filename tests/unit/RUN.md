# tests/unit - how to run

**What**: ~1440 files of fast unit tests of `flow_sdk` (pure logic, in-process, monkeypatched). Tier: mock, no backend, no hub, no LLM.

## Prerequisites
- `uv sync` (dev deps: pytest, pytest-asyncio, pytest-timeout, pytest-env, pytest-rerunfailures).
- Nothing else. No credentials.

## Commands (repo root)
```bash
uv run pytest tests/unit                                   # whole folder (long-marked tests deselected)
uv run pytest tests/unit --long                            # include tests marked long
uv run pytest tests/unit/test_runtime_kind.py              # one file
uv run pytest tests/unit/test_runtime_kind.py::test_name   # one test
uv run pytest tests/unit -k "setup and not wizard" -x      # by keyword
```

## Env vars
- `FLOWPAD_TEMP_DIR` / `TMPDIR`: where the per-run sandbox (DB, records, HOME) is created.
- `FLOWPAD_SKIP_DOTENV=true`: ignore `.env.local` (it is otherwise merged with `setdefault`, minus FLOW_INSTANCE, FLOW_HOME, FLOWPAD_TEMP_DIR, SQLITE_DATABASE_PATH, FS_RECORD_PATH, LOCAL_SERVER_PORT, ENV, HOME and `VITE_*`; `ENV=<file>` picks another dotenv file).

## Pitfalls
- Hub URL is pinned to a dead port (`http://127.0.0.1:9`) by design; a unit test that needs a hub starts its own.
- Tests that start their own backend/server need a free port; a 30 s boot wait is tight on slow sandboxes (report it, do not widen it).
- A test that fails only when run with others usually leaks global state (capability dict, event loop, env): rerun the single file first, then the folder.
- Tests that spawn `flow asset install` need `uv` on PATH.

## Common (all pytest folders)

- Run from the repo root. `pytest.ini` (not pyproject) wins: `asyncio_mode=auto`, `--timeout=30` per test, `pythonpath=.`. Env: pytest-env (>=1.2) reads pyproject's `[tool.pytest_env]` (SQLITE_DATABASE_PATH, TESTING, FLOWPAD_HUB_URL=http://127.0.0.1:9) and then IGNORES the `env =` block in pytest.ini.
- Fixtures come from `tests/pytest_plugin.py` (registered by the root conftest): throwaway `HOME`, DB and records root per run, keyring stub, cookie gate off.
- `long`-marked tests are deselected unless you pass `--long` (or any `-m`).
- Never raise a committed timeout to get a green. If your branch has an ADJUSTABLE_TIMEOUT helper (`tests/adjustable_timeout.py`), it ADDS seconds / scales caps on slow hosts: a pass under a scaled budget is not a default-budget pass, say so when reporting.
- `/tmp` may be small (about 1 GB): `export TMPDIR=<bigger volume>/tmp` (or set `FLOWPAD_TEMP_DIR`) before big runs.
- Never `pkill -f run_hub` (or similar broad patterns) from the shell that runs the tests.

## Time
Minutes for the whole folder on a normal host (each test capped at 30 s). Run it in the background and read the summary; do not interrupt.
