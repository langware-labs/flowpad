import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for manual regression whiteboard tests.
 *
 * These tests target the whiteboard editor + wiki resolver. They assume
 * the backend + frontend are already running and that the new whiteboard
 * code is loaded (WhiteboardAssetEditor, wiki_router, Whiteboard Entity).
 *
 * Run:
 *   cd ui && VITE_PORT=$VITE_PORT npx playwright test \
 *     --config tests/manual_regression/whiteboard/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.md.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.VITE_PORT || '4098'}`,
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
