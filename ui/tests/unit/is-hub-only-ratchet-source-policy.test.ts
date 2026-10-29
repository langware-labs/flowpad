/**
 * `isHubOnly()` answers "is this the hub?" — and so cannot tell a desktop from a cloud
 * sandbox or an agent box. Gating a desktop-only feature on it shows that feature on every
 * cloud box: the Open Folder picker ran on a box with no screen (500), and set-up offers
 * popped up on boxes nobody watches. Ask what the runtime can DO instead —
 * `dataContext.caps` (`ts_sdk/src/utils/runtime.ts`).
 *
 * A ratchet, not a ban: the existing calls migrate area by area. The count may only go
 * down — when you remove calls, lower BASELINE to the new count.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BASELINE = 95;
const SRC = resolve(__dirname, '../../src');

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

function countCalls(): number {
  let n = 0;
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('isHubOnly(')) continue;
    for (const line of text.split('\n')) {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
      n += line.match(/\bisHubOnly\(\)/g)?.length ?? 0;
    }
  }
  return n;
}

describe('isHubOnly() in the UI', () => {
  it('is not called in more places than before — gate on dataContext.caps instead', () => {
    expect(countCalls()).toBeLessThanOrEqual(BASELINE);
  });
});
