import { defineConfig, devices } from '@playwright/test';
import { apiOrigin } from '../_shared/api';

// Propagate the shared instance-aware backend origin to Playwright workers.
process.env.API_URL ||= apiOrigin();

/**
 * Playwright config for record search tests.
 *
 * Tests cover the home compact search bar and the full search view (/dock/search).
 * Assumes backend + frontend are already running.
 *
 * Run:
 *   npx playwright test --config ui/tests/manual_regression/search/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.md.ts',
  timeout: 60_000,
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
