import { FlowEvents, FlowStateProperty, IFlowState, TypeId } from '@sdk';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useProcess } from './useProcess';

/**
 * Hook for accessing and subscribing to flow state changes
 * Dead simple: listen to flow state events and update state properties
 * @param flowTypeId - TypeId of the flow to track (or null)
 * @param key - Optional specific state property to watch (FlowStateProperty enum). If not provided, returns null
 * @returns The flow state property value and last update info
 */
export function useProcessStateField<K extends keyof IFlowState>(
  flowTypeId: TypeId | null = null,
  key: FlowStateProperty | null = null,
): {
  state: IFlowState[K] | null;
  lastUpdated: Date | null;
} {
  // Get flow entity using useProcess (which sets watch: true and handles context)
  const { data: flow } = useProcess(flowTypeId);

  // Memoize stateKey to prevent unnecessary re-subscriptions
  const stateKey = useMemo(() => key as K | null, [key]);
  // Store last state change timestamp separately
  const lastStateChangeRef = useRef<Date | null>(null);

  // Cache the snapshot to prevent infinite re-renders
  const snapshotRef = useRef({
    state: null as IFlowState[K] | null,
    lastUpdated: null as Date | null,
  });

  // Keep a ref to the latest flow so getSnapshot can access it without being in deps
  const flowRef = useRef(flow);
  flowRef.current = flow;

  // Reset all refs when flow changes (onFlowChange)
  useEffect(() => {
    lastStateChangeRef.current = null;
    snapshotRef.current = {
      state: null as IFlowState[K] | null,
      lastUpdated: null,
    };
  }, [flow]);

  // Subscribe function using useCallback for stability
  const subscribe = useCallback(
    (callback: () => void) => {
      if (!flow) {
        return () => {};
      }

      const unsubscribeState = flow.on(FlowEvents.STATE_CHANGE, (stateEvent: { key: string; value: unknown }) => {
        const { key } = stateEvent;
        // If watching a specific key, only trigger callback when that key changes
        if (stateKey) {
          if (key === stateKey) {
            lastStateChangeRef.current = new Date();
            callback();
          }
        } else {
          // If watching all state, always trigger callback
          lastStateChangeRef.current = new Date();
          callback();
        }
      });

      return () => {
        unsubscribeState();
      };
    },
    [flow, stateKey],
  );

  // Snapshot function to get current state
  // Note: flow is accessed via flowRef.current to get latest value without causing re-subscription
  const getSnapshot = useCallback(() => {
    const currentFlow = flowRef.current;
    if (!currentFlow || !currentFlow.state || !stateKey) {
      const newSnapshot = {
        state: null as IFlowState[K] | null,
        lastUpdated: null,
      };

      // Only update if something actually changed
      const current = snapshotRef.current;
      if (current.state !== newSnapshot.state || current.lastUpdated !== newSnapshot.lastUpdated) {
        snapshotRef.current = newSnapshot;
      }
      return snapshotRef.current;
    }

    // Always access specific property (e.g., flow.state.root_todo)
    // This avoids stateJson which creates new objects on every call
    const currentState = currentFlow.state[stateKey];
    const newSnapshot = {
      state: currentState as IFlowState[K] | null,
      lastUpdated: lastStateChangeRef.current,
    };

    // Only update snapshot if reference actually changed
    const current = snapshotRef.current;
    if (current.state !== newSnapshot.state || current.lastUpdated !== newSnapshot.lastUpdated) {
      snapshotRef.current = newSnapshot;
    }

    return snapshotRef.current;
  }, [stateKey]); // Don't include flowRef - access via ref to get latest value without re-subscription

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
