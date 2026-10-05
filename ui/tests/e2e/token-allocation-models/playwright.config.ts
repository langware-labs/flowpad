import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **token allocation model picker** scenario.
 *
 * Drives a REAL browser against a desktop instance that is cloud-logged-in to a hub
 * holding an LLM endpoint its user administers — never the user's main dev backend.
 * Assumes the instance is launched and the agent and endpoint SEEDED OUTSIDE the test.
 * Nothing is deployed: the dialog is filled and left. Timeouts are the
 * deployed-agent-chat scenario's, unchanged.
 *
 * Run:
 *   TAM_FE_PORT=4098 TAM_BE_PORT=6004 TAM_AGENT_ID=<uuid> TAM_SOURCE_ID=<llm_endpoint uuid> \
 *   npx playwright test --config tests/e2e/token-allocation-models/playwright.config.ts
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
    baseURL: `http://localhost:${process.env.TAM_FE_PORT || '4098'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
