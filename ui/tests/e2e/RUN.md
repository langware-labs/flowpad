# ui/tests/e2e - how to run

**What**: browser scenario suites, one sub-folder per feature, each with its OWN `playwright.config.ts`. Tier: real Chromium against a LIVE disposable instance (backend + dev frontend), some also a hub or a real LLM. There is no root config: always pass `--config`.

| Folder | Specs / config | Frontend port env (default) | Notes |
|---|---|---|---|
| `agent-auto-launch` | 2 specs | `AL_FE_PORT` (5002), `AL_BE_PORT`, `AL_CHANNEL`, `AL_HOLD`, `AL_KEEP` | seeds a project with auto_launch agents |
| `chartit` | chartit.spec.ts | `CH_FE_PORT` (5002), `CH_BE_PORT`, `CH_WORKER` | 1600x900 viewport |
| `dependencies` | dependencies.spec.ts | `DEP_FE_PORT` (5002), `DEP_BE_PORT`, `DEP_CHANNEL` | flow.json deps |
| `deployed-agent-chat` | 1 spec | `DAC_FE_PORT` (5009), `DAC_BE_PORT`, `DAC_HUB_FE_PORT`, `DAC_HUB_EMAIL`, `DAC_HUB_PASSWORD`, `DAC_AGENT_ID`, `DAC_DEPLOYMENT_ID` | needs a deployment seeded OUTSIDE the test (a real box) |
| `deployment-funding` | 1 spec | `LT_FE_PORT` (4098) | hub page; dummy key, nothing launched |
| `first-run-setup` | 1 spec | `SETUP_FE_PORT` (5001) | needs a FRESH install state |
| `hub-git-agent-editor` | 1 spec | `HGA_BE_PORT`, `HGA_HUB_FE_PORT`, `HGA_HUB_EMAIL`, `HGA_HUB_PASSWORD` | desktop + hub-mode dev UI; no baseURL |
| `inbound-routing` | spec + `waha_stack.py`, `seed.py` | `INB_FE_PORT` (5007), `INB_BE_PORT`, `INB_SEED`, `INB_CONTROL`, `INB_HEADED`, `INB_SHOTS` | WhatsApp via a fake WAHA stack; 300 s per test |
| `index-search` | 7 `*.md.ts` | `VITE_PORT` (4097), `API_URL` | `testMatch: *.md.ts`, slowMo 50 |
| `llm-funding-setup` | two configs: `playwright.global-default.config.ts`, `playwright.hub-endpoint.config.ts` | `LLM_GLOBAL_FE_PORT` (5102), `LLM_HUB_FE_PORT` (5101), `*_BE_PORT`, `*_EXPECTED_MODEL` | each needs `start_backend.py --scenario ...` first |
| `llm-tiers` | 1 spec | `LT_FE_PORT` (4098) | |
| `page-sdk-bridge` | 1 spec | `PSB_FE_PORT` (5007), `PSB_BE_PORT` | |
| `project-home-page` | 1 spec | `HP_FE_PORT` (5002), `HP_BE_PORT`, `HP_CHANNEL` | |
| `project-invite-members` | 1 spec | `INVITE_ADMIN`, `INVITE_EDITOR`, `INVITE_MEMBER` (instance names) | THREE instances, each with its own workspace; refuses to run otherwise; 300 s |
| `token-allocation-models` | 1 spec | `TAM_FE_PORT` (4098), `TAM_BE_PORT`, `TAM_AGENT_ID`, `TAM_SOURCE_ID` | signed-in instance seeded outside |
| `webapp-lifecycle` | tier1_stubs, tier2_spora_stubbed, tier3_spora_real | `WL_INSTANCE`, `WL_FE_PORT`/`WL_BE_PORT`, `WL_TIER3`, `WL_TIER3_SECRETS`, `SPORA_ROOT`, `WL_REPORT_DIR` | instance explicit; `prod`/`oss` forbidden; `@long` tier 3 off by default |

## Prerequisites
- A disposable launched instance: `scripts/instance_ctl.sh launch <name>` (frontend 500X, backend 600X; both PIDs live). Never prod or a user-owned instance: these suites seed projects, kill processes and occupy ports.
- Hub-touching folders: a local hub and test users (credentials by env name above).
- `cd ui && npm ci && npx playwright install chromium`.

## Commands (from `ui/`)
```bash
FE=5002 ; AL_FE_PORT=$FE AL_BE_PORT=<be> npx playwright test --config=tests/e2e/agent-auto-launch/playwright.config.ts
npx playwright test --config=tests/e2e/chartit/playwright.config.ts tests/e2e/chartit/chartit.spec.ts
npx playwright test --config=tests/e2e/llm-tiers/playwright.config.ts -g "test name"
WL_INSTANCE=<name> npx playwright test --config=tests/e2e/webapp-lifecycle/playwright.config.ts            # tier 1+2
WL_INSTANCE=<name> WL_TIER3=1 npx playwright test --config=tests/e2e/webapp-lifecycle/playwright.config.ts # + tier 3
INB_SEED=<seed.json> npx playwright test --config=tests/e2e/inbound-routing/playwright.config.ts
```
`inbound-routing/inbound_routing.spec.ts` header lists its full setup (waha stack, seed script).

## Pitfalls
- Frontend/backend ports differ per folder (table); a wrong default silently targets another instance's UI.
- Backends do not hot-reload: relaunch the instance after changing `flow_sdk`.
- `*_CHANNEL` selects an installed browser channel (e.g. chrome); leave unset for bundled Chromium.
- Specs seeded "outside" (deployed-agent-chat, token-allocation-models) fail until their seed exists: that is a missing precondition.
- Do not loosen webapp-lifecycle sampling windows or budgets (200 ms warm return, 2 s reopen).
- Real-LLM scenarios need an onboarded CLI and a credential by name; report missing ones.
- Browser install: `npx playwright install --with-deps chromium` needs apt/network and passwordless sudo; without `--with-deps` a cached Chromium works.
- `workers: 1`, `retries: 0`; never raise committed timeouts (ADJUSTABLE_TIMEOUT / `adjusted()`, if on your branch, only adds seconds: a scaled pass is not a default-budget pass).

## Time
Per-test caps 60-120 s (inbound-routing and project-invite-members 300 s). A folder takes 2-15 min.
