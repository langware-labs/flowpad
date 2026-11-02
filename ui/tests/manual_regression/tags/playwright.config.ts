import { defineConfig, devices } from '@playwright/test';
import { adjusted } from '../../adjustableTimeout';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: adjusted(30_000), // Playwright's defaults, runner-adjustable
  expect: { timeout: adjusted(5_000) },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.VITE_PORT || '4097'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
});
