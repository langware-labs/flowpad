# tests/cli - how to run

**What**: 44 test files of the `flow` CLI and app config. Tier: mock/in-process; the `server` fixture in `tests/cli/conftest.py` can start a real local server thread on port 9007 (default) and talk HTTP to it. No hub, no LLM.

## Prerequisites
- `uv sync`. Port 9007 free for tests that use the `server` fixture. No credentials.

## Commands (repo root)
```bash
uv run pytest tests/cli
uv run pytest tests/cli/test_app_config.py
uv run pytest tests/cli/test_app_config.py::test_name
```

## Env vars
`FLOWPAD_TEMP_DIR` / `TMPDIR` only. `FLOW_INSTANCE` is stripped from child-process environments by a fixture so spawned processes are not mistaken for instance carriers.

## Pitfalls
- Port 9007 is also the default dev backend port: stop (do not kill with broad patterns) anything listening there, or the fixture-based tests collide.
- Server boot wait is 30 s-class; too tight on slow sandboxes. Report, do not widen.
- Tests redirect `FLOW_HOME` to a tmp tree; never point them at a real `~/.flow`.

## Common (all pytest folders)

- Run from the repo root. `pytest.ini` (not pyproject) wins: `asyncio_mode=auto`, `--timeout=30` per test, `pythonpath=.`. Env: pytest-env (>=1.2) reads pyproject's `[tool.pytest_env]` (SQLITE_DATABASE_PATH, TESTING, FLOWPAD_HUB_URL=http://127.0.0.1:9) and then IGNORES the `env =` block in pytest.ini.
- Fixtures come from `tests/pytest_plugin.py` (registered by the root conftest): throwaway `HOME`, DB and records root per run, keyring stub, cookie gate off.
- `long`-marked tests are deselected unless you pass `--long` (or any `-m`).
- Never raise a committed timeout to get a green. If your branch has an ADJUSTABLE_TIMEOUT helper (`tests/adjustable_timeout.py`), it ADDS seconds / scales caps on slow hosts: a pass under a scaled budget is not a default-budget pass, say so when reporting.
- `/tmp` may be small (about 1 GB): `export TMPDIR=<bigger volume>/tmp` (or set `FLOWPAD_TEMP_DIR`) before big runs.
- Never `pkill -f run_hub` (or similar broad patterns) from the shell that runs the tests.

## Time
Under a few minutes; per-test cap 30 s.
