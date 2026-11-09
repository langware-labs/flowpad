# tests/loginless_e2e - how to run

**What**: loginless agentic-process proof: a clean container, a PUBLIC hub LLM endpoint, two commands (bind the endpoint, run a prompt). Variants: snippet (default), `SCRIPT=worker_matrix.py`, `BARE=1` (wheel-only image, `flow process start`), `MATRIX=1` (`family_matrix.sh`: every harness installed by its wizard, every worker x family:size answering "hi"). Tier: DOCKER + a hub YOU start + real LLM. Not pytest (a pytest wrapper exists: `tests/long_tests/test_loginless_in_docker.py`).

## Prerequisites
- docker, `uv`, a hub you started (code that knows `public` endpoints), reachable at `HUB` (default `http://localhost:8094`).
- `OPENROUTER_API_KEY` (admin side: `make_public_endpoint.py` creates a capped public endpoint; `make_matrix_endpoint.py` for the matrix).
- Hub owner identity optional: `HUB_OWNER_EMAIL`, `HUB_OWNER_PASSWORD` (defaults exist for a throwaway hub).

## Commands (repo root)
```bash
HUB=http://localhost:8094 OPENROUTER_API_KEY=... tests/loginless_e2e/run.sh
SCRIPT='worker_matrix.py claude_code' HUB=... OPENROUTER_API_KEY=... tests/loginless_e2e/run.sh
BARE=1 HUB=... OPENROUTER_API_KEY=... tests/loginless_e2e/run.sh
MATRIX=1 HUB=... OPENROUTER_API_KEY=... tests/loginless_e2e/run.sh      # WORKERS/FAMILIES/SIZES/WIZARDS narrow it
ENDPOINT_ID=<id> SKIP_BUILD=1 HUB=... tests/loginless_e2e/run.sh        # reuse endpoint and images
```
Matrix output: one line per cell `PASS|FAIL <worker> <family>:<size> <secs>s`; exit 1 if any failed.

## Env vars
`HUB`, `HUB_IN_CONTAINER`, `PROMPT`, `SCRIPT`, `BARE`, `MATRIX`, `ENDPOINT_ID`, `SKIP_BUILD`, `IMAGE`, `WORKERS`, `FAMILIES`, `SIZES`, `WIZARDS`, `OPENROUTER_API_KEY`, `PUBLIC_COST_USD_TOTAL` (default 1.0; 10.0 for the matrix endpoint).

## Pitfalls
- Container reaches the host hub via the `host.docker.internal` alias (run.sh rewrites `localhost`).
- The run rewrites `dist/` (removes old `flowpad-*.whl`) and copies helper scripts there.
- A public endpoint's id is its only credential: keep the cost cap; never reuse a real/prod endpoint.
- Some upstream hosts return empty completions for certain models; a PASS needs real text.
- Matrix installs every harness CLI inside the container: needs network and minutes.

## Time
Single run 5-10 min incl. build; MATRIX can take an hour or more.
