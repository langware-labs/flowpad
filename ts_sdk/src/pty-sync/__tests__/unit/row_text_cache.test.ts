import { describe, it, expect, vi } from 'vitest';
import { RowTextCache } from '../../adapter/RowTextCache.js';

describe('RowTextCache', () => {
  it('runs compute once per (row, version) pair', () => {
    const cache = new RowTextCache();
    const compute = vi.fn(() => 'row-text');

    expect(cache.getOrCompute(7, 1, compute)).toBe('row-text');
    expect(cache.getOrCompute(7, 1, compute)).toBe('row-text');
    expect(cache.getOrCompute(7, 1, compute)).toBe('row-text');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('keeps separate entries for different rows at the same version', () => {
    const cache = new RowTextCache();
    cache.getOrCompute(1, 5, () => 'a');
    cache.getOrCompute(2, 5, () => 'b');
    cache.getOrCompute(3, 5, () => 'c');
    expect(cache.size()).toBe(3);
    expect(cache.getOrCompute(2, 5, () => 'never')).toBe('b');
  });

  it('clears all entries when contentVersion advances', () => {
    const cache = new RowTextCache();
    cache.getOrCompute(1, 1, () => 'old');
    cache.getOrCompute(2, 1, () => 'old');
    expect(cache.size()).toBe(2);

    const fresh = vi.fn(() => 'new');
    expect(cache.getOrCompute(1, 2, fresh)).toBe('new');
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1); // version bump cleared, then row 1 re-cached
  });

  it('caches null results so repeated misses do not re-compute', () => {
    const cache = new RowTextCache();
    const compute = vi.fn<() => string | null>(() => null);
    expect(cache.getOrCompute(99, 1, compute)).toBeNull();
    expect(cache.getOrCompute(99, 1, compute)).toBeNull();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('clear() drops everything and resets version', () => {
    const cache = new RowTextCache();
    cache.getOrCompute(1, 1, () => 'a');
    cache.clear();
    expect(cache.size()).toBe(0);

    // After clear the next call repopulates regardless of version.
    const compute = vi.fn(() => 'b');
    cache.getOrCompute(1, 1, compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
