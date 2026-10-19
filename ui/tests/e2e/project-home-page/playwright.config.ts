import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **project home page** browser scenario
 * (`home_page` in `agentic-assets/project_manifest/project_manifest.json`).
 *
 * Drives a REAL browser against an already-running backend + Vite frontend of
 * the build under test — a disposable instance (`scripts/instance_ctl.sh launch
 * <name>`, ports from `.env.<name>.local`) or a worktree's own dev servers. The
 * spec creates its own projects and deletes them afterwards.
 *
 * Run:
 *   HP_FE_PORT=4099 HP_BE_PORT=6004 npx playwright test --config ui/tests/e2e/project-home-page/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.HP_FE_PORT || '5002'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.HP_CHANNEL || undefined } }],
});
