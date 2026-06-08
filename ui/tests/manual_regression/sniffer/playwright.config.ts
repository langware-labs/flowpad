import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for manual regression sniffer tests.
 *
 * These tests assert the shipped OPT-IN / default-OFF sniffer contract
 * (InstanceSettings.sniffer_enabled defaults false → bootstrap sniffer_hook=null,
 * no sniffer agent_hook auto-created). They assume the backend + frontend are
 * already running.
 *
 * Run:
 *   cd ui && VITE_PORT=$VITE_PORT npx playwright test \
 *     --config tests/manual_regression/sniffer/playwright.config.ts
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
