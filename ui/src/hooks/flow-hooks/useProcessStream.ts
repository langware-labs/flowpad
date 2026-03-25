import { Flow, FlowData, FlowEvents } from '@sdk';
import { useCallback, useRef, useSyncExternalStore } from 'react';

/**
 * Hook for subscribing to real-time flow streaming events
 * Returns pure FlowData stream using flow.stream property
 */
export function useProcessStream(flow: Flow | null) {
  const snapshotRef = useRef<{
    data: FlowData[];
    dataArr: FlowData[];
    isStreaming: boolean;
    streamError: Error | null;
    streamingCounter: number;
    renderCounter: number;
  }>({
    data: [],
    dataArr: [],
    isStreaming: false,
    streamError: null,
    streamingCounter: 0,
    renderCounter: 0,
  });

  const subscribe = useCallback(
    (callback: () => void) => {
      if (!flow) return () => {};

      const dataCallback = () => {
        callback();
      };

      const renderCallback = () => {
        callback();
      };

      const statusCallback = () => {
        callback();
      };

      flow.stream.on(FlowEvents.DATA, dataCallback);
      flow.stream.on(FlowEvents.RENDER, renderCallback);
      flow.on(FlowEvents.EXECUTION_STATUS, statusCallback);

      return () => {
        flow.stream.off(FlowEvents.DATA, dataCallback);
        flow.stream.off(FlowEvents.RENDER, renderCallback);
        flow.off(FlowEvents.EXECUTION_STATUS, statusCallback);
      };
    },
    [flow],
  );

  const getSnapshot = useCallback(() => {
    if (!flow) {
      const emptySnapshot = {
        data: [],
        dataArr: [],
        isStreaming: false,
        streamError: null,
        streamingCounter: 0,
        renderCounter: 0,
      };
      if (
        snapshotRef.current.data.length !== 0 ||
        snapshotRef.current.dataArr.length !== 0 ||
        snapshotRef.current.isStreaming !== false ||
        snapshotRef.current.streamError !== null ||
        snapshotRef.current.streamingCounter !== 0 ||
        snapshotRef.current.renderCounter !== 0
      ) {
        snapshotRef.current = emptySnapshot;
      }
      return snapshotRef.current;
    }

    const currentItems = flow.stream.items;
    const currentIsRunning = flow.isRunning;
    const currentStreamError = flow.streamError;
    const currentStreamingCounter = flow.runningCounter;
    const currentRenderCounter = flow.stream.renderCounter;

    // Only update snapshot if data actually changed
    if (
      snapshotRef.current.data.length !== currentItems.length ||
      snapshotRef.current.data.some((item, i) => item !== currentItems[i]) ||
      snapshotRef.current.isStreaming !== currentIsRunning ||
      snapshotRef.current.streamError !== currentStreamError ||
      snapshotRef.current.streamingCounter !== currentStreamingCounter ||
      snapshotRef.current.renderCounter !== currentRenderCounter
    ) {
      const dataArray = [...currentItems];
      snapshotRef.current = {
        data: dataArray,
        dataArr: dataArray, // Alias for backwards compatibility
        isStreaming: currentIsRunning,
        streamError: currentStreamError,
        streamingCounter: currentStreamingCounter,
        renderCounter: currentRenderCounter,
      };
    }

    return snapshotRef.current;
  }, [flow]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
