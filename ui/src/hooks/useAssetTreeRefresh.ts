import { useEffect } from 'react';
import { dataManager } from '@sdk';
import { QueryRequest } from '@sdk/FlowSync/query';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { scopeFilterKey, type ScopeFilter } from '@src/lib/scope-filter';

/**
 * useAssetTreeRefresh — reactivity only (no state, no decisions).
 *
 * Each asset-type root (assetTypeRoot / markdownFolderRoot) lazy-loads its
 * children once on expand and caches them. Without a live signal a newly
 * created / indexed entity — or the first batch that finishes indexing after
 * the tree mounts — never reaches the already-rendered root, so the list looks
 * empty or stale until a manual refresh. This watches entity updates for every
 * visible type via the data manager's WatchedQuery machinery and pings the
 * browseable-tree refresh bus (`refreshNode(rootId)`) so the mounted root
 * re-fetches. `watchQuery` primes on subscribe, so a root that mounted empty
 * self-heals once data is available; a collapsed root is just marked stale and
 * re-fetches on its next expand (see `useBrowseableTree.invalidate`).
 *
 * rootId mirrors the adapters' formula: `asset-type:<type>:<filterSig>`.
 */
export function useAssetTreeRefresh(typeNames: string[], scope: ScopeFilter): void {
  const filterSig = scopeFilterKey(scope);
  const key = typeNames.join(',');
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;
    for (const typeName of typeNames) {
      const rootId = `asset-type:${typeName}:${filterSig}`;
      void dataManager
        .watchQuery(
          new QueryRequest({
            type: typeName,
            query: null,
            name: `asset-tree-refresh:${rootId}`,
            callback: () => refreshNode(rootId),
          }),
        )
        .then((unsub) => {
          if (disposed) unsub();
          else unsubs.push(unsub);
        })
        .catch(() => undefined);
    }
    return () => {
      disposed = true;
      for (const unsub of unsubs) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, filterSig]);
}
