import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **LLM endpoint model sizes** scenario.
 *
 * Drives a real browser against the OSS dev server (hub page) of an instance that is
 * cloud-logged-in to a LOCAL hub running the model-sizes code. The spec seeds and deletes its
 * own endpoints through the page's session; nothing is spent.
 *
 * Run:
 *   LT_FE_PORT=4098 npx playwright test --config tests/e2e/llm-tiers/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.LT_FE_PORT || '4098'}`,
    headless: true,
    trace: 'retain-on-first-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
