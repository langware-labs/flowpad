import { defineConfig, devices } from '@playwright/test';

/**
 * Inbound routing E2E: a WhatsApp number on the waha stack (`waha_stack.py`) → the hub webhook chain,
 * configured ONLY through the Inbound screen → three seeded agents (`seed.py`) → their replies, read back
 * from the stack. See `inbound_routing.spec.ts` for the scenarios and the run command.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.INB_FE_PORT || '5007'}`,
    headless: process.env.INB_HEADED ? false : true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
