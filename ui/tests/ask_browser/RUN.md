# ui/tests/ask_browser - how to run

**What**: not a spec folder. It holds `drive_ask.mjs`, a node Playwright driver that answers or cancels a pending "ask" in a real browser: `node drive_ask.mjs <url> answer <value> | cancel` (exit 0 = page accepted). It lives under `ui/` because node resolves `playwright` from the script's directory. The test that uses it is pytest: `tests/long_tests/test_ask_browser_matrix.py`.

## Prerequisites
`cd ui && npm ci && npx playwright install chromium`; `uv sync`. The pytest test starts its own in-process uvicorn app on a free port AND a Vite dev server from source (so `npm` deps must be installed).

## Commands (repo root)
```bash
uv run pytest tests/long_tests/test_ask_browser_matrix.py
uv run pytest tests/long_tests/test_ask_browser_matrix.py::test_name
node ui/tests/ask_browser/drive_ask.mjs "<ask page url>" answer "<value>"      # manual driver
```

## Env vars
None specific (the file is not DEEP_TESTING-gated); the usual pytest sandbox vars. It skips when `ui/node_modules` is missing.

## Pitfalls
- The pytest test is 300 s-capped (`pytest.mark.timeout(300)`, "do not increase without approval"); vite startup on a slow host eats into it.
- Needs a free port for the app and one for Vite; a 30 s boot wait is tight on slow sandboxes.
- Driver reports page errors and the ask API calls (`/api/v1/ask`); read that output before blaming the product.
- Missing Chromium makes the driver exit non-zero at launch.

## Common (all Playwright folders)

- Run from `ui/`. Browser: `npx playwright install chromium` (a cached Chromium is enough). `npx playwright install --with-deps chromium` additionally needs apt/network and passwordless sudo, so it fails in plain sandboxes: skip `--with-deps` if system libs are already present.
- `workers: 1`, `fullyParallel: false`, `retries: 0` everywhere: tests are serial and a failure is real, not retried away.
- Never raise a committed timeout. On a slower host set `ADJUSTABLE_TIMEOUT=<seconds>`: `adjusted(ms)` in `ui/tests/adjustableTimeout.ts` ADDS that many seconds to every config cap and wait that wraps it. Default 0 = the committed values. A pass under a non-zero value is not a default-budget pass: say so when reporting.
- Never raise a committed speed budget either. On a slower host set `ADJUSTABLE_PERF_FACTOR=<factor>`: `adjustedBudget(ms)` in `ui/tests/adjustableTimeout.ts` MULTIPLIES every perf budget by it (`tab_switch_perf`). Default 1 = the committed values. A pass under a factor above 1 is not a default-budget pass: say so when reporting.
- Failure traces: `npx playwright show-trace test-results/<dir>/trace.zip`.

## Time
1-5 min.
