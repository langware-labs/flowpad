/**
 * Regression test: rule/event components must not fetch a bare relative URL
 * like `fetch('/api/v1/rules')` — that resolves to the Vite dev server, not the
 * backend, so the dev server returns the SPA HTML shell, JSON.parse fails in a
 * catch block, and the list stays empty forever with no error anywhere.
 *
 * Backend access goes through `dataManager` (entities/actions) or `apiClient`
 * (non-entity REST, path only) — never a hand-built URL. See CLAUDE.md,
 * "Backend URLs in the frontend".
 *
 * This scans the DIRECTORIES rather than naming files. The previous version read
 * three filenames literally and would have thrown on `readFileSync` the moment
 * any of them was renamed — which is exactly what happened when the Triggers and
 * Signals screens merged into Events.
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const ROOTS = [
  resolve(__dirname, '../../src/components/events'),
  resolve(__dirname, '../../src/components/triggers-view'),
];

function sourceFiles(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  for (const root of ROOTS) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue; // a directory may legitimately not exist
    }
    for (const name of names) {
      if (!/\.tsx?$/.test(name)) continue;
      out.push({ path: `${root}/${name}`, src: readFileSync(resolve(root, name), 'utf-8') });
    }
  }
  return out;
}

describe('rule/event component fetch URLs', () => {
  it('scans a non-empty set of sources', () => {
    // Guards the guard: a glob that silently matches nothing would make every
    // assertion below vacuously true.
    expect(sourceFiles().length).toBeGreaterThan(3);
  });

  it('no component fetches a bare relative /api/v1/ URL', () => {
    const offenders = sourceFiles()
      .filter(({ src }) => /fetch\s*\(\s*['"`]\/api\/v1\//.test(src))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('no component builds a backend URL from __API_URL__ directly', () => {
    const offenders = sourceFiles()
      .filter(({ src }) => /__API_URL__/.test(src))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
