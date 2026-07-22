import { isWorkerRunning, ProcessKind, WorkerStatus, type AgenticProcess, type Task, type WizardData } from '@sdk';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import type { WizardModalAttachment } from '@src/components/wizard/wizard-modal';
import { useMemo } from 'react';

const WIZARD_NAME = 'task-analyze';

function workerActive(p: AgenticProcess): boolean {
  // `workerStatus` (camelCase getter) is the LIVE value; `worker_status` (snake)
  // is a readonly snapshot that never updates.
  const ws = p.workerStatus;
  return ws != null && (isWorkerRunning(ws) || ws === WorkerStatus.INITIALIZING);
}

/**
 * If a RUNNING `task-analyze` wizard exists for this task, return an adopt
 * payload the WizardButton reconnects to (spinner + live tool count, no second
 * run). Returns null when none is running — so the button falls back to
 * fresh/idle.
 *
 * Keyed on the wizard's TARGET (the task's TypeId, stamped as the process's
 * `target_typeid_str` at launch), NOT on `task.process_id`: the agent stamps
 * `process_id` lazily and it can point at a stale prior run, so a target query
 * is the reliable way to find the *current* run. We then confirm the topic via
 * `context_data.wizard.name` and require a genuinely-active worker.
 */
export function useAdoptAnalyzeProcess(task: Task | null): WizardModalAttachment | null {
  const target = task?.typeId?.toString();
  const { processes } = useProcessesForTarget(target, { processType: ProcessKind.Wizard });

  return useMemo<WizardModalAttachment | null>(() => {
    const match = (processes ?? []).find((p) => {
      const w = p.context_data?.wizard as { name?: string } | undefined;
      return w?.name === WIZARD_NAME && workerActive(p);
    });
    if (!match) return null;
    const w = match.context_data?.wizard as { data?: WizardData } | undefined;
    return {
      process: match,
      target: match.target_typeid_str ?? String(target ?? ''),
      request: { wizardName: WIZARD_NAME, wizardData: w?.data },
    };
  }, [processes, target]);
}
