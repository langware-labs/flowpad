import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **chat on a deployed agent, from the desktop** scenario.
 *
 * Drives a REAL browser against a disposable instance_ctl instance that is
 * cloud-logged-in to a hub holding an already-deployed agent — never the user's
 * main dev backend. Assumes the instance is launched
 * (`scripts/instance_ctl.sh launch <name>`) and the deployment SEEDED OUTSIDE
 * the test (a deploy is a real box; it is never a test's job). Timeouts are the
 * agent-auto-launch scenario's, unchanged.
 *
 * Run:
 *   DAC_FE_PORT=5009 DAC_BE_PORT=6009 DAC_AGENT_ID=<uuid> DAC_DEPLOYMENT_ID=<uuid> \
 *   npx playwright test --config tests/e2e/deployed-agent-chat/playwright.config.ts
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
    baseURL: `http://localhost:${process.env.DAC_FE_PORT || '5009'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
