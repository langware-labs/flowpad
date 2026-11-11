# tests/hub_passthrough - how to run

**What**: runs HUB tests through desktop instances (HubProxy) against a real hub. Tier: real hub repo + desktop instances. NOT part of this repo's suite: files are `live_*.py` so plain `pytest tests` skips them; run them from the hub checkout. See also `README.md`.

## Prerequisites
- The hub repo checkout with its venv and `uv`; a Neo4j test database of your own; the hub's `pytest.ini` and `flowpad.hub.tests.conftest`.

## Commands (from the hub checkout's `flowpad` dir)
```bash
env -u SOD_ENC_KEY DEPLOY_ENV=local NEO4J_DATABASE_DB_NAME_TEST=<own db> TMPDIR=<private dir> \
  PYTHONPATH=<oss checkout>/tests/hub_passthrough:$PWD/.. \
  uv run pytest --rootdir=$PWD -c pytest.ini -p flowpad.hub.tests.conftest -p hub_passthrough_plugin \
  <oss checkout>/tests/hub_passthrough/live_every_action.py
# one test: append ::test_name ; other files: live_shapes_and_failures.py, live_call_sites.py
```

## Env vars
`DEPLOY_ENV=local`, `NEO4J_DATABASE_DB_NAME_TEST`, `TMPDIR`, `PYTHONPATH`; `SOD_ENC_KEY` must be UNSET (`env -u`).

## Pitfalls
- Run from the HUB repo, not here; here `-c pytest.ini` would be the wrong config.
- Use your own Neo4j database name; the suite writes real graph data.
- Never run against the production hub.
- Do not `pkill -f run_hub` from the shell running the tests.

## Time
Minutes per file; depends on the hub.
