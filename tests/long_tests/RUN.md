# tests/long_tests - how to run

**What**: ~80 files of slow live tests: real worker CLIs in PTYs (Claude/Codex/...), real backends, docker, e2b, channels, share/hub flows, ask-browser. Tier: LIVE backend, real LLM, sometimes docker or two hub instances.

## Prerequisites
- `DEEP_TESTING=1` (files use `tests/test_settings.py` skipif; `.env.local` is also read for it). Without it most files skip.
- Live-instance tests read an instance name from env via the `resolve_live_e2e_instance` fixture (`conftest.py`): `FLOWPAD_E2E_INSTANCE`, `FLOWPAD_E2E_PEER_INSTANCE` (a second, distinct one), `FLOWPAD_DEPLOY_E2E_INSTANCE`, `FLOWPAD_STAGING_MATRIX_INSTANCE`; they skip when unset. The instance must be launcher-owned and live: `scripts/instance_ctl.sh launch <name>`; env file, launcher registry, PID and port must agree or the test fails closed.
- Worker tests: the CLI (claude/codex/...) installed AND signed in/onboarded (a fresh config without `hasCompletedOnboarding`/trust dialog stalls), plus an LLM credential such as `OPENROUTER_API_KEY`. A missing credential is reported as missing/skipped, not fixed.
- Per-file extras by name: `AGENTMAIL_API_KEY`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_TEST_CHAT_ID`, `WHATSAPP_*`, `E2B` key, `ALICE_EMAIL/ALICE_PW/BOB_EMAIL/BOB_PW`, docker daemon (`FLOWPAD_DOCKER_IMAGE`).

## Commands (repo root)
```bash
export DEEP_TESTING=1
uv run pytest tests/long_tests -x                      # whole folder (hours; prefer subsets)
uv run pytest tests/long_tests/test_shell_pty.py
uv run pytest tests/long_tests/test_shell_pty.py::test_name
FLOWPAD_E2E_INSTANCE=<a> FLOWPAD_E2E_PEER_INSTANCE=<b> uv run pytest tests/long_tests/test_ws_reconnect_message_catchup.py   # instance-bound file, example
DEEP_TESTING=1 ANTHROPIC_API_KEY=... uv run pytest tests/long_tests/stress_matrix/   # see its README
```

## Env vars
`DEEP_TESTING`, `FLOWPAD_E2E_INSTANCE` / `FLOWPAD_E2E_PEER_INSTANCE` / `FLOWPAD_DEPLOY_E2E_INSTANCE` / `FLOWPAD_STAGING_MATRIX_INSTANCE`, `FLOW_INSTANCE`, `FLOW_HOME`, `FLOWPAD_HUB_URL`, `OPENROUTER_API_KEY`, `FLOWPAD_MAIN_CHECKOUT`.

## Pitfalls
- Files that talk to a hub need `-p no:env` (pytest-env pins the hub URL to dead port 127.0.0.1:9).
- The conftest restores the real HOME for CLI auth; tests drive real accounts. Use disposable instances, never prod.
- Tests that start their own backend need a free port and a 30 s boot wait that is tight on slow sandboxes.
- Capacity-bound PTY stress files can fail only for environmental reasons on a busy host; do not widen budgets.
- `stress_matrix` is per-cell `@pytest.mark.timeout(30)`, skipped without `ANTHROPIC_API_KEY`.

## Common (all pytest folders)

- Run from the repo root. `pytest.ini` wins over pyproject: `asyncio_mode=auto`, `--timeout=30` per test, and an `env =` block applied by pytest-env.
- Fixtures come from `tests/pytest_plugin.py`: throwaway `HOME`, DB and records root per run (the real home is kept in `FLOWPAD_PRE_SANDBOX_HOME`).
- Never raise a committed timeout. If your branch has an ADJUSTABLE_TIMEOUT helper (`tests/adjustable_timeout.py`), it ADDS seconds / scales caps on slow hosts: a pass under a scaled budget is not a default-budget pass; say so.
- `/tmp` may be small (about 1 GB): `export TMPDIR=<bigger volume>/tmp` first.
- Never `pkill -f run_hub` (or other broad patterns) from the shell running the tests.

## Time
Individual files: 1-10 min. Whole folder: hours. Many tests set their own longer timeout via marker.
