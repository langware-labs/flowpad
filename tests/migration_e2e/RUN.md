# tests/migration_e2e - how to run

**What**: old-wheel to new-wheel upgrade in Docker: builds UI + wheel on the host, builds an image, seeds data with the old version, migrates, and verifies (stages A-F, optional browser validation via `browser_validate.py`). Tier: DOCKER, no LLM. `test_docker_migration.py` is a pytest wrapper that is skipped unless opted in.

## Prerequisites
- docker, node (`build_ui.py`), `uv`, `lsof`; port 9711 free.
- `flow_sdk/_version.py` must equal exactly `0.2.26` (run.sh asserts it and fails otherwise).

## Commands (repo root)
```bash
bash tests/migration_e2e/run.sh                     # full pipeline, exit 0 = pass
PORT=9811 bash tests/migration_e2e/run.sh           # other host port
DOCKER_E2E=1 uv run pytest tests/migration_e2e/test_docker_migration.py -m docker -v
```
No per-test mode; it is one linear pipeline.

## Env vars
`PORT` (default 9711), `DOCKER_E2E=1` (pytest wrapper opt-in).

## Pitfalls
- The version precheck is hard-coded: on any other version it fails immediately, by design. Do not edit it to get green; report it.
- It does `rm -rf dist` and rebuilds UI assets; do not run while something else depends on `dist/`.
- On failure it dumps the last 200 container log lines and removes the container.
- Not wired into CI.
- Pytest wrapper needs `-m docker` and `DOCKER_E2E=1`, else it is skipped.

## Time
10-20 min (UI + wheel + image build dominate).
