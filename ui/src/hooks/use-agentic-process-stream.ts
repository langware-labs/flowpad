/**
 * useAgenticProcessStream
 *
 * Subscribe to `AgenticProcess.flowDataStream.items` with a stable snapshot
 * — the React-18-correct way to consume the per-process stream that the
 * worker drivers feed (`source=stream` for live, `source=history` for
 * replay, `source=sniffer` for forwarded hook events).
 *
 * Why `useSyncExternalStore` and not `useEntityData`: the latter calls
 * `setFlowData([...items])` on every WS event, recreating the array
 * reference even when the content didn't change. That ref churn cascades
 * through downstream `useMemo`s and historically caused render loops in the
 * InteractiveTerminal trace gutter (Tooltip ref-merge → setState every
 * commit). `useSyncExternalStore` lets us return a memoized snapshot that
 * only re-emits when items actually changed (length or per-item identity).
 */

import { AgenticProcess, FlowData } from '@sdk';
import { useCallback, useRef, useSyncExternalStore } from 'react';

export function useAgenticProcessStream(process: AgenticProcess | null): FlowData[] {
  const snapshotRef = useRef<FlowData[]>([]);

  const subscribe = useCallback((cb: () => void) => {
    if (!process) return () => {};
    const onData = () => cb();
    const onClear = () => cb();
    process.flowDataStream.on('data', onData);
    process.flowDataStream.on('clear', onClear);
    return () => {
      process.flowDataStream.off('data', onData);
      process.flowDataStream.off('clear', onClear);
    };
  }, [process]);

  const getSnapshot = useCallback(() => {
    if (!process) {
      if (snapshotRef.current.length !== 0) snapshotRef.current = [];
      return snapshotRef.current;
    }
    const items = process.flowDataStream.items as FlowData[];
    if (
      items.length !== snapshotRef.current.length ||
      items.some((v, i) => v !== snapshotRef.current[i])
    ) {
      snapshotRef.current = [...items];
    }
    return snapshotRef.current;
  }, [process]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
