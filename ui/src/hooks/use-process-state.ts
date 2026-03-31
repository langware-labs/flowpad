import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { AgenticProcess, ProcessorStatus } from '@sdk';

/**
 * Hook for subscribing to AgenticProcess status via WebSocket entity updates.
 * Uses useSyncExternalStore for optimal React 18+ integration.
 *
 * @param process - The AgenticProcess to track (can be null)
 * @returns Current status, completion status, and error
 */
export function useProcessState(process: AgenticProcess | null | undefined): {
  status: ProcessorStatus;
  completed: boolean;
  error: Error | null;
} {
  const snapshotRef = useRef<{
    status: ProcessorStatus;
    completed: boolean;
    error: Error | null;
  }>({
    status: ProcessorStatus.IDLE,
    completed: false,
    error: null,
  });

  useEffect(() => {
    if (process) {
      snapshotRef.current = {
        status: process.status ?? ProcessorStatus.IDLE,
        completed: process.completed,
        error: process.error,
      };
    } else {
      snapshotRef.current = { status: ProcessorStatus.IDLE, completed: false, error: null };
    }
  }, [process]);

  const subscribe = useCallback(
    (callback: () => void) => {
      if (!process) return () => {};
      const unsubState = process.on('state_change', callback);
      const unsubComplete = process.on('complete', callback);
      const unsubError = process.on('error', callback);
      return () => { unsubState(); unsubComplete(); unsubError(); };
    },
    [process],
  );

  const getSnapshot = useCallback(() => {
    if (!process) return snapshotRef.current;
    const next = {
      status: process.status ?? ProcessorStatus.IDLE,
      completed: process.completed,
      error: process.error,
    };
    const cur = snapshotRef.current;
    if (cur.status !== next.status || cur.completed !== next.completed || cur.error !== next.error) {
      snapshotRef.current = next;
    }
    return snapshotRef.current;
  }, [process]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
