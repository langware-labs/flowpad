import { APIEntity, ApiError, dataManager, TypeId } from '@sdk';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useEntityOptions, UseEntityResult } from './types';
import { useWatch } from './useWatch';

export function useEntity<T extends APIEntity<T>>(
  typeId: TypeId | null,
  options?: useEntityOptions<T>,
): UseEntityResult<T> {
  const { watch, query, enabled = true } = options || {};
  const queryJsonStringified = JSON.stringify(query);

  // State refs to track query state
  const stateRef = useRef<{
    data: T | null | undefined;
    isLoading: boolean;
    isFetching: boolean;
    error: ApiError | null;
    isError: boolean;
    isSuccess: boolean;
  }>({
    data: typeId && enabled ? undefined : null,
    isLoading: !!(typeId && enabled),
    isFetching: false,
    error: null,
    isError: false,
    isSuccess: false,
  });

  // Cache the snapshot to prevent unnecessary re-renders
  const snapshotRef = useRef(stateRef.current);

  // Ref to the useSyncExternalStore notify callback so refetch() can trigger re-renders
  const notifyRef = useRef<(() => void) | null>(null);

  // Subscribe function for useSyncExternalStore
  const subscribe = useCallback(
    (callback: () => void) => {
      notifyRef.current = callback;
      if (!typeId || !enabled) {
        // When disabled or no typeId, immediately set to non-loading null state
        stateRef.current = {
          data: null,
          isLoading: false,
          isFetching: false,
          error: null,
          isError: false,
          isSuccess: false,
        };
        callback();
        return () => {};
      }

      // Set loading state immediately when subscribing
      stateRef.current = {
        data: undefined,
        isLoading: true,
        isFetching: true,
        error: null,
        isError: false,
        isSuccess: false,
      };
      callback(); // Trigger re-render immediately with loading state

      let unsubscribe: (() => void) | undefined;

      // Async initialization
      const initialize = async () => {
        try {
          // Check cache first to avoid unnecessary API calls
          const cachedEntity = dataManager.getByTypeIdFromCache<T>(typeId);
          if (cachedEntity) {
            stateRef.current = {
              data: cachedEntity,
              isLoading: false,
              isFetching: false,
              error: null,
              isError: false,
              isSuccess: true,
            };
            callback();
          } else {
            // Only fetch from API if not in cache
            const entity = await dataManager.getByTypeId<T>(typeId, query);
            stateRef.current = {
              data: entity,
              isLoading: false,
              isFetching: false,
              error: null,
              isError: false,
              isSuccess: true,
            };
            callback();
          }

          // Subscribe to updates from data manager
          unsubscribe = dataManager.subscribe<T>(typeId, (updatedEntity) => {
            stateRef.current = {
              data: updatedEntity,
              isLoading: false,
              isFetching: false,
              error: null,
              isError: false,
              isSuccess: true,
            };
            // Force snapshot update since entity object reference doesn't change
            snapshotRef.current = { ...stateRef.current };
            callback(); // Trigger re-render with updated data
          });
        } catch (err) {
          console.error('useEntity.ts: Error fetching entity by type ID:', typeId, err);
          stateRef.current = {
            data: null,
            isLoading: false,
            isFetching: false,
            error: err as ApiError,
            isError: true,
            isSuccess: false,
          };
          callback(); // Trigger re-render to show error
        }
      };

      void initialize();

      return () => {
        if (unsubscribe) {
          unsubscribe();
        }
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, typeId?.type, typeId?.id, queryJsonStringified],
  );

  // Snapshot function for useSyncExternalStore
  const getSnapshot = useCallback(() => {
    const current = stateRef.current;

    // Only create new snapshot if something changed
    if (
      snapshotRef.current.data !== current.data ||
      snapshotRef.current.isLoading !== current.isLoading ||
      snapshotRef.current.isFetching !== current.isFetching ||
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
    if (!typeId || !enabled) return;

    stateRef.current = { ...stateRef.current, isFetching: true, error: null, isError: false };

    try {
      const entity = await dataManager.refreshByTypeId(typeId) as T | null;
      stateRef.current = {
        data: entity,
        isLoading: false,
        isFetching: false,
        error: null,
        isError: false,
        isSuccess: true,
      };
    } catch (err) {
      stateRef.current = {
        data: null,
        isLoading: false,
        isFetching: false,
        error: err as ApiError,
        isError: true,
        isSuccess: false,
      };
    }
    snapshotRef.current = { ...stateRef.current };
    notifyRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, typeId?.type, typeId?.id, queryJsonStringified]);

  // Set up watch functionality - only watch if entity is saved
  const entity = state.data;
  const shouldWatch = (watch ?? false) && (entity?.saved ?? false);
  useWatch(typeId, shouldWatch);

  return {
    ...state,
    refetch,
  };
}
