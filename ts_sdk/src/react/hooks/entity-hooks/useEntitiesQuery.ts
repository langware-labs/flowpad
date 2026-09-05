import { useLazyAsset } from '../useLazyAsset';
import { LazyAsset } from '../../../lazy/LazyAsset';
import { APIEntity, ApiError, dataManager, QueryRequest } from '@sdk';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { UseEntitiesQueryResult } from './types';

const collections: Partial<Record<string, LazyAsset.Projects | LazyAsset.Bookmarks | LazyAsset.RagIndexes>> = {
  project: LazyAsset.Projects, bookmark: LazyAsset.Bookmarks, rag_index: LazyAsset.RagIndexes,
};

/** Shared unscoped collections use the registry; arbitrary entity queries retain their own lifecycle. */
export function useEntitiesQuery<T extends APIEntity<T>>(
  request: QueryRequest, options?: { enabled?: boolean; priority?: 'demand' | 'background' },
): UseEntitiesQueryResult<T> {
  const asset = !request.query && !request.scope?.filter(Boolean).length ? collections[request.type] : undefined;
  const shared = useLazyAsset(asset ?? LazyAsset.Projects, undefined, {
    subscribed: !!asset, enabled: !!asset && options?.enabled !== false, priority: options?.priority ?? 'background',
  });
  const watched = useWatchedEntitiesQuery<T>(request, { enabled: !asset && options?.enabled !== false });
  if (!asset) return watched;
  return { data: shared.data as T[] | undefined, isLoading: shared.isLoading, error: shared.error as ApiError | null,
    isError: shared.isError, isSuccess: shared.isSuccess, refetch: async () => { await shared.reload(); } };
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
  };
  // Seed state from the in-memory query cache so a remount (e.g. reopening the
  // inbox, which fully unmounts/remounts its view) renders the already-known rows
  // on the first frame instead of flashing an empty ``undefined``/loading state.
  // ``getCachedQueryResults`` is a synchronous keyed read; a miss (cold load)
  // yields the loading state, so cold starts are unchanged. Reused on resubscribe.
  const seedState = (): QueryState => {
    const cached = enabled ? dataManager.getCachedQueryResults<T>(request) : undefined;
    if (cached) {
      // New array ref (matches the watch-callback / refetch convention below) so
      // React reliably detects the change.
      return { data: [...cached], isLoading: false, error: null, isError: false, isSuccess: true };
    }
    return { data: undefined, isLoading: enabled, error: null, isError: false, isSuccess: false };
  };
  // Lazy one-time seed: useRef evaluates its argument on EVERY render, so the
  // cache read + array clone must not live in the initializer. Start from a cheap
  // loading literal and replace it with the real seed exactly once.
  const stateRef = useRef<QueryState>({ data: undefined, isLoading: enabled, error: null, isError: false, isSuccess: false });
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
          const newData = [...(updatedEntities as T[])];

          stateRef.current = {
            data: newData, // Always a new array reference
            isLoading: false,
            error: null,
            isError: false,
            isSuccess: true,
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
      snapshotRef.current.isSuccess !== current.isSuccess
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
      // Pass invalidate: true to force fresh data from API instead of cache
      const results = await dataManager.query<T>(request, true);
      // Always create a new array reference
      stateRef.current = {
        data: [...results],
        isLoading: false,
        error: null,
        isError: false,
        isSuccess: true,
      };
    } catch (err) {
      stateRef.current = {
        data: undefined,
        isLoading: false,
        error: err as ApiError,
        isError: true,
        isSuccess: false,
      };
    }
    notifyRef.current?.(); // Trigger re-render with results
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, request.type, queryJsonStringified, scopeJsonStringified, request.name]);

  return {
    ...state,
    refetch,
  };
}
