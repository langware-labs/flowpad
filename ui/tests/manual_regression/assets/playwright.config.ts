import { defineConfig, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

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

const apiPort = process.env.LOCAL_SERVER_PORT || localEnvVars['LOCAL_SERVER_PORT'] || '9008';
const resolvedApiUrl = process.env.API_URL || `http://localhost:${apiPort}`;
if (!process.env.API_URL) process.env.API_URL = resolvedApiUrl;

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
    baseURL: `http://localhost:${process.env.VITE_PORT || '4098'}`,
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
