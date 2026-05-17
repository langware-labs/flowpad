import { describe, it, expect, vi } from 'vitest';
import { AnnotationRowResolver } from '../../AnnotationRowResolver.js';
import { StubXtermAdapter } from '../../adapter/XtermAdapter.js';

function makeAdapter(lines: Record<number, string>, eviction = 0): StubXtermAdapter {
  const a = new StubXtermAdapter();
  a.evictionOffset = eviction;
  for (const [k, v] of Object.entries(lines)) {
    a.injectLine(Number(k), v);
  }
  const maxRow = Math.max(...Object.keys(lines).map(Number), eviction);
  a.bufferLength = maxRow + 1 - eviction;
  a.scrollState.bufferLength = a.bufferLength;
  return a;
}

describe('AnnotationRowResolver', () => {
  it('resolves and caches an annotation row', () => {
    const adapter = makeAdapter({ 0: 'noise', 1: 'noise2', 2: '❯ run tests' });
    const resolver = new AnnotationRowResolver();

    expect(resolver.resolve('a1', ['run tests'], adapter, 0)).toBe(2);
    expect(resolver.size()).toBe(1);
  });

  it('returns the cached row on subsequent calls without rescanning', () => {
    const adapter = makeAdapter({ 0: 'noise', 1: '❯ deploy' });
    const resolver = new AnnotationRowResolver();
    resolver.resolve('a1', ['deploy'], adapter, 0);

    const spy = vi.spyOn(adapter, 'getLineText');
    expect(resolver.resolve('a1', ['deploy'], adapter, 0)).toBe(1);
    // Only one getLineText call: the cache-validation check on the cached row.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1);
  });

  it('re-scans when the cached row no longer matches the needle', () => {
    const adapter = makeAdapter({ 0: '❯ original prompt', 1: 'unrelated' });
    const resolver = new AnnotationRowResolver();
    resolver.resolve('a1', ['original prompt'], adapter, 0);

    // Mutate row 0 so the cached row is stale.
    adapter.injectLine(0, 'something else entirely');
    // Add a new row matching the needle further down.
    adapter.injectLine(2, '❯ original prompt');
    adapter.bufferLength = 3;
    adapter.scrollState.bufferLength = 3;

    expect(resolver.resolve('a1', ['original prompt'], adapter, 0)).toBe(2);
  });

  it('re-scans when needles change (annotation content edited)', () => {
    const adapter = makeAdapter({ 0: '❯ alpha', 1: '❯ beta' });
    const resolver = new AnnotationRowResolver();
    resolver.resolve('a1', ['alpha'], adapter, 0);
    // Same id, different needles → must rescan.
    expect(resolver.resolve('a1', ['beta'], adapter, 0)).toBe(1);
  });

  it('returns null when the needle cannot be found', () => {
    const adapter = makeAdapter({ 0: 'foo' });
    const resolver = new AnnotationRowResolver();
    expect(resolver.resolve('a1', ['missing'], adapter, 0)).toBeNull();
    expect(resolver.size()).toBe(0);
  });

  it('pruneEvicted drops entries whose row is below the floor', () => {
    const adapter = makeAdapter({ 0: '❯ a', 5: '❯ b' });
    const resolver = new AnnotationRowResolver();
    resolver.resolve('a1', ['a'], adapter, 0);
    resolver.resolve('a2', ['b'], adapter, 0);
    expect(resolver.size()).toBe(2);

    resolver.pruneEvicted(3);
    expect(resolver.size()).toBe(1);
    // The entry for 'a' (row 0) was dropped; 'b' (row 5) survives.
  });

  it('treats rows below eviction as evicted on lookup', () => {
    const adapter = makeAdapter({ 5: '❯ live' }, /*eviction=*/ 5);
    const resolver = new AnnotationRowResolver();
    resolver.resolve('a1', ['live'], adapter, 5);

    // Advance the eviction past the cached row; lookup must rescan.
    adapter.evictionOffset = 6;
    adapter.injectLine(7, '❯ live');
    adapter.bufferLength = 2; // rows 6 and 7 relative to eviction=6
    adapter.scrollState.bufferLength = 2;

    expect(resolver.resolve('a1', ['live'], adapter, 6)).toBe(7);
  });

  it('clear() drops every cached entry', () => {
    const adapter = makeAdapter({ 0: '❯ x', 1: '❯ y' });
    const resolver = new AnnotationRowResolver();
    resolver.resolve('a1', ['x'], adapter, 0);
    resolver.resolve('a2', ['y'], adapter, 0);
    expect(resolver.size()).toBe(2);
    resolver.clear();
    expect(resolver.size()).toBe(0);
  });

  it('returns null when needles array is empty', () => {
    const adapter = makeAdapter({ 0: 'foo' });
    const resolver = new AnnotationRowResolver();
    expect(resolver.resolve('a1', [], adapter, 0)).toBeNull();
  });
});
