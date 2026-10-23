import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **project invite = membership, not publish** scenario.
 *
 * Three already-running dev instances of the build under test (admin, editor,
 * member), each cloud-logged-in to the same hub. The spec reads their ports from
 * `.env.<name>.local` and drives one browser context per user.
 *
 * Each non-prod instance clones into its own `~/.flow/instances/<name>/workspace`, so
 * three plain launches are enough:
 *
 *   for n in admin-7 editor-5 member-6; do scripts/instance_ctl.sh launch $n; done
 *
 * Run:
 *   npx playwright test --config ui/tests/e2e/project-invite-members/playwright.config.ts
 * (override instance names with INVITE_ADMIN / INVITE_EDITOR / INVITE_MEMBER)
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
