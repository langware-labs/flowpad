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
uv run pytest -p no:env tests/hub_tests
uv run pytest -p no:env tests/hub_tests/test_conversation_basics.py
uv run pytest -p no:env tests/hub_tests/test_conversation_basics.py::test_name
DEEP_TESTING=1 uv run pytest -p no:env tests/hub_tests/test_live_session_llm_matrix.py
```

## Env vars
`FLOWPAD_HUB_URL`, `ALICE_EMAIL/ALICE_PW`, `BOB_EMAIL/BOB_PW`, `DEEP_TESTING`, `OPENROUTER_API_KEY`, `FLOWPAD_CLOUD_USER_EMAIL/FLOWPAD_CLOUD_USER_PASSWORD` (some tests), `FLOW_HOME` (real-CLI helper pins it).

## Pitfalls
- **`-p no:env` is mandatory.** pytest-env pins `FLOWPAD_HUB_URL=http://127.0.0.1:9` (dead port, by design, so tests never hit the prod hub); without `-p no:env` every test is skipped.
- Never point this at the production hub; use a throwaway local hub and users.
- Real-CLI tests stall on a fresh CLI config (no `hasCompletedOnboarding` / trust dialog). Sign in once first.
- "no live CLI turn" skips mean infrastructure, not success.

## Common (all pytest folders)

- Run from the repo root. `pytest.ini` wins over pyproject: `asyncio_mode=auto`, `--timeout=30` per test, and an `env =` block applied by pytest-env.
- Fixtures come from `tests/pytest_plugin.py`: throwaway `HOME`, DB and records root per run (the real home is kept in `FLOWPAD_PRE_SANDBOX_HOME`).
- Never raise a committed timeout. On a slower host set `ADJUSTABLE_TIMEOUT=<seconds>` (`tests/adjustable_timeout.py`): it ADDS that many seconds to every test's timeout (the `--timeout=30` default and each `@pytest.mark.timeout`, applied in `tests/pytest_plugin.py`) and to budgets wrapped in `adjusted()`. Default 0 = the committed values. A pass under a non-zero value is not a default-budget pass: say so when reporting.
- `/tmp` may be small (about 1 GB): `export TMPDIR=<bigger volume>/tmp` first.
- Never `pkill -f run_hub` (or other broad patterns) from the shell running the tests.

## Time
Minutes to tens of minutes (real turns). Per-test cap 30 s unless a test sets its own timeout.
