/**
 * The UI is open source and carries no Sentry (the SDK is loaded at runtime from the hub, see
 * `src/telemetry/sentry-contract.ts`). This keeps it that way: no Sentry package in the build's
 * dependencies, and no import of one from the code the build bundles. `@sentry/browser` may stay a
 * devDependency -- the tests run the real SDK -- because nothing bundled imports it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ui = resolve(__dirname, '../..');
const roots = [join(ui, 'src'), resolve(ui, '..', 'ts_sdk', 'src')];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) yield path;
  }
}

describe('no Sentry in the open-source bundle', () => {
  it('is not a dependency of the build', () => {
    const pkg = JSON.parse(readFileSync(join(ui, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(Object.keys(pkg[field] ?? {}).filter((name) => name.startsWith('@sentry/')), field).toEqual([]);
    }
  });

  it('is not imported by anything the build bundles', () => {
    const importsSentry = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]@sentry\//;
    const offenders = roots.flatMap((root) => [...sources(root)].filter((file) => importsSentry.test(readFileSync(file, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
