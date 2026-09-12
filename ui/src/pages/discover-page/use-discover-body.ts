import { FSRef, TypeId } from '@sdk';
import { parseFrontmatterDoc } from '@sdk/fs/frontmatter-parse';
import { useFSRefContent } from '@src/hooks/use-fs-ref-content';
import { useMemo } from 'react';
import type { DiscoverItem } from './discover-model';

/**
 * The asset's document, read through the ONE `fs` reader both runtimes serve:
 * on the hub the `body_ref` the directory named (a materialized tree), on the
 * desk the exact occurrence projected by the backend. `fsRef` is null when there is nothing to
 * read here, and the caller says why with `bodyCopyKey`.
 */
export function useDiscoverBody(item: DiscoverItem | null, mode: 'hub' | 'desk') {
  const fsRef = useMemo(() => {
    if (!item) return null;
    if (mode === 'hub') {
      const ref = item.body?.body_available ? item.body.body_ref : null;
      return ref ? new FSRef(ref.path, new TypeId(ref.type_id), 'file', true) : null;
    }
    const ref = item.bodyRef;
    return ref ? new FSRef(ref.path, new TypeId(ref.type_id), 'file', true) : null;
  }, [item, mode]);
  // Read-only presentation uses the fs reader also served by the hub.
  const reader = useMemo(() => fsRef ? { path: fsRef.vpath, read: () => fsRef.read(),
    write: () => Promise.reject(new Error('Discover is read-only')) } : null, [fsRef]);
  const content = useFSRefContent(reader, { autoSave: false });
  return { fsRef, body: parseFrontmatterDoc(content.content).body, isLoading: content.isLoading, loadError: content.loadError };
}
