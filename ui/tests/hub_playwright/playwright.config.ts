import { defineConfig, devices } from '@playwright/test';

/**
 * Hub-realtime Playwright config.
 *
 * Two-browser tests against the alice (OSS, :4098 / :9008) and bob (APP,
 * :4097 / :9007) UIs. Both backends must already be running, both must be
 * cloud-logged-in to the local hub at :8093, and both bridges must be
 * connected. Tests fail fast — sub-second budgets — because the realtime
 * round-trip target is < 500 ms per leg.
 *
 * Run:
 *   npx playwright test --config ui/tests/hub_playwright/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 10_000,             // overall per-test budget — realtime SLO is sub-second per leg
  expect: { timeout: 2_000 },  // tight UI-readiness waits
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    headless: true,
    trace: 'retain-on-failure',
    actionTimeout: 3_000,
    navigationTimeout: 5_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
