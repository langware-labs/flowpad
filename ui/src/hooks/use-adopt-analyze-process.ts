import { AgenticProcess, isProcessActive, type Task, type WizardData } from '@sdk';
import type { WizardModalAttachment } from '@src/components/wizard/wizard-modal';
import { useProcessState } from '@src/hooks/use-process-state';
import { useEffect, useMemo, useState } from 'react';

const WIZARD_NAME = 'task-analyze';

/**
 * If a task already has a RUNNING `task-analyze` wizard process, return an adopt
 * payload the WizardButton reconnects to (spinner + live tool count, no second
 * run). Returns null when there's no such process — or it has finished — so the
 * button falls back to fresh/idle.
 *
 * The task→process link is `task.process_id` (the analyze agent stamps it as
 * its FIRST action — before the analysis file exists — so we gate on that
 * alone, not on the later `analysis_path`, to catch a still-running analysis).
 * We then confirm the topic via the process's own `context_data.wizard.name`: a
 * non-analyze process that happens to be on the task (a chat/execution that
 * also stamped `process_id`) is NOT adopted — "if its topic is task-analyze,
 * use it; if not, show new".
 */
export function useAdoptAnalyzeProcess(task: Task | null): WizardModalAttachment | null {
  const [process, setProcess] = useState<AgenticProcess | null>(null);

  const processId = task?.process_id ?? undefined;

  useEffect(() => {
    if (!processId) {
      setProcess(null);
      return;
    }
    let cancelled = false;
    let unwatch: (() => Promise<void>) | null = null;
    void (async () => {
      try {
        const p = await AgenticProcess.getByIdWithHistory(processId);
        if (cancelled || !p) return;
        const wizard = p.context_data?.wizard as { name?: string } | undefined;
        if (wizard?.name !== WIZARD_NAME) return; // not the analyze wizard → don't adopt
        setProcess(p);
        unwatch = await p.watch();
      } catch (err) {
        console.error('[useAdoptAnalyzeProcess] attach failed', err);
      }
    })();
    return () => {
      cancelled = true;
      if (unwatch) void unwatch();
    };
  }, [processId]);

  const { status } = useProcessState(process);
  const running = !!process && isProcessActive(status);

  return useMemo<WizardModalAttachment | null>(() => {
    if (!running || !process) return null;
    const wizard = process.context_data?.wizard as { data?: WizardData } | undefined;
    return {
      process,
      target: process.target_typeid_str ?? `wizard:${WIZARD_NAME}:${process.id}`,
      request: { wizardName: WIZARD_NAME, wizardData: wizard?.data },
    };
  }, [running, process]);
}
