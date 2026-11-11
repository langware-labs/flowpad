# tests/first_launch_e2e - how to run

**What**: proves a virgin install works from nothing: builds the wheel from the working tree, builds a docker image without git or system python3, runs it once with no volumes, and asserts the whole first-launch chain including the wizard's installer agent. Tier: DOCKER + real LLM (+ hub if cloud-funded). Not pytest.

## Prerequisites
- docker daemon, `uv`, `python3`, node (for `build_ui.py`).
- LLM funding, one of: `OPENROUTER_API_KEY`; or `FLOWPAD_CLOUD_USER_EMAIL` + `FLOWPAD_CLOUD_USER_PASSWORD` with a hub at `FLOWPAD_HUB_URL` (default `http://host.docker.internal:8093`) whose endpoint serves `anthropic/claude-haiku-4.5` (the sm tier) or every install step 404s.

## Commands (repo root)
```bash
OPENROUTER_API_KEY=... ./tests/first_launch_e2e/run.sh
FLOWPAD_CLOUD_USER_EMAIL=... FLOWPAD_CLOUD_USER_PASSWORD=... FLOWPAD_HUB_URL=http://host.docker.internal:8093 ./tests/first_launch_e2e/run.sh
KEEP=1 HOST_PORT=9712 ./tests/first_launch_e2e/run.sh      # keep container alive to inspect
```
There is no single-test mode; it is one linear proof (5 steps).

## Env vars
`OPENROUTER_API_KEY`, `FLOWPAD_CLOUD_USER_EMAIL`, `FLOWPAD_CLOUD_USER_PASSWORD`, `FLOWPAD_HUB_URL`, `IMAGE`, `CONTAINER`, `HOST_PORT` (default 9712), `KEEP` (0/1), `WIZARD_BUDGET_S` (default 900).

## Pitfalls
- The two funding paths are exclusive; if an OpenRouter key is set the container skips cloud login.
- The log is written to a fixed path under `/tmp` (`first-launch-e2e.log`); the build also writes `dist/`. A small `/tmp` can fill: free space first.
- Host port must be free; the container needs `host.docker.internal` (added via `--add-host`).
- The image build asserts git and python3 are absent; do not "fix" the Dockerfile to add them.
- It spends real tokens.

## Time
Image build 3-10 min (UI + wheel), run up to `WIZARD_BUDGET_S` (15 min default). Budget about 20-30 min.
