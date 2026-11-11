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
const NONE: never[] = [];

/**
 * The batch itself, for a caller that also READS the batched entities: one
 * request serves both the cache warm-up and the caller's data, so the same ids
 * are never fetched by a second query.
 */
export function useEntityBatch<U extends APIEntity<any>>(type: string, ids: readonly string[]): U[] {
  return useEntityBatchState<U>(type, ids).data;
}

/**
 * The batch plus whether it has settled (answered or failed; trivially, with no ids), for a
 * caller that waits for the batch before mounting what reads it.
 */
export function useEntityBatchState<U extends APIEntity<any>>(
  type: string,
  ids: readonly string[],
): { data: U[]; settled: boolean } {
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
  const { data, isLoading, isError } = useEntitiesQuery<U>(request, { enabled: !!idsKey });
  // Before its first answer the query reads "not loading" with no data; settled means it answered.
  return { data: data ?? NONE, settled: !idsKey || isError || (data !== undefined && !isLoading) };
}

export function EntityBatchHydrator({ type, ids }: { type: string; ids: readonly string[] }) {
  useEntityBatch(type, ids);
  return null;
}
