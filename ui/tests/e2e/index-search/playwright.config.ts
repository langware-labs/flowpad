import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for index-search E2E scenarios.
 *
 * Covers: scan, index, search, asset browser, search filters.
 * Assumes backend + frontend are already running.
 *
 * Run all:
 *   npx playwright test --config ui/tests/e2e/index-search/playwright.config.ts
 *
 * Run single file:
 *   npx playwright test --config ui/tests/e2e/index-search/playwright.config.ts scan_records_viewer.md.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.md.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.VITE_PORT || '4097'}`,
    headless: true,
    trace: 'retain-on-first-failure',
    launchOptions: { slowMo: 50 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
