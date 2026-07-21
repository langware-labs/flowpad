import { isWorkerRunning, ProcessKind, WorkerStatus, type AgenticProcess, type WizardData } from '@sdk';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import type { WizardModalAttachment } from '@src/components/wizard/wizard-modal';
import { useMemo } from 'react';

function workerActive(p: AgenticProcess): boolean {
  const ws = p.worker_status as WorkerStatus | undefined;
  return ws != null && (isWorkerRunning(ws) || ws === WorkerStatus.INITIALIZING);
}

/**
 * Generic "reflect a running wizard" reconnect, keyed on the wizard's TOPIC
 * (`context_data.wizard.name`) and its TARGET. Returns an adopt payload the
 * WizardButton reconnects to (spinner + live tool count, single run enforced)
 * when a matching wizard is still mid-turn — else null (button shows fresh).
 *
 * Unlike task-analyze (which reconnects via the agent-stamped `task.process_id`),
 * git-context-folder stamps nothing findable, so we query every Wizard process
 * on `target` and pick the running one whose topic matches. Granularity is the
 * target's: a project-scoped target may reflect a sibling git op on the same
 * project — acceptable, and the price of git having no per-op process link.
 */
export function useAdoptWizardProcess(
  wizardName: string,
  target: string | null | undefined,
): WizardModalAttachment | null {
  const { processes } = useProcessesForTarget(target ?? undefined, { processType: ProcessKind.Wizard });

  return useMemo<WizardModalAttachment | null>(() => {
    const match = (processes ?? []).find((p) => {
      const w = p.context_data?.wizard as { name?: string } | undefined;
      return w?.name === wizardName && workerActive(p);
    });
    if (!match) return null;
    const w = match.context_data?.wizard as { data?: WizardData } | undefined;
    return {
      process: match,
      target: match.target_typeid_str ?? String(target ?? ''),
      request: { wizardName, wizardData: w?.data },
    };
  }, [processes, wizardName, target]);
}
