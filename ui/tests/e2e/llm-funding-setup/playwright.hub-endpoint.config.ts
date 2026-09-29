import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **llm-hub-endpoint-funding** scenario — a box bound to a hub
 * LLMEndpoint whose CHAIN (not its own row) narrows which model the agent fallback may use.
 * Needs its own isolated backend, started by `start_backend.py --scenario hub-endpoint`
 * (see that script for what it seeds and why).
 *
 * Run:
 *   LLM_HUB_FE_PORT=5101 LLM_HUB_BE_PORT=6101 \
 *     npx playwright test --config ui/tests/e2e/llm-funding-setup/playwright.hub-endpoint.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'hub_endpoint.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.LLM_HUB_FE_PORT || '5101'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
