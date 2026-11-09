# tests/hub_tests - how to run

**What**: 39 test files of hub-backed features (conversations, sharing, members, OAuth, agent mailboxes, live sessions). Tier: LIVE LOCAL HUB (+ real CLI turns / real LLM for some). Marker: `hub`.

## Prerequisites
- A healthy LOCAL hub, run from the separate private `flowpad-hub` checkout (see `AGENTS.md`; default `localhost:8093`), NOT the minimal `flow-hub/` stub in this tree: `$FLOWPAD_HUB_URL` must be localhost/127.0.0.1/::1 and answer `GET /api/v1/health/status`. Otherwise the WHOLE folder is skipped (reason is printed), which is not a pass.
- Hub test users (credentials by name): `ALICE_EMAIL`, `ALICE_PW`, `BOB_EMAIL`, `BOB_PW` for the two-client tests.
- Real-turn tests: `claude` (or codex/copilot/opencode) CLI on PATH, signed in and onboarded.
- `test_live_session_llm_matrix.py`: `DEEP_TESTING=1` and `OPENROUTER_API_KEY`.
- OAuth "real" tests (`test_oauth_*_real.py`): provider tokens; missing credentials are reported as missing, not fixed.

## Commands (repo root)
```bash
export FLOWPAD_HUB_URL=http://localhost:8093   # your local hub
uv run pytest tests/hub_tests
uv run pytest tests/hub_tests/test_conversation_basics.py
uv run pytest tests/hub_tests/test_conversation_basics.py::test_name
DEEP_TESTING=1 uv run pytest tests/hub_tests/test_live_session_llm_matrix.py
```

## Env vars
`FLOWPAD_HUB_URL`, `ALICE_EMAIL/ALICE_PW`, `BOB_EMAIL/BOB_PW`, `DEEP_TESTING`, `OPENROUTER_API_KEY`, `FLOWPAD_CLOUD_USER_EMAIL/FLOWPAD_CLOUD_USER_PASSWORD` (some tests), `FLOW_HOME` (real-CLI helper pins it).

## Pitfalls
- **Export `FLOWPAD_HUB_URL` first.** pytest-env pins it to the dead port `http://127.0.0.1:9` only when it is not already set (`skip_if_set`), so tests never hit the prod hub by accident; without the export the whole folder is skipped. Do not add `-p no:env`: it removes that pin.
- Never point this at the production hub; use a throwaway local hub and users.
- Real-CLI tests stall on a fresh CLI config (no `hasCompletedOnboarding` / trust dialog). Sign in once first.
- "no live CLI turn" skips mean infrastructure, not success.

## Common (all pytest folders)

- Run from the repo root. `pytest.ini` (not pyproject) sets the options: `asyncio_mode=auto`, `--timeout=30` per test, `pythonpath=.`. Env: pytest-env (>=1.2) reads pyproject's `[tool.pytest_env]` and then IGNORES the `env =` block in pytest.ini.
- Fixtures come from `tests/pytest_plugin.py`: throwaway `HOME`, DB and records root per run (the real home is kept in `FLOWPAD_PRE_SANDBOX_HOME`).
- Never raise a committed timeout. If your branch has an ADJUSTABLE_TIMEOUT helper (`tests/adjustable_timeout.py`), it ADDS seconds / scales caps on slow hosts: a pass under a scaled budget is not a default-budget pass; say so.
- `/tmp` may be small (about 1 GB): `export TMPDIR=<bigger volume>/tmp` first.
- Never `pkill -f run_hub` (or other broad patterns) from the shell running the tests.

## Time
Minutes to tens of minutes (real turns). Per-test cap 30 s unless a test sets its own timeout.
