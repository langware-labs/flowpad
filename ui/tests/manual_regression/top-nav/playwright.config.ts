import { defineConfig, devices } from '@playwright/test';

/**
 * The top bar's Record screen in a real browser, headless. The OS picker is the one thing
 * a headless box cannot answer (no surface to capture, and whole-screen capture needs the
 * macOS Screen Recording grant), so `record_screen.md.ts` answers `getDisplayMedia` itself
 * with a canvas `captureStream()` — a real MediaStream, so MediaRecorder, the upload, the
 * dialog, the share and the move stay real.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.md.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${process.env.VITE_PORT || '4097'}`,
    headless: true,
    trace: 'retain-on-first-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
