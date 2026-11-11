import { useLazyAsset } from '../useLazyAsset';
import { LazyAsset } from '../../../lazy/LazyAsset';
import { APIEntity, dataManager } from '../../../APIEntity';
import { ApiError } from '../../../ApiResponse';
import { QueryFilter, QueryRequest } from '../../../FlowSync/query';
import { ListPage, pageOf } from '../../../client';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { UseEntitiesQueryResult } from './types';

const collections: Partial<Record<string, LazyAsset.Projects | LazyAsset.Bookmarks | LazyAsset.RagIndexes>> = {
  project: LazyAsset.Projects,
  bookmark: LazyAsset.Bookmarks,
  rag_index: LazyAsset.RagIndexes,
};

/**
 * The pages `loadMore` appended past a live query's first page, by the base request's key — so a
 * remount of the same list keeps what was loaded. The first page stays the live watched query; these
 * are the rows after it and where the next page starts.
 */
const loadedPages = new Map<string, { rows: unknown[]; page: ListPage }>();

function baseKey(request: QueryRequest): string {
  const scope = JSON.stringify(request.scope?.filter((s) => s != null).map((s) => s.toString()) ?? []);
  return `${request.type}:${JSON.stringify(request.query || {})}:${scope}`;
}

/** The first page, then the loaded pages' rows it does not already hold. */
function joinPages<T>(first: T[], more: unknown[] | undefined): T[] {
  if (!more?.length) return [...first];
  const held = new Set(first.map((row: any) => row?.typeId?.toString?.() ?? row));
  return [...first, ...(more as T[]).filter((row: any) => !held.has(row?.typeId?.toString?.() ?? row))];
}

/** Shared unscoped collections use the registry; arbitrary entity queries retain their own lifecycle. */
export function useEntitiesQuery<T extends APIEntity<T>>(
  request: QueryRequest,
  options?: { enabled?: boolean; priority?: 'demand' | 'background' },
): UseEntitiesQueryResult<T> {
  const asset = !request.query && !request.scope?.filter(Boolean).length ? collections[request.type] : undefined;
  const shared = useLazyAsset(asset ?? LazyAsset.Projects, undefined, {
    subscribed: !!asset,
    enabled: !!asset && options?.enabled !== false,
    priority: options?.priority ?? 'background',
  });
  const watched = useWatchedEntitiesQuery<T>(request, { enabled: !asset && options?.enabled !== false });
  if (!asset) return watched;
  return {
    data: shared.data as T[] | undefined,
    isLoading: shared.isLoading,
    error: shared.error as ApiError | null,
    isError: shared.isError,
    isSuccess: shared.isSuccess,
    refetch: async () => {
      await shared.reload();
    },
  };
}

/**
 * Hook for querying multiple entities with real-time subscription updates
 * Uses useSyncExternalStore for direct integration with DataManager
 * @param request - Query request with type, query filters, and scope
 * @param options - Optional configuration including enabled flag
 * @returns Query result with data, loading state, error state, and refetch function
 */
