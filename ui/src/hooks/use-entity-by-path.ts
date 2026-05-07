import { APIEntity, FSRef, config, systemTools } from '@sdk';
import { EntityFactory } from '@sdk/schema/factory';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

const stripLeadingSlash = (p: string | undefined | null): string =>
  p ? (p.startsWith('/') ? p.slice(1) : p) : '';

/**
 * Discriminator for entity-by-path resolution lifecycle.
 *
 * - `querying`     — bulk list fetch in flight (initial load)
 * - `discovering`  — bulk miss → calling `systemTools.discoverByPath`
 * - `resolved`     — entity available
 * - `not_found`    — terminal: 404 from discoverByPath (file isn't on disk for this type)
 * - `error`        — transient error; `retry()` available
 */
export type EntityResolutionState =
  | 'querying'
  | 'discovering'
  | 'resolved'
  | 'not_found'
  | 'error';

export interface UseEntityByPathOptions {
  /**
   * If false, skip the discoverByPath fallback when the bulk list misses.
   * Defaults to true. Useful for read-only contexts where a transient miss
   * shouldn't trigger a recovery write.
   */
  autoDiscover?: boolean;
}

export interface UseEntityByPathResult<T> {
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
 * Resolve the first-class entity whose `asset_ref` matches `fsRef`.
 *
 * Two-stage lookup:
 *   1. Bulk list (cached for 30s) — fast path, hits the same data the side-rail
 *      categories use, so an already-listed entity resolves without an extra fetch.
 *   2. discoverByPath fallback — when the bulk list misses (file just created,
 *      or skipped by an earlier scan), POST `/fs-records/{type}/discover?path=...`
 *      to find-or-recover the single record. The backend returns the entity row
 *      or 404; we treat 404 as terminal `not_found` (cached so we don't loop) and
 *      other failures as transient `error` (retryable).
 *
 * Used by the asset editors to bind chat / per-entity affordances to the real
 * entity TypeId instead of a path-keyed pseudo. Skill entities key on the
 * folder path; pass the folder FSRef in that case.
 *
 * Direct fetch with `include_system=true` so SDK-shipped system docs
 * (Welcome, Getting Started, etc.) resolve. The QueryRequest path used by
 * `useEntitiesQuery` doesn't expose that flag — same reason
 * `SkillsCategory.tsx` / `DocsCategory.tsx` bypass it. Raw JSON rows are
 * hydrated through `EntityFactory.createEntity` so callers get a real
 * APIEntity (with `typeId`, type-specific methods like `Skill.doc`).
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

  const bulkKey = useMemo(() => [`${type}-by-path`, type] as const, [type]);
  const discoverKey = useMemo(() => [`${type}-discover`, type, path] as const, [type, path]);

  const {
    data: bulkData = [],
    isLoading: bulkLoading,
    isFetching: bulkFetching,
    error: bulkError,
  } = useQuery<T[]>({
    queryKey: bulkKey,
    queryFn: async () => {
      const url = `${config.SERVER_URL}${config.API_PREFIXES.graph}/${type}?include_system=true&limit=5000`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`failed to fetch ${type}: ${resp.status}`);
      const body = await resp.json();
      const rows = (body.data ?? []) as Array<Record<string, unknown> & { type?: string }>;
      const out: T[] = [];
      for (const row of rows) {
        if (!row.type) row.type = type;
        const inst = EntityFactory.createEntity(row as never) as T | undefined;
        if (inst) out.push(inst);
      }
      return out;
    },
    enabled,
    staleTime: 30_000,
  });

  // Match by asset_ref against the bulk results.
  const bulkMatch = useMemo<T | null>(() => {
    if (!fsRef) return null;
    const needle = stripLeadingSlash(fsRef.path);
    return (
      bulkData.find((e: unknown) => {
        const r = e as { asset_ref?: string };
        const p = stripLeadingSlash(r.asset_ref);
        return p !== '' && p === needle;
      }) ?? null
    );
  }, [bulkData, fsRef]);

  // Bulk has settled (not loading anymore) and we still don't have a match — fire discover.
  const bulkSettled = enabled && !bulkLoading;
  const shouldDiscover = enabled && autoDiscover && bulkSettled && !bulkMatch && !bulkError;

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
        const inst = EntityFactory.createEntity(rowWithType as never) as T | undefined;
        return inst ?? NOT_FOUND;
      } catch (err: unknown) {
        // apiClient (axios) throws AxiosError; status lives at error.response.status.
        // Treat 404 as terminal `not_found` (cache it so we don't loop on every render).
        // All other statuses bubble as transient `error`.
        const status = (err as { response?: { status?: number }; status?: number })?.response?.status
          ?? (err as { status?: number })?.status;
        if (status === 404) return NOT_FOUND;
        throw err as Error;
      }
    },
    enabled: shouldDiscover,
    staleTime: Infinity, // not_found result is path-stable; only retry() should refetch
    retry: false,
  });

  const discoverEntity = discoverData && discoverData !== NOT_FOUND ? (discoverData as T) : null;
  const discoverNotFound = discoverData === NOT_FOUND;

  const retry = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: bulkKey });
    void queryClient.invalidateQueries({ queryKey: discoverKey });
  }, [queryClient, bulkKey, discoverKey]);

  // Derive resolution state.
  const state: EntityResolutionState = useMemo(() => {
    if (!enabled) return 'querying';
    if (bulkMatch || discoverEntity) return 'resolved';
    if (bulkLoading || bulkFetching) return 'querying';
    if (bulkError) return 'error';
    if (discoverNotFound) return 'not_found';
    if (discoverError) return 'error';
    if (shouldDiscover && (discoverLoading || discoverFetching)) return 'discovering';
    if (shouldDiscover) return 'discovering';
    // autoDiscover disabled and bulk missed → terminal not_found
    if (!autoDiscover && bulkSettled && !bulkMatch) return 'not_found';
    return 'querying';
  }, [
    enabled,
    bulkMatch,
    discoverEntity,
    bulkLoading,
    bulkFetching,
    bulkError,
    discoverNotFound,
    discoverError,
    discoverLoading,
    discoverFetching,
    shouldDiscover,
    autoDiscover,
    bulkSettled,
  ]);

  const entity = bulkMatch ?? discoverEntity;
  const isLoading = state === 'querying' || state === 'discovering';
  const error = (bulkError ?? discoverError) as Error | undefined;

  return { entity, isLoading, state, error, retry };
}
