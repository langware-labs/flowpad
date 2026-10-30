import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the **chartit** browser scenario: C4 and sequence charts in the chart editor.
 *
 * Drives a REAL browser against an already-running backend + Vite frontend of the build under test —
 * a disposable instance (`scripts/instance_ctl.sh launch <name>`, ports from `.env.<name>.local`).
 * The spec creates its own project, writes its charts the way the chartit skill says, and deletes the
 * project afterwards: nothing it made stays.
 *
 * Run:
 *   CH_FE_PORT=5033 CH_BE_PORT=6032 npx playwright test --config ui/tests/e2e/chartit/playwright.config.ts
 *   CH_WORKER=1 … also runs the step where a real context worker edits a chart (spends an LLM turn).
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
    baseURL: `http://localhost:${process.env.CH_FE_PORT || '5002'}`,
    headless: true,
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } }],
});
