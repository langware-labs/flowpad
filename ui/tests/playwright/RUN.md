# ui/tests/playwright - how to run

**What**: two loose specs, `markdown-comments.spec.ts` and `trace-gutter.spec.ts`. Tier: live app at HARD-CODED URLs, `http://localhost:4098` (markdown-comments) and `http://localhost:4097` (trace-gutter), with a real backend. Some assertions are intentionally permissive (`count >= 0`); full historical/live trace tests are manual/CI-only per the spec comment.

## Prerequisites
- Frontend dev servers on 4097 (`cd ui && npm run dev`; 4097 is the default `VITE_PORT`) and 4098 for markdown-comments, plus a backend with a terminal tab available.
- `cd ui && npm ci && npx playwright install chromium`.

## Commands (from `ui/`)
There is NO `playwright.config.ts` in this folder or in `ui/`, so Playwright defaults apply (chromium, 30 s test timeout, headless):
```bash
npx playwright test tests/playwright/
npx playwright test tests/playwright/trace-gutter.spec.ts
npx playwright test tests/playwright/trace-gutter.spec.ts -g "renders trace-gutter"
```

## Env vars
None are read; the URL is hard-coded.

## Pitfalls
- Hard-coded ports 4097/4098: if your instance uses other ports, edit locally (do not commit) or proxy 4097.
- With no config the project list is Playwright's default; if Playwright reports "no browsers", install chromium as above.
- Do not treat the permissive assertions as proof of a feature.

## Common (all Playwright folders)

- Run from `ui/`. Browser: `npx playwright install chromium` (a cached Chromium is enough). `npx playwright install --with-deps chromium` additionally needs apt/network and passwordless sudo, so it fails in plain sandboxes: skip `--with-deps` if system libs are already present.
- `workers: 1`, `fullyParallel: false`, `retries: 0` everywhere: tests are serial and a failure is real, not retried away.
- Never raise a committed timeout. On a slower host set `ADJUSTABLE_TIMEOUT=<seconds>`: `adjusted(ms)` in `ui/tests/adjustableTimeout.ts` ADDS that many seconds to every config cap and wait that wraps it. Default 0 = the committed values. A pass under a non-zero value is not a default-budget pass: say so when reporting.
- Failure traces: `npx playwright show-trace test-results/<dir>/trace.zip`.

## Time
Under 1 minute.
