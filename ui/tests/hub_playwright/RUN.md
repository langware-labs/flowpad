# ui/tests/hub_playwright - how to run

**What**: two-browser hub-realtime and live-session specs (conversations, cross-OS live sessions, settings, stress, git share, `tagit share` against real GitHub). Tier: TWO LIVE INSTANCES + frontends + a local hub (+ real worker turns for live_session_*).

## Prerequisites
- Alice and bob each run backend + dev frontend (defaults: alice UI :4098 / backend :9008, bob UI :4097 / backend :9007), both cloud-logged-in to the hub (default `http://localhost:8093`) with hub bridges connected. Use disposable instances and override the URLs via env.
- `tagit_share_real_github.spec.ts` also needs a real GitHub repo/token and hub credentials (`TAGIT_E2E_*`).
- Live-session specs run real worker turns: CLI signed in and onboarded, LLM credential present.

## Commands (from `ui/`)
```bash
npx playwright test --config=tests/hub_playwright/playwright.config.ts
npx playwright test --config=tests/hub_playwright/playwright.config.ts tests/hub_playwright/setup_conversation.spec.ts
npx playwright test --config=tests/hub_playwright/playwright.config.ts -g "test name"
```

## Env vars
`ALICE_UI_URL`, `ALICE_BACKEND_URL`, `BOB_UI_URL`, `BOB_BACKEND_URL`, `Q_UI_URL`, `Q_BACKEND_URL`, `FLOWPAD_HUB_URL`, `BOB_CLOUD_EMAIL`, `HOST_PROJECT_ID`, `HOST_RESTART`, `GUEST_RESTART`, `HOST_BAD_WORKDIR`, `LIVE_SESSION_SHOTS`, `CROSSOS_SHOTS`, `TAGIT_E2E_BACKEND_URL`, `TAGIT_E2E_UI_URL`, `TAGIT_E2E_HUB_UI_URL`, `TAGIT_E2E_HUB_EMAIL`, `TAGIT_E2E_HUB_PASSWORD`, `TAGIT_E2E_GITHUB_TOKEN`, `TAGIT_E2E_REPO`.

## Pitfalls
- Config budget is tiny by design (10 s per test, 2 s expect, 5 s actions) because the realtime SLO is sub-second; a slow host fails these on latency, which is a finding, not a reason to loosen. Specs that need more carry their own timeout.
- Both backends must be logged in as DIFFERENT hub users; a wrong-user login fails the pair: redo cloud login.
- Backends do not hot-reload; relaunch after changing `flow_sdk`.
- Real GitHub / real hub spec writes to a real repo: use a throwaway one.

## Common (all Playwright folders)

- Run from `ui/`. Browser: `npx playwright install chromium` (a cached Chromium is enough). `npx playwright install --with-deps chromium` additionally needs apt/network and passwordless sudo, so it fails in plain sandboxes: skip `--with-deps` if system libs are already present.
- `workers: 1`, `fullyParallel: false`, `retries: 0` everywhere: tests are serial and a failure is real, not retried away.
- Never raise committed timeouts. ADJUSTABLE_TIMEOUT / `ui/tests/adjustableTimeout.ts` (`adjusted()`), if present on your branch, ADDS seconds on slow hosts; a pass under a scaled budget is not a default-budget pass.
- Failure traces: `npx playwright show-trace test-results/<dir>/trace.zip`.

## Time
Realtime specs: seconds each. Live-session stress and real-turn specs: several minutes each (own timeouts).
