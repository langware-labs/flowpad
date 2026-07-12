import { APIEntity, FSRef, dataManager, systemTools } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

/**
 * Discriminator for entity-by-path resolution lifecycle.
 *
 * - `querying`      — exact path lookup in flight (initial load)
 * - `discovering`   — exact-lookup miss → calling `systemTools.discoverByPath`
 * - `resolved`      — entity available
 * - `missing_asset` — terminal: either 404 from discoverByPath (file isn't
 *                     on disk for this type) OR the matched entity is flagged
 *                     `orphan === true` by the backend FSIndexer (stale row,
 *                     file gone). When a stale orphan is involved, ``entity``
 *                     is populated so the gate can show details.
 * - `error`         — transient error; `retry()` available
 */
export type EntityResolutionState =
  | 'querying'
  | 'discovering'
  | 'resolved'
  | 'missing_asset'
  | 'error';

export interface UseEntityByPathOptions {
  /**
   * If false, skip the discoverByPath fallback when the exact lookup misses.
   * Defaults to true. Useful for read-only contexts where a transient miss
   * shouldn't trigger a recovery write.
   */
  autoDiscover?: boolean;
}

export interface UseEntityByPathResult<T> {
  /**
   * Resolved entity, OR the stale orphan when ``state === 'missing_asset'``
   * and the exact/discover lookup turned up a row whose backend ``orphan``
   * flag is true. Null when the path resolves to nothing at all.
   */
  entity: T | null;
  isLoading: boolean;
  state: EntityResolutionState;
  error?: Error;
  retry: () => void;
}

/**
 * Sentinel returned from the discover query when the backend reports 404 for
 * the path. Cached as a successful query result so React-Query doesn't loop
 * (would otherwise re-fire on every render via `enabled`).
 */
const NOT_FOUND = Symbol('discover-not-found');
type NotFound = typeof NOT_FOUND;

/**
 * Test-only: seed the session cache with a discover miss for (type, path) —
 * the poisoned state a stale session accumulates when a file appears on disk
 * after discover already 404'd. Keeps the sentinel + query-key shape private.
 */
export function __seedDiscoverMissForTests(
  queryClient: import('@tanstack/react-query').QueryClient,
  type: string,
  path: string,
): void {
  queryClient.setQueryData([`${type}-discover`, type, path], NOT_FOUND);
}

/**
 * Resolve the first-class entity whose `asset_ref` matches `fsRef`.
 *
 * Two-stage lookup:
 *   1. Exact path lookup (cached for 30s) — `dataManager.getEntityByPath`
 *      (`GET /assets/entity?path=...`, backed by `Entity.get_by_asset_ref`):
 *      a single-row indexed DB lookup, ~ms regardless of corpus size. A file
 *      inside a folder-backed asset (skill etc.) resolves to its owning
 *      entity via the backend's containing-folder fallback. NEVER replace
 *      this with a bulk type list — listing the whole type (the previous
 *      implementation) shipped the entire corpus (3.3MB / 3-5s at ~3k docs)
 *      on every doc open just to `.find()` one row.
 *   2. discoverByPath fallback — when the exact lookup misses (file just
 *      created, or skipped by an earlier scan), POST
 *      `/fs-records/{type}/discover?path=...` to find-or-recover the single
 *      record. The backend returns the entity row or 404; we treat 404 as
 *      terminal `missing_asset` (cached so we don't loop) and other failures
 *      as transient `error` (retryable).
 *
 * Orphan handling: when a matched / discovered entity has ``orphan === true``,
 * this hook drops it from the resolved-render path and reports
 * ``missing_asset`` instead, while still surfacing the stale entity through
 * ``entity`` so the gate's card can show id / orphan_since.
 *
 * Used by the asset editors to bind chat / per-entity affordances to the real
 * entity TypeId instead of a path-keyed pseudo. Skill entities key on the
 * folder path; pass the folder FSRef in that case.
 *
 * Type scoping: `/assets/entity` is cross-type (asset_ref is globally
 * unique). The result is accepted only when its `type` equals the requested
 * `entityType` — a mismatch is treated as a stage-1 miss so the type-scoped
 * discover fallback keeps the old per-type semantics.
 *
 * Backwards compatible: `{ entity, isLoading }` is a strict subset of the
 * returned shape, so existing callers that destructure those two fields keep
 * working unchanged.
 */
