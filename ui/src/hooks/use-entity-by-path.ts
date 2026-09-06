import { APIEntity, FSRef, TypeId, dataManager, systemTools } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

/**
 * Discriminator for entity-by-path resolution lifecycle.
 *
 * - `querying`      — exact path lookup in flight (initial load)
 * - `discovering`   — exact-lookup miss → calling `systemTools.resolveByPath`
 * - `resolved`      — entity available
 * - `missing_asset` — terminal: either 404 from resolveByPath (the path is not
 *                     an asset on disk) OR the matched entity is flagged
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
   * If false, skip the resolveByPath fallback when the exact lookup misses.
   * Defaults to true. Useful for read-only contexts where a transient miss
   * shouldn't trigger a recovery write.
   */
  autoDiscover?: boolean;
}

export interface UseEntityByPathResult<T> {
  /**
   * Resolved entity, OR the stale orphan when ``state === 'missing_asset'``
   * and the exact/resolve lookup turned up a row whose backend ``orphan``
   * flag is true. Null when the path resolves to nothing at all.
   */
  entity: T | null;
  isLoading: boolean;
  state: EntityResolutionState;
  error?: Error;
  retry: () => void;
  /** The record type the BACKEND named for this path (null until resolved). */
  resolvedType: string | null;
}

/**
 * Sentinel returned from the resolve query when the backend reports 404 for
 * the path. Cached as a successful query result so React-Query doesn't loop
 * (would otherwise re-fire on every render via `enabled`).
 */
const NOT_FOUND = Symbol('resolve-not-found');
type NotFound = typeof NOT_FOUND;

/** Both lookups are keyed by the PATH alone — the type is the backend's answer,
 *  not part of the question, so two consumers of one path share one request. */
const exactKeyFor = (path: string) => ['entity-by-path', path] as const;
const resolveKeyFor = (path: string) => ['asset-resolve', path] as const;

/**
 * Test-only: seed the session cache with a resolve miss for `path` — the
 * poisoned state a stale session accumulates when a file appears on disk after
 * resolve already 404'd. Keeps the sentinel + query-key shape private. The
 * `type` argument is accepted for call-site compatibility and ignored: the
 * cache is path-keyed.
 */
