# ui/tests/browser_render - how to run

**What**: bugs that only exist with a real layout engine (xterm RTL/bidi, terminal link clicks). Tier: real Chromium, SELF-CONTAINED: no app, no backend, no dev server; specs mount the production module on a blank page.

## Prerequisites
`cd ui && npm ci && npx playwright install chromium`. Nothing else, no credentials.

## Commands (from `ui/`)
```bash
npx playwright test --config=tests/browser_render/playwright.config.ts
npx playwright test --config=tests/browser_render/playwright.config.ts tests/browser_render/xterm-rtl.spec.ts
npx playwright test --config=tests/browser_render/playwright.config.ts -g "test name"
```

## Env vars
None.

## Pitfalls
- Chromium must be installed; a missing browser fails every spec at launch.
- Fonts/glyph metrics can differ by OS; a geometry failure on an odd host may be environmental.

## Common (all Playwright folders)

- Run from `ui/`. Browser: `npx playwright install chromium` (a cached Chromium is enough). `npx playwright install --with-deps chromium` additionally needs apt/network and passwordless sudo, so it fails in plain sandboxes: skip `--with-deps` if system libs are already present.
- `workers: 1`, `fullyParallel: false`, `retries: 0` everywhere: tests are serial and a failure is real, not retried away.
- Never raise a committed timeout. On a slower host set `ADJUSTABLE_TIMEOUT=<seconds>`: `adjusted(ms)` in `ui/tests/adjustableTimeout.ts` ADDS that many seconds to every config cap and wait that wraps it. Default 0 = the committed values. A pass under a non-zero value is not a default-budget pass: say so when reporting.
- Never raise a committed speed budget either. On a slower host set `ADJUSTABLE_PERF_FACTOR=<factor>`: `adjustedBudget(ms)` in `ui/tests/adjustableTimeout.ts` MULTIPLIES every perf budget by it (`tab_switch_perf`). Default 1 = the committed values. A pass under a factor above 1 is not a default-budget pass: say so when reporting.
- Failure traces: `npx playwright show-trace test-results/<dir>/trace.zip`.

## Time
Seconds to 2 min. Per-test 20 s, expect 5 s.
