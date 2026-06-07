import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for manual regression markdown_index tests.
 *
 * Covers the MarkdownIndex entity + LLM Indexers UI panel. Assumes the backend
 * + frontend are already running. The cold/incremental rebuild steps (S5, S6,
 * S11) drive a real AgenticProcess that calls Claude — those are gated on
 * ANTHROPIC_API_KEY being present in the backend env and skip otherwise.
 *
 * Run:
 *   cd ui && VITE_PORT=$VITE_PORT npx playwright test \
 *     --config tests/manual_regression/markdown_index/playwright.config.ts
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
