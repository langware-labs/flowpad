import { defineConfig, devices } from '@playwright/test';
import { adjusted } from '../../adjustableTimeout';

export default defineConfig({
  testDir: '.',
  testMatch: '*.md.ts',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  // Playwright's own defaults (30 s / 5 s), stated so ADJUSTABLE_TIMEOUT reaches them like every other area.
  timeout: adjusted(30_000),
  expect: { timeout: adjusted(5_000) },
  reporter: 'list',
  use: {
    baseURL: process.env.APP_URL || `http://localhost:${process.env.VITE_PORT || '4097'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
