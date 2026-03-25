import { APIEntity, ApiError, dataManager, QueryRequest } from '@sdk';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { UseEntitiesQueryResult } from './types';

/**
 * Hook for querying multiple entities with real-time subscription updates
 * Uses useSyncExternalStore for direct integration with DataManager
 * @param request - Query request with type, query filters, and scope
 * @param options - Optional configuration including enabled flag
 * @returns Query result with data, loading state, error state, and refetch function
 */
export function useEntitiesQuery<T extends APIEntity<T>>(
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
  const stateRef = useRef<{
    data: T[] | undefined;
    isLoading: boolean;
    error: ApiError | null;
    isError: boolean;
    isSuccess: boolean;
  }>({
    data: undefined,
    isLoading: enabled,
    error: null,
    isError: false,
    isSuccess: false,
  });

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

      // IMPORTANT: Set loading state immediately when subscribing
      // This ensures that when request changes, we show loading state right away
      // instead of showing stale data from the previous request
      stateRef.current = {
        data: undefined,
        isLoading: true,
        error: null,
        isError: false,
        isSuccess: false,
      };
      callback(); // Trigger re-render immediately with loading state

      let unsubscribe: (() => void) | undefined;

      const watchRequest = new QueryRequest({
        type: request.type,
        query: request.query,
        scope: request.scope?.filter((s) => s != null) || [],
        callback: (updatedEntities) => {
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
          unsubscribe = unsub;
        })
        .catch((err) => {
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
