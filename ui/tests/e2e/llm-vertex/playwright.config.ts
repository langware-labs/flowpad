import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **Vertex endpoint** scenario: a real Google Vertex root made through the
 * shared "New endpoint" dialog, tested and listed.
 *
 * Drives a real browser against the OSS dev server of a disposable instance that is cloud-logged-in to a
 * LOCAL hub (never prod). The key comes from the environment and is typed by the test, never logged:
 *   VERTEX_API_KEY=<key> [VERTEX_PROJECT=flowpad-vertex-1111] LV_FE_PORT=<frontend port> \
 *     npx playwright test --config tests/e2e/llm-vertex/playwright.config.ts
 * A run makes one credential test call (one token) and deletes the endpoint it created.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.LV_FE_PORT || '4098'}`,
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
