import type { AssetDescriptor } from '@sdk';
import { describe, expect, it } from 'vitest';

import { isHomePageCandidate } from '@src/project-home-page/home-page-candidates';

const PROJECT = 'C:/work/acme';
const DESK = 'C:/work/vendor-desk';

function asset(posix_path: string | null, typeid = 'agent-00000000-0000-4000-8000-000000000001'): AssetDescriptor {
  return { typeid, posix_path, source: 'user_dir' } as AssetDescriptor;
}

describe('isHomePageCandidate — the backend boundary, on the picker', () => {
  it.each([
    ['the project’s own agent', `${PROJECT}/agentic-assets/agent/intake`],
    ['an agent in a direct context folder', `${DESK}/agentic-assets/agent/support`],
    ['a backslash, differently-cased Windows spelling', 'c:\\Work\\ACME\\agentic-assets\\agent\\intake'],
  ])('offers %s', (_label, path) => {
    expect(isHomePageCandidate(asset(path), [PROJECT, DESK])).toBe(true);
  });

  it.each([
    ['a user-level asset', 'C:/Users/me/agentic-assets/skill/fill-hours'],
    ['another project', 'C:/work/other/agentic-assets/agent/intake'],
    ['a sibling whose name only STARTS like the project', 'C:/work/acme-old/agentic-assets/agent/intake'],
    ['the project folder itself', PROJECT],
  ])('refuses %s', (_label, path) => {
    expect(isHomePageCandidate(asset(path), [PROJECT, DESK])).toBe(false);
  });

  it('refuses a row with no path or no TypeId, and everything when the project has no roots', () => {
    expect(isHomePageCandidate(asset(null), [PROJECT])).toBe(false);
    expect(isHomePageCandidate(asset(`${PROJECT}/a.md`, ''), [PROJECT])).toBe(false);
    expect(isHomePageCandidate(asset(`${PROJECT}/agentic-assets/agent/intake`), [])).toBe(false);
  });
});
