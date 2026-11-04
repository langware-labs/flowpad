# ui/tests/manual_regression - how to run

**What**: ~187 runbook specs `<name>.md.ts`, each paired with a `<name>.md` runbook, grouped by area (chat, terminal, agentic-process, assets, skills, wiki, vibe...). Tier: live backend + live dev frontend (+ real LLM / real Claude CLI for chat/terminal areas). Two `*.spec.ts` also exist (`graph-workflows/demo-workflows.spec.ts`, `tags/tag-vocabulary.spec.ts`). Some are structural guards (`migration.md.ts`), some may contain no runnable tests (manual harness); see `run_test_instructions.md`.

## Prerequisites
- Backend running and frontend dev server running (`npm run dev` in `ui/`); base URL is `http://localhost:${VITE_PORT:-4097}`.
- `cd ui && npm ci && npx playwright install chromium`.
- Chat/terminal areas: a signed-in, onboarded `claude` CLI and an LLM credential.

## Commands (from `ui/`)
Each area folder has its own `playwright.config.ts` (the root one re-exports `general/playwright.config`; 34 area configs):
```bash
npx playwright test --config=tests/manual_regression/chat/playwright.config.ts
npx playwright test --config=tests/manual_regression/chat/playwright.config.ts tests/manual_regression/chat/chat_input_controls.md.ts
npx playwright test --config=tests/manual_regression/chat/playwright.config.ts -g "test name" --headed
npx playwright test --config=tests/manual_regression/playwright.config.ts          # general area
```

## Env vars
`VITE_PORT` (frontend port), `API_URL` or backend port per area (see each spec).

## Pitfalls
- Always pass `--config` for the area; configs use `testMatch: '*.md.ts'`, so without it nothing matches or the wrong area runs.
- Areas share backend state: tests are serial; a leftover entity from a failed run can break the next; use a disposable instance.
- Config sets `slowMo: 50` and 60 s per test (15 s expect); real LLM replies may need more: that is a finding.
- "0 tests found" for a file means it is a manual runbook, not a failure of your command.
- The two `*.spec.ts` files (`graph-workflows/demo-workflows.spec.ts`, `tags/tag-vocabulary.spec.ts`) do NOT match the area configs' `testMatch: '*.md.ts'`, so `--config` of their area finds no tests for them; they need their own harness.

## Common (all Playwright folders)

- Run from `ui/`. Browser: `npx playwright install chromium` (a cached Chromium is enough). `npx playwright install --with-deps chromium` additionally needs apt/network and passwordless sudo, so it fails in plain sandboxes: skip `--with-deps` if system libs are already present.
- `workers: 1`, `fullyParallel: false`, `retries: 0` everywhere: tests are serial and a failure is real, not retried away.
- Never raise a committed timeout. On a slower host set `ADJUSTABLE_TIMEOUT=<seconds>`: `adjusted(ms)` in `ui/tests/adjustableTimeout.ts` ADDS that many seconds to every config cap and wait that wraps it. Default 0 = the committed values. A pass under a non-zero value is not a default-budget pass: say so when reporting.
- Never raise a committed speed budget either. On a slower host set `ADJUSTABLE_PERF_FACTOR=<factor>`: `adjustedBudget(ms)` in `ui/tests/adjustableTimeout.ts` MULTIPLIES every perf budget by it (`tab_switch_perf`). Default 1 = the committed values. A pass under a factor above 1 is not a default-budget pass: say so when reporting.
- Failure traces: `npx playwright show-trace test-results/<dir>/trace.zip`.

## Time
Per file 0.5-3 min; a full area 10-40 min.
