/** Dev is a switch, not a tier: a `dev_only` type shows only with developer mode on. */
import { describe, expect, it } from 'vitest';
import { isBrowseableIn } from '@sdk/FlowSync/schema';

describe('isBrowseableIn — dev_only', () => {
  it('a dev_only type at Advanced shows only with Dev on', () => {
    expect(isBrowseableIn('advanced', 'advanced', true)).toBe(false);
    expect(isBrowseableIn('advanced', 'dev', true)).toBe(true);
  });

  it('an ordinary type keeps the cumulative tiers', () => {
    expect(isBrowseableIn('advanced', 'vibe')).toBe(false);
    expect(isBrowseableIn('advanced', 'dev')).toBe(true);
    expect(isBrowseableIn('standard', 'standard')).toBe(true);
  });
});
