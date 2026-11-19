import { describe, expect, it } from 'vitest';

import { withStateKey } from '@sdk/page-state';

describe('withStateKey', () => {
  it('adds the key as the state query, ahead of any fragment', () => {
    expect(withStateKey('/app/', 'k1')).toBe('/app/?state=k1');
    expect(withStateKey('/app/?x=1#top', 'k 1')).toBe('/app/?x=1&state=k%201#top');
  });

  it('leaves the address alone with no key, or with one already there', () => {
    expect(withStateKey('/app/', undefined)).toBe('/app/');
    expect(withStateKey('', 'k1')).toBe('');
    expect(withStateKey('/app/?state=old', 'k1')).toBe('/app/?state=old');
  });
});
