import { useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { Task } from '@sdk';
import { TabbedSideDrawer } from '@src/components/ui/side-drawer';
import { useProcessesForTarget } from '@src/components/entity-chat-panel/hooks/useProcessesForTarget';
import { WorkflowRunsPanel } from '@src/components/workflows-view/WorkflowRunsPanel';
import { buildRunEntries } from './task-runs';

type TaskRunsTabId = 'runs';

interface TaskRunsDrawerProps {
  task: Task;
  computeNodeId?: string;
  className?: string;
}

/**
 * Right-side drawer hosting the headless run history for a task. Only one tab
 * (`Runs N`) — drops the Chat / Backlinks tabs you'd get from
 * `MilkdownEditorWithSidePanel` since they don't apply here.
 *
 * Process source: `useProcessesForTarget(task.typeId)` — every headless run
 * spawned via `task/<id>/run-headless` carries `target_vfs_path = task TypeId`.
 */
export function TaskRunsDrawer({ task, computeNodeId, className }: TaskRunsDrawerProps) {
  const targetKey = task.typeId?.toString();
  const { processes } = useProcessesForTarget(targetKey);

  const entries = useMemo(() => buildRunEntries(processes), [processes]);

  const [open, setOpen] = useState(true);
  const tabs = useMemo(
    () => [{ id: 'runs' as TaskRunsTabId, label: `Runs ${entries.length}`, icon: History }],
    [entries.length],
  );

  return (
    <TabbedSideDrawer<TaskRunsTabId>
      open={open}
      onOpenChange={setOpen}
      tabs={tabs}
      activeTab="runs"
      onActiveTabChange={() => {}}
      width="w-72"
      className={className}
      data-testid="task-runs-drawer"
    >
      {{
        runs: (
          <WorkflowRunsPanel
            entries={entries}
            currentEntry={entries[0] ?? null}
            computeNodeId={computeNodeId}
          />
        ),
      }}
    </TabbedSideDrawer>
  );
}
