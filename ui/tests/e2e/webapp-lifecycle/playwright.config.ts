import { defineConfig, devices } from '@playwright/test';
import { resolveInstance } from './_instance';
import { reportDir } from './_reportdir';

/**
 * Webapp-lifecycle validation suite (plan: one lifecycle, one coordinator).
 *
 * Drives a REAL browser against an already-running backend + Vite frontend of the build under
 * test — a disposable instance launched from this checkout. Never prod, never `oss`.
 *
 *   scripts/instance_ctl.sh launch wl-7
 *   cd ui && WL_INSTANCE=wl-7 npx playwright test --config tests/e2e/webapp-lifecycle/playwright.config.ts
 *
 * The report (report.json + report.html) goes to ${WL_REPORT_DIR:-~/Downloads/webapp-lifecycle/<stamp>}.
 */
const dir = reportDir();
const inst = resolveInstance();
const fe = typeof inst === 'string' ? Number(process.env.WL_FE_PORT || 5007) : inst.frontendPort;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  outputDir: `${dir}/test-results`,
  reporter: [['list'], ['./_report.ts']],
  use: {
    baseURL: `http://localhost:${fe}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.WL_CHANNEL || undefined } }],
});
