import { FlowData, FlowDataEvents, FlowDataType } from '@sdk';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Hook for tracking individual FlowData streaming updates and progress
 * Monitors real-time changes to a specific FlowData instance
 * IMPORTANT: Only supports FlowData with dataType='string' for streaming
 * @param flowData - The FlowData instance to track (must be string type)
 * @returns Streaming state and progress information
 * @throws Error if flowData.dataType is not 'string'
 */
export function useDataStreamText(flowData: FlowData | null | undefined) {
  // Validate data type - only string types support streaming
  if (flowData && flowData.dataType !== FlowDataType.String) {
    throw new Error(
      `useDataStreamText only supports dataType='string'. ` +
        `Got dataType='${flowData.dataType}' for element '${flowData.elementType}'. ` +
        `Streaming is not supported for object or entity types.`,
    );
  }
  // Store stream state in a ref to persist across re-renders
  const streamStateRef = useRef({
    isComplete: false,
    progress: 0,
    partialContent: '',
    isStreaming: false,
    lastUpdate: null as Date | null,
    error: undefined as Error | undefined,
  });

  // Reset all refs when flow data changes (onFlowChange)
  useEffect(() => {
    streamStateRef.current = {
      isComplete: false,
      progress: 0,
      partialContent: '',
      isStreaming: false,
      lastUpdate: null,
      error: undefined,
    };
    snapshotRef.current = {
      isComplete: false,
      progress: 0,
      partialContent: '',
      isStreaming: false,
      lastUpdate: null,
      error: undefined,
      hasContent: false,
      progressPercent: 0,
      isActive: false,
    };
  }, [flowData]);

  // Subscribe function using useCallback for stability
  const subscribe = useCallback(
    (callback: () => void) => {
      if (!flowData) {
        return () => {};
      }

      // Listen to FlowData events for real-time updates
      const chunkCallback = () => {
        callback();
      };
      const readyCallback = () => {
        // Just trigger re-render - getSnapshot will update completion status
        callback();
      };
      const errorCallback = (error: Error) => {
        streamStateRef.current = {
          ...streamStateRef.current,
          isComplete: true,
          isStreaming: false,
          error,
          lastUpdate: new Date(),
        };
        callback();
      };

      flowData.on(FlowDataEvents.CHUNK, chunkCallback);
      flowData.on(FlowDataEvents.READY, readyCallback);
      flowData.on(FlowDataEvents.ERROR, errorCallback);

      return () => {
        // Clean up event listeners
        try {
          flowData.off(FlowDataEvents.CHUNK, chunkCallback);
          flowData.off(FlowDataEvents.READY, readyCallback);
          flowData.off(FlowDataEvents.ERROR, errorCallback);
        } catch {
          // Silently handle cleanup errors
        }
      };
    },
    [flowData],
  );

  // Cache the snapshot to prevent infinite re-renders
  const snapshotRef = useRef({
    isComplete: false,
    progress: 0,
    partialContent: '',
    isStreaming: false,
    lastUpdate: null as Date | null,
    error: undefined as Error | undefined,
    hasContent: false,
    progressPercent: 0,
    isActive: false,
  });

  // Snapshot function to get current stream state
  const getSnapshot = useCallback(() => {
    // Always sync with rawData (source of truth) - but don't mutate unnecessarily
    if (flowData) {
      // Use rawData as source of truth - it accumulates during streaming
      // Safe to cast as string since we validated dataType='string' above
      const currentRawData = (flowData.rawData as string) || '';
      const isComplete = flowData.ready || false;
      const isStreaming = !flowData.ready;

      // Only update if something actually changed (avoid triggering re-renders)
      if (
        streamStateRef.current.partialContent !== currentRawData ||
        streamStateRef.current.isComplete !== isComplete ||
        streamStateRef.current.isStreaming !== isStreaming
      ) {
        // Update ref state - don't touch lastUpdate here (causes infinite loop!)
        streamStateRef.current.partialContent = currentRawData;
        streamStateRef.current.isComplete = isComplete;
        streamStateRef.current.isStreaming = isStreaming;
      }
    }

    const streamState = streamStateRef.current;
    const newSnapshot = {
      ...streamState,
      // Computed properties
      hasContent: !!streamState.partialContent,
      progressPercent: Math.min(100, Math.max(0, streamState.progress)),
      isActive: streamState.isStreaming && !streamState.isComplete,
    };

    // Only update if something actually changed
    const current = snapshotRef.current;
    if (
      current.isComplete !== newSnapshot.isComplete ||
      current.progress !== newSnapshot.progress ||
      current.partialContent !== newSnapshot.partialContent ||
      current.isStreaming !== newSnapshot.isStreaming ||
      current.lastUpdate !== newSnapshot.lastUpdate ||
      current.error !== newSnapshot.error ||
      current.hasContent !== newSnapshot.hasContent ||
      current.progressPercent !== newSnapshot.progressPercent ||
      current.isActive !== newSnapshot.isActive
    ) {
      snapshotRef.current = newSnapshot;
    }

    return snapshotRef.current;
  }, [flowData]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
