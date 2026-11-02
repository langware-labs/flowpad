# tests/api - how to run

**What**: ~210 HTTP API tests. Tier: in-process FastAPI app via `httpx.ASGITransport` (see `tests/api/conftest.py`); no server process, no port, no hub, no LLM. Real SQLite/records in a per-run sandbox. Some files fake the agent worker.

## Prerequisites
- `uv sync`. No credentials.

## Commands (repo root)
```bash
uv run pytest tests/api
uv run pytest tests/api --long
uv run pytest tests/api/test_run_session_turn.py
uv run pytest tests/api/test_run_session_turn.py::test_name
```

## Env vars
- `FLOWPAD_TEMP_DIR` / `TMPDIR` for the sandbox location.
- The conftest pins `FS_RECORD_PATH` per run and restores it if a test changes it; do not set it yourself.

## Pitfalls
- Hub tests do not live here (they are in `tests/hub_tests`); `FLOWPAD_HUB_URL` is the dead port 127.0.0.1:9 by design.
- Harness/CLI presence is declared by `tests/utils/harness_installed.py`, so these tests do not need claude/codex installed.
- A hang is usually a leaked asyncio task; per-test cap is 30 s from pytest.ini.

## Common (all pytest folders)

- Run from the repo root. `pytest.ini` (not pyproject) wins: `asyncio_mode=auto`, `--timeout=30` per test, `pythonpath=.`, and a `env =` block (SQLITE_DATABASE_PATH, TESTING) applied by pytest-env.
- Fixtures come from `tests/pytest_plugin.py` (registered by the root conftest): throwaway `HOME`, DB and records root per run, keyring stub, cookie gate off.
- `long`-marked tests are deselected unless you pass `--long` (or any `-m`).
- Never raise a committed timeout to get a green. If your branch has an ADJUSTABLE_TIMEOUT helper (`tests/adjustable_timeout.py`), it ADDS seconds / scales caps on slow hosts: a pass under a scaled budget is not a default-budget pass, say so when reporting.
- `/tmp` may be small (about 1 GB): `export TMPDIR=<bigger volume>/tmp` (or set `FLOWPAD_TEMP_DIR`) before big runs.
- Never `pkill -f run_hub` (or similar broad patterns) from the shell that runs the tests.

## Time
A few minutes; per-test cap 30 s.
