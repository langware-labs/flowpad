import { defineConfig, devices } from '@playwright/test';

/**
 * Live MCP Apps/Vibe regression.
 *
 * Requires a running backend + frontend and a usable live Vibe agent.
 *
 * Run:
 *   npx playwright test --config ui/src/test/manual_regression/mcp-ui/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.md.ts',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.VITE_PORT || '4097'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
