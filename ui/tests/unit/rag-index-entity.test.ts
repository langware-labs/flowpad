/**
 * `RagIndex.roots` must be REPLACED by an update, never merged into.
 *
 * `deepAssign` merges arrays by index and never shrinks the target, so a wire value with one
 * fewer root leaves the removed path in the cached entity. That is not a cosmetic staleness:
 * every tree derives its brain marker from this list, so a folder removed in the editor kept
 * its badge in the explorer and the docs menu until someone reloaded the page.
 */
import { describe, expect, it } from 'vitest';
import { RagIndex } from '@sdk';

describe('RagIndex.onEntityUpdate', () => {
  it('replaces roots with the wire value when one is removed', () => {
    const index = new RagIndex({ roots: ['/a', '/b'] });
    const wire = { roots: ['/a'] };
    index.onEntityUpdate(wire);
    expect(index.roots).toEqual(['/a']);
  });

  it('strips roots from the payload so the merge cannot put them back', () => {
    // onEntityUpdate runs BEFORE deepAssign; leaving the field would undo the replacement.
    const index = new RagIndex({ roots: ['/a', '/b'] });
    const wire: { roots?: string[] } = { roots: ['/a'] };
    index.onEntityUpdate(wire);
    expect(wire.roots).toBeUndefined();
  });

  it('leaves roots alone when the update does not mention them', () => {
    const index = new RagIndex({ roots: ['/a'] });
    index.onEntityUpdate({ chunk_count: 12 });
    expect(index.roots).toEqual(['/a']);
  });

  it('handles the last root going away', () => {
    const index = new RagIndex({ roots: ['/a'] });
    index.onEntityUpdate({ roots: [] });
    expect(index.roots).toEqual([]);
  });
});
