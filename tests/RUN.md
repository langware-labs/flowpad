# tests/ (loose files) - how to run

**What**: the `tests/test_*.py` files that sit directly in `tests/` and belong to no sub-folder: `test_llm_index.py`, `test_llm_index_walk.py`, `test_pid_probe.py`, `test_semantic_lock.py`, `test_settings.py` (the latter is a shared config module for DEEP_TESTING gates, not a test suite). Tier: mock / in-process.
Each sub-folder has its own RUN.md: `unit`, `api`, `cli`, `wiki`, `hub_tests`, `long_tests`, `pty_fuzz`, `isolation`, `hub_passthrough`, `e2e`, `first_launch_e2e`, `loginless_e2e`, `migration_e2e`. `fixtures`, `recordings`, `utils` hold no tests.

## Commands (repo root)
```bash
uv run pytest tests/test_pid_probe.py
uv run pytest tests/test_semantic_lock.py::test_name
uv run pytest tests                 # EVERYTHING (includes long_tests; most skip without DEEP_TESTING)
```

## Pitfalls
- `pytest.ini` sets the pytest options (`--timeout=30` per test, `asyncio_mode=auto`); env vars come from pyproject's `[tool.pytest_env]` (pytest-env >=1.2 then ignores pytest.ini's `env =` block), which pins `FLOWPAD_HUB_URL` to the dead port 127.0.0.1:9 by design. Hub tests need `-p no:env` and a local hub.
- `pytest tests` also collects `flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver` per `testpaths` when run with no path.
- `/tmp` may be small (1 GB): set `TMPDIR` to a bigger volume.
- Never raise a committed timeout. On a slower host set `ADJUSTABLE_TIMEOUT=<seconds>` (`tests/adjustable_timeout.py`): it ADDS that many seconds to every test's timeout (the `--timeout=30` default and each `@pytest.mark.timeout`, applied in `tests/pytest_plugin.py`) and to budgets wrapped in `adjusted()`. Default 0 = the committed values. A pass under a non-zero value is not a default-budget pass: say so when reporting.
- Never `pkill -f run_hub` from the shell running tests.

## Time
Seconds for these files.
