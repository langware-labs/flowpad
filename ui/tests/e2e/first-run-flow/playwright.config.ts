import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **first-run flow** browser scenario (`first_run_flow.spec.ts`).
 *
 * Needs a backend on a FRESH database -- never had a tab open -- started WITHOUT
 * `FLOWPAD_SKIP_FIRST_RUN_SETUP`: the first-run gate must be closed, and its last test waives it for the
 * session. It is its own scenario (and CI resets the backend before it) so that it neither depends on what
 * `first-run-setup` left behind -- on a machine with every tool installed that scenario's wizard run finishes
 * all OK and opens the gate for good -- nor leaves its own waiver for it.
 *
 * Run:
 *   SETUP_FE_PORT=5001 SETUP_BE_PORT=6001 npx playwright test --config ui/tests/e2e/first-run-flow/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.SETUP_FE_PORT || '5001'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
