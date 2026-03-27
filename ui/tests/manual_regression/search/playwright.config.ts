import { defineConfig, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// Read LOCAL_SERVER_PORT from ui/.env.local so API_URL follows the configured backend port.
// Parse .env.local and collect values.
const localEnvVars: Record<string, string> = {};
(function loadLocalEnv() {
  const envPath = path.resolve(_dirname, '../../../.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) localEnvVars[key] = val;
  }
})();

// Determine the API port: CLI env > .env.local > default 9007
const apiPort = process.env.LOCAL_SERVER_PORT || localEnvVars['LOCAL_SERVER_PORT'] || '9007';
const resolvedApiUrl = process.env.API_URL || `http://localhost:${apiPort}`;

// Also set on process.env so it propagates to workers in CJS mode
if (!process.env.API_URL) process.env.API_URL = resolvedApiUrl;

/**
 * Playwright config for record search tests.
 *
 * Tests cover the home compact search bar and the full search view (/dock/search).
 * Assumes backend + frontend are already running.
 *
 * Run:
 *   npx playwright test --config ui/tests/manual_regression/search/playwright.config.ts
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
    launchOptions: { slowMo: 50 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
