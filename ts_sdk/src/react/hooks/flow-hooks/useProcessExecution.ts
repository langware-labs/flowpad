import { Flow, FlowEvents, SendStatus } from '@sdk';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Hook for tracking client-side send-status on a Flow ("is a sendMessage in flight?").
 * Returns the SendStatus and a few boolean convenience flags.
 * Read-only: reflects the state owned by the Flow entity.
 */
export function useSendStatus(flow: Flow | null) {
  // Cache the snapshot to prevent infinite re-renders
  const snapshotRef = useRef({
    sendState: SendStatus.Ready,
    isRunning: false,
    isReady: true,
    isCanceled: false,
    isError: false,
  });

  // Reset all refs when flow changes (onFlowChange)
  useEffect(() => {
    snapshotRef.current = {
      sendState: SendStatus.Ready,
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

      const unsubscribeSendStatus = flow.on(FlowEvents.SEND_STATUS, callback);

      // Also listen to stream events as backup (they may trigger send-status changes)
      const unsubscribeStart = flow.on(FlowEvents.STREAM_START, callback);
      const unsubscribeEnd = flow.on(FlowEvents.STREAM_END, callback);
      const unsubscribeCancel = flow.on(FlowEvents.STREAM_CANCEL, callback);
      const unsubscribeError = flow.on(FlowEvents.ERROR, callback);

      return () => {
        unsubscribeSendStatus();
        unsubscribeStart();
        unsubscribeEnd();
        unsubscribeCancel();
        unsubscribeError();
      };
    },
    [flow],
  );

  // Snapshot function to get current send state
  const getSnapshot = useCallback(() => {
    const sendState = flow?.sendStatus || SendStatus.Ready;

    const newSnapshot = {
      sendState,
      isRunning: sendState === SendStatus.Running,
      isReady: sendState === SendStatus.Ready,
      isCanceled: sendState === SendStatus.Canceled,
      isError: sendState === SendStatus.Error,
    };

    // Only update if something actually changed
    const current = snapshotRef.current;
    if (
      current.sendState !== newSnapshot.sendState ||
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

/** @deprecated Use ``useSendStatus``. */
export const useProcessExecution = useSendStatus;
