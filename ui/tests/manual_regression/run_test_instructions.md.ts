/**
 * Executability guard for run_test_instructions.md.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..', '..');
const MANUAL = path.join(UI, 'tests', 'manual_regression');

test('documented Playwright suites, helpers, and serial policy remain executable', () => {
  const runbook = readFileSync(path.join(MANUAL, 'run_test_instructions.md'), 'utf8');

  for (const relativePath of ['chat/helpers.ts', 'terminal/helpers.ts']) {
    expect(existsSync(path.join(MANUAL, relativePath)), relativePath).toBe(true);
    expect(runbook).toContain(relativePath);
  }

  for (const category of ['chat', 'terminal']) {
    const configPath = path.join(MANUAL, category, 'playwright.config.ts');
    expect(existsSync(configPath), `${category} Playwright config`).toBe(true);
    expect(runbook).toContain(`tests/manual_regression/${category}/playwright.config.ts`);

    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('fullyParallel: false');
    expect(config).toContain('retries: 0');
    expect(config).toContain('workers: 1');
  }
});
