import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { AgenticProcess, ProcessState, ProcessorStatus, isProcessorRunning } from '@sdk';

/**
 * Default ProcessState when no process is available
 */
const defaultProcessState: ProcessState = {
  status: ProcessorStatus.IDLE,
  index: 0,
  totalInstructions: 0,
  currentInstructionId: null,
  variables: {},
  waitingForInput: false,
  inputId: null,
  stack: [],
  debug: { enabled: false, breakpoints: [], stepMode: null },
  error: null,
  mdoContent: null,
};

/**
 * Hook for subscribing to Process execution state via WebSocket entity updates.
 * Uses useSyncExternalStore for optimal React 18+ integration.
 *
 * @param process - The AgenticProcess to track (can be null)
 * @returns Current state, completion status, and error
 */
export function useProcessState(process: AgenticProcess | null | undefined): {
  state: ProcessState;
  completed: boolean;
  error: Error | null;
} {
  // Cached snapshot for referential stability
  const snapshotRef = useRef<{
    state: ProcessState;
    completed: boolean;
    error: Error | null;
  }>({
    state: defaultProcessState,
    completed: false,
    error: null,
  });

  // Reset snapshot when process changes
  useEffect(() => {
    if (process) {
      snapshotRef.current = {
        state: process.state,
        completed: process.completed,
        error: process.error,
      };
    } else {
      snapshotRef.current = {
        state: defaultProcessState,
        completed: false,
        error: null,
      };
    }
  }, [process]);

  // Subscribe to process events
  const subscribe = useCallback(
    (callback: () => void) => {
      if (!process) {
        return () => {};
      }

      const stateHandler = () => callback();
      const completeHandler = () => callback();
      const errorHandler = () => callback();

      const unsubState = process.on('state_change', stateHandler);
      const unsubComplete = process.on('complete', completeHandler);
      const unsubError = process.on('error', errorHandler);

      return () => {
        unsubState();
        unsubComplete();
        unsubError();
      };
    },
    [process],
  );

  // Get current snapshot
  const getSnapshot = useCallback(() => {
    if (!process) {
      return snapshotRef.current;
    }

    const newSnapshot = {
      state: process.state,
      completed: process.completed,
      error: process.error,
    };

    // Only update ref if values changed
    const current = snapshotRef.current;
    if (
      current.state !== newSnapshot.state ||
      current.completed !== newSnapshot.completed ||
      current.error !== newSnapshot.error
    ) {
      snapshotRef.current = newSnapshot;
    }

    return snapshotRef.current;
  }, [process]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Computed properties from ProcessState for UI convenience.
 * Provides derived status flags and progress information.
 *
 * @param state - The ProcessState to analyze (can be null)
 * @returns Computed UI-friendly progress info
 */
export function useProcessProgressInfo(state: ProcessState | null) {
  if (!state) {
    return {
      isRunning: false,
      isPaused: false,
      isComplete: false,
      isError: false,
      isIdle: false,
      currentStep: 0,
      totalSteps: null as number | null,
      loopInfo: null as { current: number; total: number; name: string } | null,
      stackDepth: 0,
    };
  }

  // Find loop info from the stack (look for 'each' frames)
  let loopInfo: { current: number; total: number; name: string } | null = null;
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const frame = state.stack[i];
    if (frame.type === 'each' && frame.iteratorIndex !== undefined && frame.iteratorTotal !== undefined) {
      loopInfo = {
        current: frame.iteratorIndex + 1, // 1-indexed for display
        total: frame.iteratorTotal,
        name: frame.iteratorName || 'item',
      };
      break;
    }
  }

  const isComplete = state.status === ProcessorStatus.COMPLETE;
  const isError = state.status === ProcessorStatus.ERROR;

  return {
    isRunning: isProcessorRunning(state.status),
    isPaused: state.status === ProcessorStatus.PAUSED,
    isComplete,
    isError,
    isIdle: state.status === ProcessorStatus.IDLE,
    // When complete/error, state.index = count of executed instructions.
    // When running, state.index = 0-based index of current instruction, +1 for 1-based display.
    currentStep: isComplete || isError ? state.index : state.index + 1,
    totalSteps: state.totalInstructions > 0 ? state.totalInstructions : null,
    loopInfo,
    stackDepth: state.stack.length,
  };
}