export function __seedDiscoverMissForTests(
  queryClient: import('@tanstack/react-query').QueryClient,
  _type: string | null | undefined,
  path: string,
): void {
  queryClient.setQueryData(resolveKeyFor(path), NOT_FOUND);
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
 *   2. resolveByPath fallback — when the exact lookup misses (file just
 *      created, or skipped by an earlier scan), `GET /assets/resolve?path=…`
 *      classifies the path: the BACKEND names the record type and id (and
 *      the row when it has one). A 404 means the path is not an asset and is
 *      terminal `missing_asset` (cached so we don't loop); other failures
 *      are transient `error` (retryable).
 *
 * The client never decides a record type from a path. `typeHint` is only a
 * hint: when it is given and the backend answers with a different type, the
 * mismatch is reported (console) and the backend's answer still wins — the
 * entity is keyed by the RETURNED type/id.
 *
 * Orphan handling: when a matched / resolved entity has ``orphan === true``,
 * this hook drops it from the resolved-render path and reports
 * ``missing_asset`` instead, while still surfacing the stale entity through
 * ``entity`` so the gate's card can show id / orphan_since.
 *
 * Used by the asset editors to bind chat / per-entity affordances to the real
 * entity TypeId instead of a path-keyed pseudo. Skill entities key on the
 * folder path; pass the folder FSRef in that case.
 *
 * Backwards compatible: `{ entity, isLoading }` is a strict subset of the
 * returned shape, so existing callers that destructure those two fields keep
 * working unchanged.
 */
export function useEntityByPath<T extends APIEntity<T>>(
  typeHint: string | null | undefined,
  fsRef: FSRef | null,
  options?: UseEntityByPathOptions,
): UseEntityByPathResult<T> {
  const hint = typeHint || null;
  const path = fsRef?.path ?? '';
  const enabled = !!fsRef && !!path;
  const autoDiscover = options?.autoDiscover !== false;
  const queryClient = useQueryClient();

  const exactKey = useMemo(() => exactKeyFor(path), [path]);
  const resolveKey = useMemo(() => resolveKeyFor(path), [path]);

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
      // the resolve stage.
      return (await dataManager.getEntityByPath<T>(path)) ?? null;
    },
    enabled,
    staleTime: 30_000,
  });

  // Exact lookup has settled (not loading anymore) and we still don't have a match — fire resolve.
  const exactSettled = enabled && !exactLoading;
  // Treat an orphan match the same as "no match" for resolve-eligibility:
  // the file is gone, so resolveByPath would 404 anyway. Skip the round-trip.
  const exactMatchIsOrphan = !!(exactMatch && (exactMatch as { orphan?: boolean }).orphan === true);
  // NB: intentionally NOT gated on ``!exactError`` — if the exact lookup
  // errored, the single-path resolve is exactly the recovery path, so it
  // must still run.
  const shouldResolve = enabled && autoDiscover && exactSettled && !exactMatch;

  const {
    data: resolveData,
    isLoading: resolveLoading,
    isFetching: resolveFetching,
    error: resolveError,
  } = useQuery<T | NotFound>({
    queryKey: resolveKey,
    queryFn: async () => {
      // `resolveByPath` maps a 404 to null; anything else throws and bubbles
      // as a transient `error`.
      const resolved = await systemTools.resolveByPath(path);
      if (!resolved) return NOT_FOUND;
      if (resolved.entity) {
        const row = { ...resolved.entity, type: resolved.type, id: resolved.id };
        const inst = dataManager.updateEntityFromJson<T>(row as never) as T | undefined;
        if (inst) return inst;
      }
      // Classified but not hydrated: fetch the row by the id the backend named.
      const inst = await dataManager.getByTypeId<T>(new TypeId(resolved.type, resolved.id));
      return inst ?? NOT_FOUND;
    },
    enabled: shouldResolve,
    staleTime: Infinity, // missing-asset result is path-stable; only retry() should refetch
    retry: false,
  });

  const resolvedEntityRaw = resolveData && resolveData !== NOT_FOUND ? (resolveData as T) : null;
  const resolveNotFound = resolveData === NOT_FOUND;
  const resolvedEntityIsOrphan =
    !!(resolvedEntityRaw && (resolvedEntityRaw as { orphan?: boolean }).orphan === true);

  const retry = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: exactKey });
    void queryClient.invalidateQueries({ queryKey: resolveKey });
  }, [queryClient, exactKey, resolveKey]);

  // "Load on open" semantics: opening an asset must always (re-)attempt the
  // backend resolve — the call that classifies the path, creates the record,
  // and indexes it — when the doc isn't already resolved. A NOT_FOUND cached
  // earlier in the session (``staleTime: Infinity``) would otherwise
  // permanently mask a file that has since appeared on disk (e.g. written by
  // an agent — no WS entity op ever fires for it, so the self-heal below
  // never triggers). Dropping the cached miss when a consumer mounts for this
  // path makes the resolve re-run exactly once per open; a still-missing
  // file just re-caches NOT_FOUND for the lifetime of that mount (no loop).
  useEffect(() => {
    if (!enabled || !autoDiscover) return;
    if (queryClient.getQueryData(resolveKey) === NOT_FOUND) {
      queryClient.removeQueries({ queryKey: resolveKey });
    }
    // Run once per path-key mount — NOT on data changes, so a fresh NOT_FOUND
    // produced by this very re-run is kept, not dropped again.
  }, [enabled, autoDiscover, queryClient, resolveKey]);

  // The type the backend named — from whichever stage answered.
  const resolvedType =
    ((exactMatch as { type?: string } | null)?.type ??
      (resolvedEntityRaw as { type?: string } | null)?.type) ??
    null;

  // The hint only gates whether a mismatch is REPORTED; it never overrides
  // the backend's classification.
  useEffect(() => {
    if (hint && resolvedType && hint !== resolvedType) {
      console.warn(`[useEntityByPath] type hint '${hint}' disagrees with the backend ('${resolvedType}') for ${path}`);
    }
  }, [hint, resolvedType, path]);

  // Self-heal when a matching entity row arrives over the WS after we
  // already settled on ``missing_asset``. The resolve query caches
  // NOT_FOUND with ``staleTime: Infinity`` so it never re-fires on its
  // own; we invalidate both the exact lookup and the path-keyed resolve
  // result so the next render re-runs the lookup and finds the freshly
  // indexed row. Subscribe on the resolved type when known, else the hint,
  // to avoid invalidating on unrelated entity ops.
  const onEntityOp = useCallback(
    (_typeId: unknown, op: unknown) => {
      if (op !== 'create' && op !== 'update') return;
      void queryClient.invalidateQueries({ queryKey: exactKey });
      void queryClient.invalidateQueries({ queryKey: resolveKey });
    },
    [queryClient, exactKey, resolveKey],
  );
  const subscribedType = resolvedType ?? hint;
  const subscribedTypes = useMemo(
    () => (enabled && subscribedType ? [subscribedType] : []),
    [enabled, subscribedType],
  );
  useEntityOps(subscribedTypes, onEntityOp as never);

  // Derive resolution state.
  const state: EntityResolutionState = useMemo(() => {
    if (!enabled) return 'querying';
    // Orphan-bearing matches drop OUT of the resolved path — render-level
    // missing_asset surface, not the editor.
    if (exactMatch && !exactMatchIsOrphan) return 'resolved';
    if (resolvedEntityRaw && !resolvedEntityIsOrphan) return 'resolved';
    if (exactMatchIsOrphan) return 'missing_asset';
    if (exactLoading || exactFetching) return 'querying';
    if (exactError) return 'error';
    if (resolveNotFound) return 'missing_asset';
    if (resolvedEntityIsOrphan) return 'missing_asset';
    if (resolveError) return 'error';
    if (shouldResolve && (resolveLoading || resolveFetching)) return 'discovering';
    if (shouldResolve) return 'discovering';
    // autoDiscover disabled and exact lookup missed → terminal missing_asset
    if (!autoDiscover && exactSettled && !exactMatch) return 'missing_asset';
    return 'querying';
  }, [
    enabled,
    exactMatch,
    exactMatchIsOrphan,
    resolvedEntityRaw,
    resolvedEntityIsOrphan,
    exactLoading,
    exactFetching,
    exactError,
    resolveNotFound,
    resolveError,
    resolveLoading,
    resolveFetching,
    shouldResolve,
    autoDiscover,
    exactSettled,
  ]);

  // ``entity`` semantics:
  //   - resolved      → the live entity
  //   - missing_asset → the stale orphan (if any) so the gate can show id /
  //                     orphan_since; null when nothing was ever found
  //   - else          → null
  const liveEntity = exactMatch && !exactMatchIsOrphan
    ? exactMatch
    : resolvedEntityRaw && !resolvedEntityIsOrphan
      ? resolvedEntityRaw
      : null;
  const orphanEntity = exactMatchIsOrphan
    ? exactMatch
    : resolvedEntityIsOrphan
      ? resolvedEntityRaw
      : null;
  const entity = state === 'missing_asset' ? orphanEntity : liveEntity;
  const isLoading = state === 'querying' || state === 'discovering';
  const error = (exactError ?? resolveError) as Error | undefined;

  return { entity, isLoading, state, error, retry, resolvedType };
}
