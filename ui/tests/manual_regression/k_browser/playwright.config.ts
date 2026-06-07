import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Knowledge Atlas (k-browser) manual regression tests.
 *
 * Covers index-status overlay + real-filesystem change detection + line diffs.
 * The whole flow is structural (native LLMIndexer scan/stamp — NO LLM), so
 * nothing here is gated on ANTHROPIC_API_KEY. Assumes the backend + frontend
 * are already running (oss dev pair by default: vite 4098 → api 9008).
 *
 * Run:
 *   cd ui && npx playwright test \
 *     --config tests/manual_regression/k_browser/playwright.config.ts
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
