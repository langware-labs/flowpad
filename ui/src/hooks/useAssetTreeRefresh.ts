import { useCallback, useMemo } from 'react';
import { useEntityOps } from '@sdk/react/hooks';
import type { TypeId } from '@sdk';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { scopeFilterKey, type ScopeFilter } from '@src/lib/scope-filter';

/**
 * useAssetTreeRefresh — reactivity only (no state, no decisions).
 *
 * Each asset-type root (assetTypeRoot / markdownFolderRoot) lazy-loads its
 * children once on expand and caches them. Without a live signal a newly
 * created / indexed entity — or the first batch that finishes indexing after
 * the tree mounts — never reaches the already-rendered root, so the list looks
 * empty or stale until a manual refresh. This listens to WS entity ops for
 * every visible type and pings the browseable-tree refresh bus
 * (`refreshNode(rootId)`) so the mounted root re-fetches; a collapsed root is
 * just marked stale and re-fetches on its next expand (see
 * `useBrowseableTree.invalidate`).
 *
 * IMPORTANT: this must stay an entity-op subscription (`useEntityOps`), NOT a
 * `dataManager.watchQuery` per type. A watched query is the wrong tool for a
 * "something changed" ping: it primes by downloading the ENTIRE type corpus
 * (3.3MB / 3-5s for markdown at ~3k docs) and `handleDataOp` re-runs that
 * full corpus fetch on every WS create — the tree only ever consumed the
 * callback tick and discarded the data.
 *
 * rootId mirrors the adapters' formula: `asset-type:<type>:<filterSig>`.
 */
export function useAssetTreeRefresh(typeNames: string[], scope: ScopeFilter): void {
  const filterSig = scopeFilterKey(scope);
  const key = typeNames.join(',');
  // Stable identities so useEntityOps doesn't re-subscribe every render.
  const types = useMemo(() => key.split(',').filter(Boolean), [key]);
  const onEntityOp = useCallback(
    (typeId: TypeId) => {
      refreshNode(`asset-type:${typeId.type}:${filterSig}`);
    },
    [filterSig],
  );
  useEntityOps(types, onEntityOp);
}
