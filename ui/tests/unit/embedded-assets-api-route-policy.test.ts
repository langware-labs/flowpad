/**
 * Source-level isolation guard for the embedded-assets live test.
 *
 * The long-test tier selects its backend through SDK config/FLOW_INSTANCE. Raw
 * fetches to a fixed localhost port bypass that selection and can mutate a
 * user's unrelated instance, so every direct route in the test must stay on
 * the configured apiClient.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(__dirname, '../long_tests/embedded_assets.test.ts'), 'utf-8');

describe('embedded-assets long-test API isolation policy', () => {
  it('uses only configured relative apiClient routes', () => {
    expect(SOURCE).toMatch(/import\s*\{[^}]*\bapiClient\b[^}]*\}\s*from\s*['"]@sdk['"]/s);
    expect(SOURCE).toMatch(
      /apiClient\.post\(\s*['"]\/graph\/compute_node\/@local\/fs-records\/index\?type=agent['"],\s*\{\}\s*\)/,
    );
    expect(SOURCE).toMatch(/apiClient\.get\(\s*['"]\/search['"]/);
    expect(SOURCE).toMatch(
      /apiClient\.delete\(\s*`\/graph\/compute_node\/@local\/fs-records\/agent\/\$\{agentRecordId\}`/,
    );

    expect(SOURCE).not.toMatch(/\bfetch\s*\(/);
    expect(SOURCE).not.toMatch(/https?:\/\/localhost(?::\d+)?/);
  });
});
