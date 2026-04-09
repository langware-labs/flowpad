import { useEffect, useState } from 'react';
import { AgenticProcess, ProcessStatus, isProcessActive, type Task } from '@sdk';
import { useProcessState } from './use-process-state';
import { useWorkflowProgressInfo } from '@src/components/live-workflow/hooks/useWorkflowProgressInfo';
import { isActionTask, TaskType } from '@src/components/task-bar/task-utils';

interface AnalysisTaskProgress {
  isRunning: boolean;
  isComplete: boolean;
  isError: boolean;
  statusMessage: string | null;
  activityLabel: string | null;
  elapsedTime: string | null;
  analysisPath: string | null;
}

/**
 * Hook that tracks the progress of an analysis task by reconnecting
 * to its underlying AgenticProcess.
 */
export function useAnalysisTaskProgress(task: Task | null): AnalysisTaskProgress {
  const [process, setProcess] = useState<AgenticProcess | null>(null);

  const processId =
    task && (task.task_type === TaskType.ANALYSIS || task.task_type === TaskType.CLASSIFICATION || isActionTask(task))
      ? (task.metadata?.processId as string | undefined)
      : undefined;
  const analysisPath = (task?.metadata?.analysisPath as string | undefined) ?? null;

  // Reconnect to the AgenticProcess when processId changes.
  // Watch the process for WebSocket state updates so we detect completion.
  useEffect(() => {
    if (!processId) {
      setProcess(null);
      return;
    }

    let cancelled = false;
    let unwatchFn: (() => Promise<void>) | null = null;
    const attach = async () => {
      try {
        const p = await AgenticProcess.getByIdWithHistory(processId);
        if (!cancelled && p) {
          setProcess(p);
          // Subscribe to WebSocket updates so state changes (e.g. complete) are received
          unwatchFn = await p.watch();
        }
      } catch (error) {
        console.error('[useAnalysisTaskProgress] Failed to attach to process:', error);
      }
    };
    void attach();

    return () => {
      cancelled = true;
      if (unwatchFn) void unwatchFn();
    };
  }, [processId]);

  const processState = useProcessState(process);
  const taskStatus = task?.status;

  const taskIsDone = taskStatus === 'done';
  const taskIsRunning = taskStatus === 'in_progress';

  const processRunning = isProcessActive(processState.status);
  const processComplete = processState.status === ProcessStatus.STOPPED;
  const processError = processState.status === ProcessStatus.FAILED;

  const isRunning = taskIsDone ? false : (processId ? processRunning : taskIsRunning);
  const isComplete = taskIsDone || processComplete;
  const isError = !taskIsDone && processError;

  const { statusMessage, activityLabel, elapsedTime } = useWorkflowProgressInfo(process, isRunning);

  return {
    isRunning,
    isComplete,
    isError,
    statusMessage,
    activityLabel,
    elapsedTime,
    analysisPath,
  };
}
