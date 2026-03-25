import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for Triggers view regression tests.
 *
 * Tests cover both hook triggers and schedule triggers in the unified Triggers view.
 * Assumes the backend + frontend are already running.
 *
 * Run:
 *   VITE_PORT=4097 npx playwright test --config ui/tests/manual_regression/triggers/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.md.ts',
  timeout: 200_000,
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
