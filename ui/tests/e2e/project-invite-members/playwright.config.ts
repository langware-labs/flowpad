import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **project invite = membership, not publish** scenario.
 *
 * Three already-running dev instances of the build under test (admin, editor,
 * member), each cloud-logged-in to the same hub. The spec reads their ports from
 * `.env.<name>.local` and drives one browser context per user.
 *
 * Every instance MUST have its own home: the clone target is
 * `<home>/Flowpad workspace`, so instances sharing one home clone into the same
 * folder and overwrite each other. Launch (Git Bash, from the flowpad checkout):
 *
 *   for n in admin-7 editor-5 member-6; do
 *     h="$HOME/flowpad-$n-home"; mkdir -p "$h/Flowpad workspace"; cp -n ~/.gitconfig "$h/"
 *     FLOW_HOME="$HOME/.flow" HOME="$h" USERPROFILE="$(cygpath -w "$h")" scripts/instance_ctl.sh launch $n
 *   done
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
