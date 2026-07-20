import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { AgenticProcess, ProcessStatus, WorkerStatus } from '@sdk';

/**
 * Hook for subscribing to AgenticProcess status via WebSocket entity updates.
 * Uses useSyncExternalStore for optimal React 18+ integration.
 *
 * @param process - The AgenticProcess to track (can be null)
 * @returns Current lifecycle status, completion status, and error
 */
export function useProcessState(process: AgenticProcess | null | undefined): {
  status: ProcessStatus;
  /** Raw worker status — the reliable "is the agent still running" signal.
   *  (`status` can lag at RUNNING after the worker is COMPLETE, e.g. a wizard
   *  whose agent finished its turn without closing.) */
  workerStatus: WorkerStatus | null;
  completed: boolean;
  error: Error | null;
} {
  const snapshotRef = useRef<{
    status: ProcessStatus;
    workerStatus: WorkerStatus | null;
    completed: boolean;
    error: Error | null;
  }>({
    status: ProcessStatus.NEW,
    workerStatus: null,
    completed: false,
    error: null,
  });

  useEffect(() => {
    if (process) {
      snapshotRef.current = {
        status: process.status ?? ProcessStatus.NEW,
        workerStatus: (process.worker_status as WorkerStatus | undefined) ?? null,
        completed: process.completed,
        error: process.error,
      };
    } else {
      snapshotRef.current = { status: ProcessStatus.NEW, workerStatus: null, completed: false, error: null };
    }
  }, [process]);

  const subscribe = useCallback(
    (callback: () => void) => {
      if (!process) return () => {};
      const unsubState = process.on('state_change', callback);
      const unsubComplete = process.on('complete', callback);
      const unsubError = process.on('error', callback);
      return () => {
        unsubState();
        unsubComplete();
        unsubError();
      };
    },
    [process],
  );

  const getSnapshot = useCallback(() => {
    if (!process) return snapshotRef.current;
    const next = {
      status: process.status ?? ProcessStatus.NEW,
      workerStatus: (process.worker_status as WorkerStatus | undefined) ?? null,
      completed: process.completed,
      error: process.error,
    };
    const cur = snapshotRef.current;
    if (
      cur.status !== next.status ||
      cur.workerStatus !== next.workerStatus ||
      cur.completed !== next.completed ||
      cur.error !== next.error
    ) {
      snapshotRef.current = next;
    }
    return snapshotRef.current;
  }, [process]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
