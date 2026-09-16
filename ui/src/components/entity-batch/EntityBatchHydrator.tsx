import { dataManager, QueryRequest, type APIEntity } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useLayoutEffect, useMemo } from 'react';

/**
 * Invisible cache-warmer: ONE `$IN` query for a set of ids of a single type, so
 * the components that render those entities with `useEntity` resolve from the
 * batch instead of one GET each. Renders nothing.
 *
 * The batch starts in the layout phase. Every layout effect of a commit runs
 * before any passive effect, so the rows' `useEntity` effects find their ids
 * already claimed by this in-flight query and wait for it (see
 * `DataManager.claimIdBatch`) — wherever this sits in the tree. The watched
 * query then joins that same in-flight request for live updates.
 */
export function EntityBatchHydrator({ type, ids }: { type: string; ids: readonly string[] }) {
  // Sorted, so the same set in a new order is the same request (and the same
  // cache key as any other query built from those ids).
  const sortedIds = useMemo(() => [...new Set(ids)].sort(), [ids]);
  const idsKey = sortedIds.join(',');
  const request = useMemo(
    () =>
      new QueryRequest({
        type,
        query: { match: { op: '$IN', operands: ['id', sortedIds] } },
        name: `${type} batch hydration`,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id set, not the array identity
    [type, idsKey],
  );
  useLayoutEffect(() => {
    if (idsKey) void dataManager.query(request).catch(() => undefined);
  }, [request, idsKey]);
  useEntitiesQuery<APIEntity<any>>(request, { enabled: !!idsKey });
  return null;
}
