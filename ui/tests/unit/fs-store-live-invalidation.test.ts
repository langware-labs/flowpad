import { fsStore, TypeId } from '@sdk';
import { afterEach, describe, expect, it } from 'vitest';

const COMPUTE_NODE = new TypeId('compute_node', '@local');

afterEach(() => fsStore.getState().clearCache());

describe('FSStore live invalidation', () => {
  it('advances file and ancestor revisions while preserving a dirty buffer', () => {
    const store = fsStore.getState();
    store.setContent('src/live.ts', 'local edit', true, COMPUTE_NODE);

    store.invalidate(COMPUTE_NODE, '/src/live.ts', 'content');

    expect(store.getRevision(COMPUTE_NODE, 'src/live.ts')).toBe(1);
    expect(store.getRevision(COMPUTE_NODE, '/src')).toBe(1);
    expect(store.getRevision(COMPUTE_NODE, '/')).toBe(1);
    expect(store.getContentFromCache(COMPUTE_NODE, 'src/live.ts')).toMatchObject({
      content: 'local edit',
      isDirty: true,
    });

    store.markClean('src/live.ts', COMPUTE_NODE);
    store.invalidate(COMPUTE_NODE, 'src/live.ts', 'content');

    expect(store.getRevision(COMPUTE_NODE, 'src/live.ts')).toBe(2);
    expect(store.getContentFromCache(COMPUTE_NODE, 'src/live.ts')).toBeNull();
  });
});
