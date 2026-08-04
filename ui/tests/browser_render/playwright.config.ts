import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-RENDER tier: bugs that only exist once a real layout engine runs.
 *
 * Bidi reordering, glyph geometry and atomic-inline behaviour have no
 * representation in jsdom (tests/react) or node (tests/unit) — those tiers
 * would pass on a row the browser paints backwards. Specs here therefore run
 * in a real Chromium, but stay self-contained: no app, no backend, no dev
 * server. They mount the real production module under test on a blank page.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 20_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { headless: true, trace: 'retain-on-first-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
