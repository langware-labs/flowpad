# tests/first_launch_e2e - how to run

**What**: proves a virgin install works from nothing. It builds the wheel from the working tree, builds a docker image without git or system python3, runs it once with no volumes, and plays a person opening the app for the first time: a tab opens, the "First-time setup" trigger fires once, the llm-setup popup appears, the person presses Start and leaves Install ticked for every missing tool, and Python and Git get installed. Tier: DOCKER + real LLM (+ hub if cloud-funded). Not pytest.

## Stages
| Stage | Checks |
|---|---|
| A | git and python3 are absent before anything runs |
| B | the backend starts and is healthy |
| C | the LLM funding is stored (OpenRouter key) or the box is cloud-logged-in |
| D | bootstrap answers |
| E | a tab opens -> `app.tab.ready` -> the "First-time setup" trigger fires once -> the setup popup is sent to the tab -> Start -> the person is asked before Python and Git are installed and says Install -> the run completes; the trigger's fire log names the `app.tab.ready` event that caused it |
| F | python3 and git now exist |
| G | after a restart with the app open, the trigger has not fired again and no popup comes back |

A passing run calls no model. The installs in E are plain commands (on Linux `apt-get install`); the `provisioner` agent is only their fallback when a command fails. So a pass shows the funding is stored, not that an agent can spend it.

## Prerequisites
- docker daemon, `uv`, `python3`, node (for `build_ui.py`).
- LLM funding, one of: `OPENROUTER_API_KEY`; or `FLOWPAD_CLOUD_USER_EMAIL` + `FLOWPAD_CLOUD_USER_PASSWORD` with a hub at `FLOWPAD_HUB_URL` (default `http://host.docker.internal:8093`) whose endpoint serves `anthropic/claude-haiku-4.5` (the sm tier), or any install that falls back to the agent fails.

## Commands (repo root)
```bash
OPENROUTER_API_KEY=... ./tests/first_launch_e2e/run.sh
FLOWPAD_CLOUD_USER_EMAIL=... FLOWPAD_CLOUD_USER_PASSWORD=... FLOWPAD_HUB_URL=http://host.docker.internal:8093 ./tests/first_launch_e2e/run.sh
KEEP=1 HOST_PORT=9712 ./tests/first_launch_e2e/run.sh      # keep container alive to inspect
```
There is no single-test mode; it is one linear proof (stages A-G).

## Env vars
`OPENROUTER_API_KEY`, `FLOWPAD_CLOUD_USER_EMAIL`, `FLOWPAD_CLOUD_USER_PASSWORD`, `FLOWPAD_HUB_URL`, `IMAGE`, `CONTAINER`, `HOST_PORT` (default 9712), `KEEP` (0/1), `WIZARD_BUDGET_S` (default 900).

## Pitfalls
- The two funding paths are exclusive; if an OpenRouter key is set the container skips cloud login.
- The log is written to a fixed path under `/tmp` (`first-launch-e2e.log`); the build also writes `dist/`. A small `/tmp` can fill: free space first.
- Host port must be free; the container needs `host.docker.internal` (added via `--add-host`).
- The image build asserts git and python3 are absent; do not "fix" the Dockerfile to add them.
- There is no browser in the container: the test plays the tab with one websocket that sends the UI's `browser_context` frame and stays open for the whole run.
- It spends real tokens only when an install falls back to the agent.

## Time
Image build 3-10 min (UI + wheel), run up to `WIZARD_BUDGET_S` (15 min default). Budget about 20-30 min.
