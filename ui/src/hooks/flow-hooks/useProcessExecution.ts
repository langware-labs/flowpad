import { Flow, FlowEvents, FlowExecutionStatus } from '@sdk';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Hook for tracking flow execution state
 * Returns execution state and boolean flags for common state checks
 * Read-only: reflects the actual state from the Flow entity
 */
export function useProcessExecution(flow: Flow | null) {
  // Cache the snapshot to prevent infinite re-renders
  const snapshotRef = useRef({
    executionState: FlowExecutionStatus.Ready,
    isRunning: false,
    isReady: true,
    isCanceled: false,
    isError: false,
  });

  // Reset all refs when flow changes (onFlowChange)
  useEffect(() => {
    snapshotRef.current = {
      executionState: FlowExecutionStatus.Ready,
      isRunning: false,
      isReady: true,
      isCanceled: false,
      isError: false,
    };
  }, [flow]);

  // Subscribe function using useCallback for stability
  const subscribe = useCallback(
    (callback: () => void) => {
      if (!flow) {
        return () => {};
      }

      // Listen to the execution status event emitted by Flow entity
      const unsubscribeExecutionStatus = flow.on(FlowEvents.EXECUTION_STATUS, callback);

      // Also listen to stream events as backup (they may trigger execution state changes)
      const unsubscribeStart = flow.on(FlowEvents.STREAM_START, callback);
      const unsubscribeEnd = flow.on(FlowEvents.STREAM_END, callback);
      const unsubscribeCancel = flow.on(FlowEvents.STREAM_CANCEL, callback);
      const unsubscribeError = flow.on(FlowEvents.ERROR, callback);

      return () => {
        unsubscribeExecutionStatus();
        unsubscribeStart();
        unsubscribeEnd();
        unsubscribeCancel();
        unsubscribeError();
      };
    },
    [flow],
  );

  // Snapshot function to get current execution state
  const getSnapshot = useCallback(() => {
    // Read execution state directly from flow (read-only)
    const executionState = flow?.executionStatus || FlowExecutionStatus.Ready;

    const newSnapshot = {
      executionState,
      isRunning: executionState === FlowExecutionStatus.Running,
      isReady: executionState === FlowExecutionStatus.Ready,
      isCanceled: executionState === FlowExecutionStatus.Canceled,
      isError: executionState === FlowExecutionStatus.Error,
    };

    // Only update if something actually changed
    const current = snapshotRef.current;
    if (
      current.executionState !== newSnapshot.executionState ||
      current.isRunning !== newSnapshot.isRunning ||
      current.isReady !== newSnapshot.isReady ||
      current.isCanceled !== newSnapshot.isCanceled ||
      current.isError !== newSnapshot.isError
    ) {
      snapshotRef.current = newSnapshot;
    }

    return snapshotRef.current;
  }, [flow]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
