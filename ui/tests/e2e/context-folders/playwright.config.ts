import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the project **context folders** browser scenario.
 *
 * Drives a REAL browser against the disposable `dev-1` instance (frontend
 * :5002 / backend :6001) — never the user's main dev backend. Assumes dev-1 is
 * already launched (`scripts/instance_ctl.sh launch dev-1`).
 *
 * Run:
 *   npx playwright test --config ui/tests/e2e/context-folders/playwright.config.ts
 *
 * Override ports for a different instance:
 *   CTX_FE_PORT=5002 CTX_BE_PORT=6001 npx playwright test --config <this>
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.CTX_FE_PORT || '5002'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
