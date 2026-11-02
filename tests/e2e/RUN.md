# tests/e2e - how to run

**What**: NOT a pytest folder (nothing here is collected as `test_*.py`). It holds manual/QA drivers for live browser validation of deployments, channels and setup wizards. Tier: live backend (+ hub, + real LLM, + browser). The Playwright specs for the same features live in `ui/tests/e2e`.

| File | Purpose |
|---|---|
| `mock_worker_backend.py` | real backend whose agent turns use `MockDriver` (answers `Mock reply: <prompt>`), no model needed |
| `channel_doubles.py` | one process hosting every message-channel double + a control API (`/channels`, `/deliver`, `/react`, `/sent`) |
| `deployment_channels_mix.py` | one real agent on every channel at once, validated on deployment threads |
| `deployment_console_check.py` | checks a channels-mix run's browser capture |
| `deployment_page_watch.cjs`, `deployment_process_validate.cjs`, `agent_credentials_validate.cjs` | Playwright (node) browser watchers/validators |
| `source_setup_wizard.py` | runs a data source's setup wizard headless, answering its questions |
| `connector_on_e2b.py` | external connector installed on an e2b box; runs from the HUB checkout |

## Prerequisites
- A launched disposable instance: `scripts/instance_ctl.sh launch <name>` (gives `.env.<name>.local`, backend 600X, frontend 500X).
- Hub reachable (`FLOWPAD_HUB_URL`, e.g. a local hub) for anything needing a cloud mailbox/login.
- `uv sync`; for `.cjs` scripts `cd ui && npm ci && npx playwright install chromium`.

## Commands (repo root; ports are examples)
```bash
set -a; source .env.<name>.local; set +a; uv run python tests/e2e/mock_worker_backend.py   # after stopping just that instance's backend
FLOW_INSTANCE=<name> FLOWPAD_HUB_URL=<hub> uv run python tests/e2e/channel_doubles.py --backend http://localhost:<be port> [--channels whatsapp,slack]
FLOW_INSTANCE=<name> FLOWPAD_HUB_URL=<hub> uv run python tests/e2e/deployment_channels_mix.py --backend http://localhost:<be port> --control http://127.0.0.1:<doubles port> [--timeout 90] [--report out.json] [--watch http://localhost:<fe port> --watch-out <dir>]
uv run python tests/e2e/deployment_console_check.py <run dir>
uv run python tests/e2e/source_setup_wizard.py --backend http://localhost:<be port> --source <data_source id> --answers '{"<op>": "<value>"}'
node tests/e2e/deployment_process_validate.cjs <frontend> <backend> <agent id> <deployment id> <out dir> [phase...]
node tests/e2e/agent_credentials_validate.cjs <frontend> <backend> <agent id> <project id> <out dir> [--flows]
```

## Env vars
`FLOW_INSTANCE`, `FLOWPAD_HUB_URL`; `connector_on_e2b.py`: `HUB`, `FLOWMSG`, `PROVIDER`, `SOURCE_CONFIG`, `ANSWERS`, `PAIR_OP`, `EMAIL`, `PASSWORD`, `NODE`.

## Pitfalls
- Never run against prod; use a disposable instance. The scripts write real entities.
- The mock backend must replace the launcher's backend (same ports); backends do not hot-reload, so restart after code changes.
- `connector_on_e2b.py` is run with the hub checkout's venv and `env -u DEPLOY_ENV -u SOD_ENC_KEY`.
- Real LLM / e2b runs need their credentials by name; missing ones are reported missing, not fixed.
- Do not `pkill -f run_hub` from the shell running these.

## Time
Minutes per script; channels-mix waits out thread timeouts (default 90 s) so expect 5+ minutes.
