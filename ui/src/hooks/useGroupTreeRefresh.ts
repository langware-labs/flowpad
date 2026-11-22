import { useEffect } from 'react';
import { dataManager } from '@sdk';
import { type GroupLeafMatch } from '@sdk';
import { QueryFilter, QueryRequest } from '@sdk/FlowSync/query';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';

/**
 * useGroupTreeRefresh — reactivity only (no state, no decisions).
 *
 * Keeps a mounted group tree live across clients/tabs: watches entity
 * updates for the `group` type and the tree's leaf types via the data
 * manager's WatchedQuery machinery, and pings the browseable-tree refresh
 * bus (`refreshNode(rootId)`) so the mounted tree re-fetches the affected
 * level. Local mutations already refresh explicitly from the adapter; this
 * hook covers everything that arrives over `data_op`.
 */
export function useGroupTreeRefresh(
  rootId: string,
  leafTypes: string[],
  enabled: boolean = true,
  /** Narrows the leaf watch to the tree's own leaves (the same match the listing uses). */
  leafMatch?: GroupLeafMatch,
): void {
  useEffect(() => {
    if (!enabled) return;
    const unsubs: Array<() => void> = [];
    let disposed = false;
    const types = ['group', ...leafTypes];
    for (const type of types) {
      void dataManager
        .watchQuery(
          new QueryRequest({
            type,
            query: leafMatch && type !== 'group' ? new QueryFilter({ type, match: leafMatch }) : null,
            name: `group-tree-refresh:${rootId}:${type}`,
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
  }, [rootId, enabled, leafTypes.join(','), leafMatch]);
}
