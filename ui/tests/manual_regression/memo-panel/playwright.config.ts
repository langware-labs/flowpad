import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for memo panel tests.
 *
 * Tests cover the Memo Panel modal, iframe initialization, CRUD operations,
 * and backend persistence.
 * Assumes backend + frontend are already running.
 *
 * Run:
 *   npx playwright test --config ui/tests/manual_regression/memo-panel/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.md.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.VITE_PORT || '4097'}`,
    headless: false,
    trace: 'retain-on-first-failure',
    launchOptions: { slowMo: 100 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
