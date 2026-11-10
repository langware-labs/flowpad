import { defineConfig, devices } from '@playwright/test';

/**
 * Publish an agent to git from the desktop, then open its editor on the hub UI.
 *
 * Needs a local hub, a launched instance logged in to it, and a hub-mode dev UI
 * proxying to the same hub:
 *   env -u LOCAL_SERVER_PORT scripts/instance_ctl.sh launch hubgit-1 --hub http://localhost:8093
 *   HGA_BE_PORT=6011 HGA_HUB_FE_PORT=4100 \
 *   HGA_HUB_EMAIL=hubgit-1@local.test HGA_HUB_PASSWORD=hubgit-1-pw-1234 \
 *   npx playwright test --config tests/e2e/hub-git-agent-editor/playwright.config.ts
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
  use: { headless: true, trace: 'retain-on-first-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