function useWatchedEntitiesQuery<T extends APIEntity<T>>(
  request: QueryRequest,
  options?: {
    enabled?: boolean;
  },
): UseEntitiesQueryResult<T> {
  const enabled = options?.enabled !== false;

  // Stringify query and scope to use as stable dependencies (same as legacy version)
  // This prevents infinite re-subscriptions when QueryRequest objects are recreated with same content
  const queryJsonStringified = JSON.stringify(request.query);
  const scopeJsonStringified = JSON.stringify(request.scope?.filter((s) => s != null).map((s) => s.toString()) ?? []);

  // State refs to track query state
  type QueryState = {
    data: T[] | undefined;
    isLoading: boolean;
    error: ApiError | null;
    isError: boolean;
    isSuccess: boolean;
    hasMore: boolean;
    isLoadingMore: boolean;
  };
  const key = baseKey(request);
  /** Whether more rows are past what is shown: the last loaded page's answer, else the first page's. */
  const hasMoreFor = (req: QueryRequest): boolean =>
    loadedPages.get(key)?.page.has_more ?? dataManager.getQueryPage(req)?.has_more ?? false;
  // Seed state from the in-memory query cache so a remount (e.g. reopening the
  // stream inbox, which fully unmounts/remounts its view) renders the already-known rows
  // on the first frame instead of flashing an empty ``undefined``/loading state.
  // ``getCachedQueryResults`` is a synchronous keyed read; a miss (cold load)
  // yields the loading state, so cold starts are unchanged. Reused on resubscribe.
  const seedState = (): QueryState => {
    const cached = enabled ? dataManager.getCachedQueryResults<T>(request) : undefined;
    if (cached) {
      // New array ref (matches the watch-callback / refetch convention below) so
      // React reliably detects the change.
      return {
        data: joinPages(cached, loadedPages.get(key)?.rows),
        isLoading: false,
        error: null,
        isError: false,
        isSuccess: true,
        hasMore: hasMoreFor(request),
        isLoadingMore: false,
      };
    }
    return {
      data: undefined,
      isLoading: enabled,
      error: null,
      isError: false,
      isSuccess: false,
      hasMore: false,
      isLoadingMore: false,
    };
  };
  // Lazy one-time seed: useRef evaluates its argument on EVERY render, so the
  // cache read + array clone must not live in the initializer. Start from a cheap
  // loading literal and replace it with the real seed exactly once.
  const stateRef = useRef<QueryState>({
    data: undefined,
    isLoading: enabled,
    error: null,
    isError: false,
    isSuccess: false,
    hasMore: false,
    isLoadingMore: false,
  });
  const seededRef = useRef(false);
  if (!seededRef.current) {
    seededRef.current = true;
    stateRef.current = seedState();
  }

  // Cache the snapshot to prevent unnecessary re-renders
  const snapshotRef = useRef(stateRef.current);

  // Store the subscribe callback so refetch can trigger re-renders
  const notifyRef = useRef<(() => void) | null>(null);

  // Subscribe function for useSyncExternalStore
  // DataManager.watchQuery handles both initial fetch and subsequent updates via the callback
  const subscribe = useCallback(
    (callback: () => void) => {
      // Store callback for refetch to use
      notifyRef.current = callback;

      if (!enabled) {
        // When disabled, immediately set to non-loading empty state
        stateRef.current = {
          data: undefined,
          isLoading: false,
          error: null,
          isError: false,
          isSuccess: false,
          hasMore: false,
          isLoadingMore: false,
        };
        return () => {
          notifyRef.current = null;
        };
      }

      // On (re)subscribe, seed from THIS request's cache (see seedState above)
      // rather than blanking to ``undefined``/loading. On a request change this
      // reads the new request's cache — never the stale previous request's data,
      // the original reason this reset existed — and on a warm remount it keeps
      // the known rows on screen instead of flashing the empty loading state.
      stateRef.current = seedState();
      callback(); // Trigger re-render immediately with the seeded state

      let unsubscribe: (() => void) | undefined;
      let disposed = false;

      const watchRequest = new QueryRequest({
        type: request.type,
        query: request.query,
        scope: request.scope?.filter((s) => s != null) || [],
        callback: (updatedEntities) => {
          if (disposed) return;
          // Always create a new array reference for predictable React re-rendering
          // This ensures dependency arrays like useEffect(() => {}, [data]) always detect changes
          const newData = joinPages(updatedEntities as T[], loadedPages.get(key)?.rows);

          stateRef.current = {
            data: newData, // Always a new array reference
            isLoading: false,
            error: null,
            isError: false,
            isSuccess: true,
            hasMore: hasMoreFor(watchRequest),
            isLoadingMore: stateRef.current.isLoadingMore,
          };
          callback(); // Trigger re-render with data
        },
        name: request.name,
      });

      // watchQuery fetches data and calls the callback, then watches for changes
      dataManager
        .watchQuery<T>(watchRequest)
        .then((unsub) => {
          if (disposed) unsub();
          else unsubscribe = unsub;
        })
        .catch((err) => {
          if (disposed) return;
          // Handle errors from watchQuery setup
          stateRef.current = {
            data: undefined,
            isLoading: false,
            error: err as ApiError,
            isError: true,
            isSuccess: false,
            hasMore: false,
            isLoadingMore: false,
          };
          callback(); // Trigger re-render to show error
        });

      return () => {
        disposed = true;
        notifyRef.current = null;
        if (unsubscribe) {
          unsubscribe();
        }
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, request.type, queryJsonStringified, scopeJsonStringified, request.name],
  );

  // Snapshot function for useSyncExternalStore
  const getSnapshot = useCallback(() => {
    const current = stateRef.current;

    // Only create new snapshot if something changed
    if (
      snapshotRef.current.data !== current.data ||
      snapshotRef.current.isLoading !== current.isLoading ||
      snapshotRef.current.error !== current.error ||
      snapshotRef.current.isError !== current.isError ||
      snapshotRef.current.isSuccess !== current.isSuccess ||
      snapshotRef.current.hasMore !== current.hasMore ||
      snapshotRef.current.isLoadingMore !== current.isLoadingMore
    ) {
      snapshotRef.current = { ...current };
    }

    return snapshotRef.current;
  }, []);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Refetch function for manual data refresh
  const refetch = useCallback(async () => {
    if (!enabled) return;

    stateRef.current = { ...stateRef.current, isLoading: true, error: null, isError: false };
    notifyRef.current?.(); // Trigger re-render with loading state

    try {
      // A refetch starts the list over from its first page.
      loadedPages.delete(key);
      // Pass invalidate: true to force fresh data from API instead of cache
      const results = await dataManager.query<T>(request, true);
      // Always create a new array reference
      stateRef.current = {
        data: [...results],
        isLoading: false,
        error: null,
        isError: false,
        isSuccess: true,
        hasMore: pageOf(results)?.has_more ?? false,
        isLoadingMore: false,
      };
    } catch (err) {
      stateRef.current = {
        data: undefined,
        isLoading: false,
        error: err as ApiError,
        isError: true,
        isSuccess: false,
        hasMore: false,
        isLoadingMore: false,
      };
    }
    notifyRef.current?.(); // Trigger re-render with results
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, request.type, queryJsonStringified, scopeJsonStringified, request.name]);

  // The next page: the base request again right after the last page (its `next_cursor`, as `after`), else
  // at the server's `next_offset` — its rows appended.
  const loadMore = useCallback(async () => {
    if (!enabled || !request.query || stateRef.current.isLoadingMore) return;
    const scope = request.scope?.filter((s) => s != null) || [];
    const base = new QueryRequest({ type: request.type, query: request.query, scope });
    const loaded = loadedPages.get(key);
    const page = loaded?.page ?? dataManager.getQueryPage(base);
    if (!page?.has_more) return;
    stateRef.current = { ...stateRef.current, isLoadingMore: true };
    notifyRef.current?.();
    try {
      const cursor = page.next_cursor || undefined;
      const next = new QueryRequest({
        type: request.type,
        query: new QueryFilter(
          cursor
            ? { ...request.query, offset: undefined, after: cursor }
            : { ...request.query, offset: page.next_offset },
        ),
        scope,
      });
      const rows = await dataManager.query<T>(next, true);
      let nextPage = pageOf(rows) ?? { has_more: false, next_offset: page.next_offset + rows.length };
      if (cursor && nextPage.has_more && !nextPage.next_cursor) {
        // A cursor page's `next_offset` counts from its cursor, not the top: there is no way to go on.
        console.warn(`[useEntitiesQuery] ${request.type}: a cursor page ended without a next_cursor`);
        nextPage = { ...nextPage, has_more: false };
      }
      loadedPages.set(key, { rows: [...(loaded?.rows ?? []), ...rows], page: nextPage });
      const first = dataManager.getCachedQueryResults<T>(base) ?? [];
      stateRef.current = {
        ...stateRef.current,
        data: joinPages(first, loadedPages.get(key)?.rows),
        hasMore: nextPage.has_more,
        isLoadingMore: false,
      };
    } catch (err) {
      stateRef.current = { ...stateRef.current, isLoadingMore: false, error: err as ApiError, isError: true };
    }
    notifyRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  return {
    ...state,
    refetch,
    loadMore,
  };
}
