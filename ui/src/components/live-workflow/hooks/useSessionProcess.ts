import { useCallback, useEffect, useRef } from 'react';
import {
  AgenticProcess,
  AgenticProcessor,
  ContextEntitiesEnum,
  dataContext,
  isProcessorRunning,
  ProcessorStatus,
  TypeId,
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

  const processorRef = useRef<AgenticProcessor | null>(null);

  // Subscribe to process state
  const { status, completed, error } = useProcessState(process);

  // Determine if running
  const isRunning = !completed && isProcessorRunning(status);

  // Abort running process
  const abortProcess = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.dispose();
      processorRef.current = null;
    }
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

  // Restore processor reference when process comes from context (e.g., page refresh)
  useEffect(() => {
    if (!process?.processor_id || processorRef.current) {
      return;
    }

    const restoreProcessor = async () => {
      try {
        const processorTypeId = new TypeId(AgenticProcessor.type, process.processor_id);
        const existingProcessor = await dataContext.loadContextEntity(processorTypeId);
        if (existingProcessor) {
          await (existingProcessor as AgenticProcessor).watch();
          processorRef.current = existingProcessor as AgenticProcessor;
        }
      } catch (err) {
        console.warn('[useSessionProcess] Could not restore processor:', err);
      }
    };

    void restoreProcessor();
  }, [process?.processor_id]);

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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (processorRef.current) {
        processorRef.current.dispose();
        processorRef.current = null;
      }
    };
  }, []);

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
