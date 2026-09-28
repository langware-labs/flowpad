import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **llm-global-default-funding** scenario — a box with NO
 * LLMEndpoint of its own, funded only by the hub's global default. Needs its own isolated
 * backend, started by `start_backend.py --scenario global-default`.
 *
 * Run:
 *   LLM_GLOBAL_FE_PORT=5102 LLM_GLOBAL_BE_PORT=6102 \
 *     npx playwright test --config ui/tests/e2e/llm-funding-setup/playwright.global-default.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'global_default.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.LLM_GLOBAL_FE_PORT || '5102'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
