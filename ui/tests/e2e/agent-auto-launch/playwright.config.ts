import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the project **agent auto-launch** browser scenario.
 *
 * Drives a REAL browser against a disposable instance_ctl instance — never the
 * user's main dev backend. Assumes it is already launched
 * (`scripts/instance_ctl.sh launch <name>`); read the ports from
 * `.env.<name>.local`.
 *
 * Run:
 *   AL_FE_PORT=5019 AL_BE_PORT=6014 npx playwright test --config ui/tests/e2e/agent-auto-launch/playwright.config.ts
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
    baseURL: `http://localhost:${process.env.AL_FE_PORT || '5002'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
