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
Matrix output: one line per cell `PASS|FAIL <worker> <family>:<size> <secs>s`; exit 1 if any failed. Family/size labels resolve to explicit fixture slugs in `tests/loginless_e2e/make_matrix_endpoint.py`; they are not passed as removed `family:size` SDK syntax. PASS requires a successful terminal worker state, persisted assistant chat output, and the expected resolved endpoint/model. The family runner still exercises `flow process start`; a Python read verifies that CLI process afterward.

## Env vars
`HUB`, `HUB_IN_CONTAINER`, `PROMPT`, `CELL_PROMPT`, `SCRIPT`, `BARE`, `MATRIX`, `ENDPOINT_ID`, `SKIP_BUILD`, `IMAGE`, `WORKERS`, `FAMILIES`, `SIZES`, `WIZARDS`, `MATRIX_MODELS`, `OPENROUTER_API_KEY`, `PUBLIC_COST_USD_TOTAL` (default 1.0; 10.0 for the matrix endpoint). `MATRIX_MODELS` overrides the worker script's comma-separated explicit slugs; it does not alter the family fixture. Unknown workers/families/sizes and missing binaries fail rather than silently reducing coverage.

## Pitfalls
- Container reaches the host hub via the `host.docker.internal` alias (run.sh rewrites `localhost`).
- The run rewrites `dist/` (removes old `flowpad-*.whl`) and copies helper scripts there. Use an isolated build checkout so unrelated wheel artifacts are preserved.
- A public endpoint's id is its only credential: keep the cost cap; never reuse a real/prod endpoint.
- Some upstream hosts return empty completions for certain models; a PASS needs actual assistant text. A Vertex-first entry can fall back to OpenRouter: endpoint identity proves the entry, not the serving root. Inspect per-root hub attribution before claiming Vertex coverage.
- Matrix installs every harness CLI inside the container: needs network and minutes.

## Time
Single run 5-10 min incl. build; MATRIX can take an hour or more.

## Local token-source API proof

`TOKEN_SOURCE_CASES` points to a JSON array of nonsecret cells with `name`, `worker`,
`endpoint` (full type ID), `kind` (`device`, `api_key`, `hub`), `model`,
`resolvedModel`, and optional `public`. Both runners require an isolated
`FLOW_INSTANCE=token-sources-*`; a filtered manifest proves only its listed cells.

- TypeScript: from `ui/`, run `npx vitest run --config tests/long_tests/vitest.config.ts tests/long_tests/token-source-process.test.ts`.
- Python: from the repo root, run `python -m tests.loginless_e2e.token_source_process`
  in the storage/encryption environment owning those source rows. Stop the disposable
  backend first so this direct SDK runner is the instance's sole writer.

Each cell must produce assistant answer `3`, complete successfully and report the expected
source/model. Set `model: null` to omit the request model and test the endpoint default;
the runners also verify that its resolved model was not persisted as an explicit choice.
A device-default model may be empty; `resolvedModel: null` then proves no
concrete model selection, only the native-default path. Claude's Python driver can fill the
concrete model from its transcript, unlike the HTTP runner; specify the actual expected value.
No credentials belong in manifests or reports. The Python runner retains process records for
inspection; the TypeScript runner exits and deletes its test-owned processes.
