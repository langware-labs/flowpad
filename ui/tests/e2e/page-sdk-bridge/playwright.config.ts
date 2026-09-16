import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **page SDK bridge** side tests: can a page shown in
 * Flowpad (plain `.html` or MCP UI `.mcp.html`) load the Flowpad SDK and reach
 * the agentic process it is shown beside?
 *
 * Drives a REAL browser against a disposable instance_ctl instance — never the
 * user's main backend. Assumes it is already launched
 * (`scripts/instance_ctl.sh launch <name>`); read the ports from
 * `.env.<name>.local`.
 *
 * Run:
 *   PSB_FE_PORT=5007 PSB_BE_PORT=6007 npx playwright test --config ui/tests/e2e/page-sdk-bridge/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.PSB_FE_PORT || '5007'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
