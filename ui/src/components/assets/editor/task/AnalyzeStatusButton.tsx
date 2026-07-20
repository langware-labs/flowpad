import { ActionInfo, dataManager, Task, TaskKind, type WizardData, type WizardProcessResult } from '@sdk';
import { DONE_GATE_FIELDS } from '@src/components/task-bar/constants';
import { openArtifact } from '@src/components/task-bar/task-utils';
import { WizardButton } from '@src/components/wizard/WizardButton';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ScanSearch } from 'lucide-react';
import { useCallback } from 'react';

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
 */
export function AnalyzeStatusButton({ task, onAnalyzed, className }: AnalyzeStatusButtonProps) {
  const { navigation } = useDockNavigation();
  const isGroup = task.kind === TaskKind.GROUP;

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
        doneGateFields: DONE_GATE_FIELDS.map((f) => f.field),
      },
      prompt: isGroup
        ? 'Analyze the status of this group task across all its member tasks and produce the owner summary.'
        : 'Analyze the current status of this task, fill in missing fields where you can, and report progress.',
    };
  }, [isGroup, task]);

  const handleResult = useCallback(
    (result: WizardProcessResult<AnalyzeStatusResult>) => {
      if (result.status === 'done') {
        const data = result.data ?? null;
        // The persistent report link lives on the task card's analysis row
        // (the wizard stamped analysis_path); open the group report directly.
        if (isGroup && data?.analysisPath) openArtifact(data.analysisPath, navigation);
        onAnalyzed?.(data);
      } else {
        onAnalyzed?.(null);
      }
    },
    [isGroup, navigation, onAnalyzed],
  );

  return (
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
      runningLabel="Analyzing"
      className={className}
      disabled={!task.id}
      testId="task-analyze-status"
      title="Let an agent assess progress and fill in missing fields"
    >
      <ScanSearch className="h-3.5 w-3.5" />
      Analyze Status
    </WizardButton>
  );
}
