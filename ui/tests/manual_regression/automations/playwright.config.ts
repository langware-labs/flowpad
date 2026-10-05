import { defineConfig, devices } from '@playwright/test';

/**
 * Automations screen — browser stress validation. Assumes the backend + frontend
 * of a disposable instance are already running (scripts/instance_ctl.sh launch …).
 *
 *   FLOW_INSTANCE=auto-1 VITE_PORT=5026 npx playwright test --config tests/manual_regression/automations/playwright.config.ts
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
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
