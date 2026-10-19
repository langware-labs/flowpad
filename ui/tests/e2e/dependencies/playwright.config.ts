import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the project **dependencies** (`flow.json`) browser scenario.
 *
 * Drives a REAL browser against a disposable instance_ctl instance — never the
 * user's main dev backend. Launch one first (`scripts/instance_ctl.sh launch <name>`)
 * and read its ports from `.env.<name>.local`.
 *
 * Run:
 *   DEP_FE_PORT=5032 DEP_BE_PORT=6032 npx playwright test --config ui/tests/e2e/dependencies/playwright.config.ts
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
    baseURL: `http://localhost:${process.env.DEP_FE_PORT || '5002'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.DEP_CHANNEL || undefined } }],
});
