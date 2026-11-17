import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `src/hooks/use-mobile.tsx` is THE mobile flag: nothing else in the app asks the browser whether it is a phone. */
const SRC = join(__dirname, '../../src');
const OWNER = join(SRC, 'hooks/use-mobile.tsx');
const ASKS_FOR_PHONE = /matchMedia\([^)]*(max-width|min-width|pointer|hover)|innerWidth\s*<\s*\d{3}/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('one mobile flag', () => {
  it('only use-mobile.tsx detects a phone — everything else calls useIsMobile() / isMobile()', () => {
    const offenders = files(SRC).filter((f) => f !== OWNER && ASKS_FOR_PHONE.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
