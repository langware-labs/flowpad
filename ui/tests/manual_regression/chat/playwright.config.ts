import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for manual regression chat tests.
 *
 * These tests target the micro-apps graph UI (HomeLanding / shell terminal).
 * They assume the backend + frontend are already running.
 *
 * Run:
 *   npx playwright test --config flowpad/ui/tests/manual_regression/chat/playwright.config.ts
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