export function useEntityByPath<T extends APIEntity<T>>(
  entityType: string | null | undefined,
  fsRef: FSRef | null,
  options?: UseEntityByPathOptions,
): UseEntityByPathResult<T> {
  const type = entityType ?? '';
  const path = fsRef?.path ?? '';
  const enabled = !!type && !!fsRef;
  const autoDiscover = options?.autoDiscover !== false;
  const queryClient = useQueryClient();

  const exactKey = useMemo(() => [`${type}-by-path`, type, path] as const, [type, path]);
  const discoverKey = useMemo(() => [`${type}-discover`, type, path] as const, [type, path]);

  const {
    data: exactMatch = null,
    isLoading: exactLoading,
    isFetching: exactFetching,
    error: exactError,
  } = useQuery<T | null>({
    queryKey: exactKey,
    queryFn: async () => {
      // `getEntityByPath` normalizes to the machine-absolute `asset_ref` form
      // (call sites pass `fsRef.path` with and without the leading slash),
      // hydrates through the cache-deduping path (`updateEntityFromJson`),
      // and resolves to null on any failure — a miss here just hands over to
      // the discover stage.
      const inst = (await dataManager.getEntityByPath(path)) as T | null;
      if (!inst) return null;
      // Cross-type endpoint, type-scoped hook: reject a hit of another type so
      // the type-scoped discover fallback keeps the old per-type semantics.
      return (inst as { type?: string }).type === type ? inst : null;
    },
    enabled,
    staleTime: 30_000,
  });

  // Exact lookup has settled (not loading anymore) and we still don't have a match — fire discover.
  const exactSettled = enabled && !exactLoading;
  // Treat an orphan match the same as "no match" for discover-eligibility:
  // the file is gone, so discoverByPath would 404 anyway. Skip the round-trip.
  const exactMatchIsOrphan = !!(exactMatch && (exactMatch as { orphan?: boolean }).orphan === true);
  // NB: intentionally NOT gated on ``!exactError`` — if the exact lookup
  // errored, the single-file discover is exactly the recovery path, so it
  // must still run.
  const shouldDiscover =
    enabled && autoDiscover && exactSettled && !exactMatch;

  const {
    data: discoverData,
    isLoading: discoverLoading,
    isFetching: discoverFetching,
    error: discoverError,
  } = useQuery<T | NotFound>({
    queryKey: discoverKey,
    queryFn: async () => {
      try {
        const row = await systemTools.discoverByPath(type, path);
        if (!row) return NOT_FOUND;
        const rowWithType = row as Record<string, unknown> & { type?: string };
        if (!rowWithType.type) rowWithType.type = type;
        const inst = dataManager.updateEntityFromJson<T>(rowWithType as never) as T | undefined;
        return inst ?? NOT_FOUND;
      } catch (err: unknown) {
        // apiClient (axios) throws AxiosError; status lives at error.response.status.
        // Treat 404 as terminal `missing_asset` (cache it so we don't loop on
        // every render). All other statuses bubble as transient `error`.
        const status = (err as { response?: { status?: number }; status?: number })?.response?.status
          ?? (err as { status?: number })?.status;
        if (status === 404) return NOT_FOUND;
        throw err as Error;
      }
    },
    enabled: shouldDiscover,
    staleTime: Infinity, // missing-asset result is path-stable; only retry() should refetch
    retry: false,
  });

  const discoverEntity = discoverData && discoverData !== NOT_FOUND ? (discoverData as T) : null;
  const discoverNotFound = discoverData === NOT_FOUND;
  const discoverEntityIsOrphan =
    !!(discoverEntity && (discoverEntity as { orphan?: boolean }).orphan === true);

  const retry = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: exactKey });
    void queryClient.invalidateQueries({ queryKey: discoverKey });
  }, [queryClient, exactKey, discoverKey]);

  // "Load on open" semantics: opening an asset must always (re-)attempt the
  // backend discover — the endpoint that scans the file, creates the doc
  // record, and indexes it — when the doc isn't already resolved. A NOT_FOUND
  // cached earlier in the session (``staleTime: Infinity``) would otherwise
  // permanently mask a file that has since appeared on disk (e.g. written by
  // an agent — no WS entity op ever fires for it, so the self-heal below
  // never triggers). Dropping the cached miss when a consumer mounts for this
  // path makes the discover re-run exactly once per open; a still-missing
  // file just re-caches NOT_FOUND for the lifetime of that mount (no loop).
  useEffect(() => {
    if (!enabled || !autoDiscover) return;
    if (queryClient.getQueryData(discoverKey) === NOT_FOUND) {
      queryClient.removeQueries({ queryKey: discoverKey });
    }
    // Run once per path-key mount — NOT on data changes, so a fresh NOT_FOUND
    // produced by this very re-run is kept, not dropped again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, autoDiscover, queryClient, discoverKey]);

  // Self-heal when a matching entity row arrives over the WS after we
  // already settled on ``missing_asset``. The discover query caches
  // NOT_FOUND with ``staleTime: Infinity`` so it never re-fires on its
  // own; we invalidate both the exact lookup and the path-keyed discover
  // result so the next render re-runs the lookup and finds the freshly
  // indexed row. Filter by ``type`` first to avoid invalidating on
  // unrelated entity ops.
  const onEntityOp = useCallback(
    (_typeId: unknown, op: unknown, _data: unknown) => {
      if (op !== 'create' && op !== 'update') return;
      void queryClient.invalidateQueries({ queryKey: exactKey });
      void queryClient.invalidateQueries({ queryKey: discoverKey });
    },
    [queryClient, exactKey, discoverKey],
  );
  const subscribedTypes = useMemo(() => (enabled ? [type] : []), [enabled, type]);
  useEntityOps(subscribedTypes, onEntityOp as never);

  // Derive resolution state.
  const state: EntityResolutionState = useMemo(() => {
    if (!enabled) return 'querying';
    // Orphan-bearing matches drop OUT of the resolved path — render-level
    // missing_asset surface, not the editor.
    if (exactMatch && !exactMatchIsOrphan) return 'resolved';
    if (discoverEntity && !discoverEntityIsOrphan) return 'resolved';
    if (exactMatchIsOrphan) return 'missing_asset';
    if (exactLoading || exactFetching) return 'querying';
    if (exactError) return 'error';
    if (discoverNotFound) return 'missing_asset';
    if (discoverEntityIsOrphan) return 'missing_asset';
    if (discoverError) return 'error';
    if (shouldDiscover && (discoverLoading || discoverFetching)) return 'discovering';
    if (shouldDiscover) return 'discovering';
    // autoDiscover disabled and exact lookup missed → terminal missing_asset
    if (!autoDiscover && exactSettled && !exactMatch) return 'missing_asset';
    return 'querying';
  }, [
    enabled,
    exactMatch,
    exactMatchIsOrphan,
    discoverEntity,
    discoverEntityIsOrphan,
    exactLoading,
    exactFetching,
    exactError,
    discoverNotFound,
    discoverError,
    discoverLoading,
    discoverFetching,
    shouldDiscover,
    autoDiscover,
    exactSettled,
  ]);

  // ``entity`` semantics:
  //   - resolved      → the live entity
  //   - missing_asset → the stale orphan (if any) so the gate can show id /
  //                     orphan_since; null when nothing was ever found
  //   - else          → null
  const resolvedEntity = exactMatch && !exactMatchIsOrphan
    ? exactMatch
    : discoverEntity && !discoverEntityIsOrphan
      ? discoverEntity
      : null;
  const orphanEntity = exactMatchIsOrphan
    ? exactMatch
    : discoverEntityIsOrphan
      ? discoverEntity
      : null;
  const entity = state === 'missing_asset' ? orphanEntity : resolvedEntity;
  const isLoading = state === 'querying' || state === 'discovering';
  const error = (exactError ?? discoverError) as Error | undefined;

  return { entity, isLoading, state, error, retry };
}
