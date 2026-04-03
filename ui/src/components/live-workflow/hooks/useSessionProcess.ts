import { useCallback, useEffect } from 'react';
import {
  AgenticProcess,
  ContextEntitiesEnum,
  dataContext,
  isProcessorRunning,
  ProcessorStatus,
} from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { useProcessState } from '@src/hooks/use-process-state';

interface UseSessionProcessResult {
  process: AgenticProcess | null;
  status: ProcessorStatus;
  completed: boolean;
  error: Error | null;
  isRunning: boolean;
  abortProcess: () => void;
  injectInstruction: (content: string) => Promise<void>;
}

/**
 * Hook for managing agentic process lifecycle for sessions (without files)
 *
 * Consumes process from dataContext (set by loader).
 * Provides actions: abortProcess, injectInstruction.
 */
export function useSessionProcess(): UseSessionProcessResult {
  const { agenticProcess } = useContext();
  const process = agenticProcess;

  // Subscribe to process state
  const { status, completed, error } = useProcessState(process);

  // Determine if running
  const isRunning = !completed && isProcessorRunning(status);

  // Abort running process
  const abortProcess = useCallback(() => {
    void dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
  }, []);

  // Inject instruction — execute on the process (reuses active worker if available)
  const injectInstruction = useCallback(
    async (content: string) => {
      if (!process) {
        console.warn('[useSessionProcess] Cannot inject: no process');
        return;
      }

      try {
        await process.executeInstruction(content, { sync: false });
      } catch (err) {
        console.error('[useSessionProcess] Failed to execute instruction:', err);
      }
    },
    [process],
  );

  // Ensure we watch the process and load history after refresh
  useEffect(() => {
    if (!process) return;

    let cancelled = false;
    const ensureHistory = async () => {
      try {
        await process.watch();
        if (!cancelled && !process.historyLoaded) {
          await process.loadHistory();
        }
      } catch (err) {
        console.warn('[useSessionProcess] Failed to watch/load history:', err);
      }
    };

    void ensureHistory();

    const unsubComplete = process.on('complete', () => {
      void process.loadHistory({ force: true, onlyUserMessages: true });
    });

    return () => {
      cancelled = true;
      unsubComplete?.();
    };
  }, [process]);

  return {
    process,
    status,
    completed,
    error,
    isRunning,
    abortProcess,
    injectInstruction,
  };
}
