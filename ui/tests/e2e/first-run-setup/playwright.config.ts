import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **first-run setup** browser scenario.
 *
 * Needs a backend that has NEVER had a tab open — a fresh database — and that
 * was started WITHOUT `FLOWPAD_SKIP_FIRST_RUN_SETUP`, or the fire-once trigger
 * under test is spent or switched off before the spec opens its page. CI resets
 * the backend onto a new database for exactly this. Locally, a just-launched
 * disposable instance (`scripts/instance_ctl.sh launch dev-1`) is fresh.
 *
 * Run:
 *   SETUP_FE_PORT=5001 npx playwright test --config ui/tests/e2e/first-run-setup/playwright.config.ts
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
