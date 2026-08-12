import { t } from '@lingui/core/macro';
import { ActionInfo, dataManager, Task, TaskKind, type WizardData, type WizardProcessResult } from '@sdk';
import { openArtifact, TaskStatus } from '@src/components/task-bar/task-utils';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { WizardButton } from '@src/components/wizard/WizardButton';
import { useAdoptAnalyzeProcess } from '@src/hooks/use-adopt-analyze-process';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ScanSearch } from 'lucide-react';
import { useCallback, useState } from 'react';

interface AnalyzeStatusResult {
  summary?: string;
  analysisPath?: string;
  missing?: string[];
  /** The wizard's verdict that every done-gate field is satisfied and the work
   *  is complete — drives the "you can switch to Done" popup. */
  readyForDone?: boolean;
}

interface AnalyzeStatusButtonProps {
  task: Task;
  /** Fired after the wizard closes with status 'done'. */
  onAnalyzed?: (result: AnalyzeStatusResult | null) => void;
  className?: string;
}

/**
 * Runs the `task-analyze` wizard on this task inline (single click; spinner +
 * live tool count on the button — double click opens the full wizard). For a
 * group task the backend `sync-group` runs first so the analysis reads fresh
 * member rows (offline → analyze what we have). The wizard agent stamps
 * `process_id` / `analysis_path` on the task itself, which lights the
 * AnalysisProgressRow; those outcomes persist even if the user navigates away.
 *
 * The task's fields are the agent's to write, not ours — this button only opens
 * the group report and offers the Done flip the agent may not make itself.
 */
export function AnalyzeStatusButton({ task, onAnalyzed, className }: AnalyzeStatusButtonProps) {
  const { navigation } = useDockNavigation();
  const [confirmDone, setConfirmDone] = useState(false);
  const isGroup = task.kind === TaskKind.GROUP;
  // If an analyze run for this task is still going, reconnect to it (spinner +
  // live tool count) instead of showing a fresh button.
  const adopt = useAdoptAnalyzeProcess(task);

  const buildRequest = useCallback(async (): Promise<WizardData> => {
    if (isGroup) {
      try {
        await dataManager.callAction(new ActionInfo('sync-group', Task.type, task.id, 'POST'));
      } catch {
        // Offline / hub unreachable — analyze the rows we have.
      }
    }
    return {
      title: isGroup ? 'Analyze group status' : 'Analyze task status',
      targetTypeId: task.typeId.toString(),
      payload: {
        taskId: task.id,
        mode: isGroup ? 'group' : 'standard',
        projectId: task.project_id ?? null,
        taskFolder: task.asset_ref ?? null,
      },
      // Mirrors AnalyzeStatusResult — the prompt renders these as the close
      // command's `data`, so the agent fills them in instead of pasting `{}`
      // and leaving us with a "success" that carries no report.
      resultShape: {
        readyForDone: '<true|false>',
        missing: ['<field>'],
        analysisPath: '<absolute path to references/analysis.html>',
        summary: t`<one short line>`,
      },
      prompt: isGroup
        ? 'Analyze the status of this group task across all its member tasks and produce the owner summary.'
        : 'Analyze the current status of this task, fill in missing fields where you can, and report progress.',
    };
  }, [isGroup, task]);

  const handleResult = useCallback(
    (result: WizardProcessResult<AnalyzeStatusResult>) => {
      if (result.status !== 'done') {
        onAnalyzed?.(null);
        return;
      }
      const data = result.data ?? null;
      const reportPath = data?.analysisPath?.trim();

      // The task's own fields are the AGENT's to write: it patches `task.md`
      // (status, process_id, analysis paths) and indexes it. We do not write
      // them from here — a second writer holding a pre-run snapshot re-renders
      // task.md from stale fields and wipes what the agent just patched.
      if (data?.readyForDone) {
        void (async () => {
          // Completion stays a human action: the agent reports readyForDone and
          // never sets `done` itself, so offer the flip. Read the status FRESH —
          // ours predates the run, and an already-done task must not be asked about.
          const fresh = (await dataManager.refreshByTypeId(task.typeId).catch(() => null)) as Task | null;
          if ((fresh ?? task).status !== TaskStatus.DONE) setConfirmDone(true);
        })();
      }

      if (isGroup && reportPath) openArtifact(reportPath, navigation);
      onAnalyzed?.(data);
    },
    [isGroup, navigation, onAnalyzed, task],
  );

  const markDone = useCallback(() => {
    void (async () => {
      const fresh = (await dataManager.refreshByTypeId(task.typeId).catch(() => null)) as Task | null;
      const target = fresh ?? task;
      target.status = TaskStatus.DONE;
      await target.save().catch(() => undefined);
    })();
  }, [task]);

  return (
    <>
      <WizardButton<AnalyzeStatusResult>
        wizardName="task-analyze"
        buildRequest={buildRequest}
        successMessage={(data) => {
          if (isGroup) return 'Your group status report is ready';
          if (data?.readyForDone) return 'This task looks done — you can switch its status to Done';
          return 'Your status report is ready';
        }}
        errorTitle="Analyze Status failed"
        onResult={handleResult}
        adopt={adopt}
        runningLabel="Analyzing"
        className={className}
        disabled={!task.id}
        testId="task-analyze-status"
        title="Let an agent assess progress and fill in missing fields"
      >
        <ScanSearch className="h-3.5 w-3.5" />
        Analyze Status
      </WizardButton>
      <ConfirmDialog
        open={confirmDone}
        onOpenChange={setConfirmDone}
        title="Mark this task as Done?"
        description="The analysis found every requirement satisfied and a submission recorded. Setting the status is yours to confirm."
        confirmLabel="Mark Done"
        cancelLabel="Not yet"
        onConfirm={markDone}
      />
    </>
  );
}
