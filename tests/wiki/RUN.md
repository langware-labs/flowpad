# tests/wiki - how to run

**What**: wiki store, parser, resolver, index and link-scope tests. Tier: in-process with a real per-run SQLite DB and records root (`tests/wiki/conftest.py` resets them). No backend, hub, or LLM.

## Prerequisites
`uv sync`. No credentials.

## Commands (repo root)
```bash
uv run pytest tests/wiki
uv run pytest tests/wiki/test_parser.py
uv run pytest tests/wiki/test_parser.py::test_name
```

## Env vars
`FLOWPAD_TEMP_DIR` / `TMPDIR`.

## Pitfalls
- The conftest swaps the default records root; do not export `FS_RECORD_PATH` / `SQLITE_DATABASE_PATH` yourself.
- `_seed.py` is a helper, not a test file.

## Common (all pytest folders)

- Run from the repo root. `pytest.ini` (not pyproject) wins: `asyncio_mode=auto`, `--timeout=30` per test, `pythonpath=.`. Env: pytest-env (>=1.2) reads pyproject's `[tool.pytest_env]` (SQLITE_DATABASE_PATH, TESTING, FLOWPAD_HUB_URL=http://127.0.0.1:9) and then IGNORES the `env =` block in pytest.ini.
- Fixtures come from `tests/pytest_plugin.py` (registered by the root conftest): throwaway `HOME`, DB and records root per run, keyring stub, cookie gate off.
- `long`-marked tests are deselected unless you pass `--long` (or any `-m`).
- Never raise a committed timeout. On a slower host set `ADJUSTABLE_TIMEOUT=<seconds>` (`tests/adjustable_timeout.py`): it ADDS that many seconds to every test's timeout (the `--timeout=30` default and each `@pytest.mark.timeout`, applied in `tests/pytest_plugin.py`) and to budgets wrapped in `adjusted()`. Default 0 = the committed values. A pass under a non-zero value is not a default-budget pass: say so when reporting.
- `/tmp` may be small (about 1 GB): `export TMPDIR=<bigger volume>/tmp` (or set `FLOWPAD_TEMP_DIR`) before big runs.
- Never `pkill -f run_hub` (or similar broad patterns) from the shell that runs the tests.

## Time
Seconds to a minute.
