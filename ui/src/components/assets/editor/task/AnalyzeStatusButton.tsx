import { ActionInfo, dataManager, launchWizard, QueryFilter, QueryRequest, Task, TaskKind } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { DONE_GATE_FIELDS } from '@src/components/task-bar/constants';
import { openArtifact, TaskStatus } from '@src/components/task-bar/task-utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { ScanSearch } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface AnalyzeStatusResult {
  summary?: string;
  analysisPath?: string;
  missing?: string[];
}

interface AnalyzeStatusButtonProps {
  task: Task;
  /** Fired after the wizard closes with status 'done'. */
  onAnalyzed?: (result: AnalyzeStatusResult | null) => void;
  className?: string;
}

/**
 * Launches the `task-analyze` wizard on this task. For a group task the
 * backend `sync-group` runs first so the analysis reads fresh member rows
 * (offline → analyze what we have). The wizard agent stamps `process_id` /
 * `analysis_path` on the task itself, which lights the AnalysisProgressRow.
 */
export function AnalyzeStatusButton({ task, onAnalyzed, className }: AnalyzeStatusButtonProps) {
  const [busy, setBusy] = useState(false);
  const { navigation } = useDockNavigation();

  // A group task's status analysis rolls up its members, so it's only
  // meaningful once at least one member has finished — gate the button on that.
  // Standard tasks have no members and always show it.
  const isGroup = task.kind === TaskKind.GROUP;
  const childQuery = useMemo(
    () =>
      new QueryRequest({
        type: Task.type,
        scope: [],
        name: `analyzeStatusChildren:${task.id ?? 'none'}`,
        query: new QueryFilter({ match: { parent_id: task.id } }),
      }),
    [task.id],
  );
  const { data: children = [] } = useEntitiesQuery<Task>(childQuery, { enabled: isGroup && !!task.id });
  const groupHasDoneMember = children.some((c) => c.status === TaskStatus.DONE);

  const run = useCallback(async () => {
    if (busy || !task.id) return;
    setBusy(true);
    const isGroup = task.kind === TaskKind.GROUP;
    try {
      if (isGroup) {
        try {
          await dataManager.callAction(new ActionInfo('sync-group', Task.type, task.id, 'POST'));
        } catch {
          // Offline / hub unreachable — analyze the rows we have.
        }
      }
      const result = await launchWizard<AnalyzeStatusResult>('task-analyze', {
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
      });
      if (result.status === 'error') {
        notify.error({ title: 'Analyze Status failed', message: result.errorStr ?? undefined });
        onAnalyzed?.(null);
        return;
      }
      if (result.status === 'done') {
        const data = result.data ?? null;
        notify.success({
          title: isGroup ? 'Group status analyzed' : 'Task status analyzed',
          message: data?.summary,
        });
        // The persistent report link lives on the task card's analysis row
        // (the wizard stamped analysis_path); open the group report directly.
        if (isGroup && data?.analysisPath) {
          openArtifact(data.analysisPath, navigation);
        }
        onAnalyzed?.(data);
      } else {
        onAnalyzed?.(null);
      }
    } catch (e) {
      notify.error({
        title: 'Analyze Status failed',
        message: e instanceof Error ? e.message : undefined,
      });
      onAnalyzed?.(null);
    } finally {
      setBusy(false);
    }
  }, [busy, task, navigation, onAnalyzed]);

  // Hide on a group parent until a member task is done — nothing to roll up yet.
  if (isGroup && !groupHasDoneMember) return null;

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      data-testid="task-analyze-status"
      className={cn(
        'flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50',
        className,
      )}
      title="Let an agent assess progress and fill in missing fields"
    >
      <ScanSearch className="h-3.5 w-3.5" />
      {busy ? 'Analyzing…' : 'Analyze Status'}
    </button>
  );
}
