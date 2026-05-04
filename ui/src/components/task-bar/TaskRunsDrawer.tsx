import { Task } from '@sdk';
import { RunsDrawer } from '@src/components/runs-drawer/RunsDrawer';

interface TaskRunsDrawerProps {
  task: Task;
  computeNodeId?: string;
  className?: string;
}

/**
 * Right-side drawer hosting the headless run history for a task.
 *
 * Thin wrapper over the generic {@link RunsDrawer} — kept so the task-bar
 * call sites (`SharedTaskView`, `TaskDetailPanel`) don't have to know how
 * to build the target typeid themselves.
 */
export function TaskRunsDrawer({ task, computeNodeId, className }: TaskRunsDrawerProps) {
  if (!task.typeId) return null;
  return (
    <RunsDrawer
      targetTypeId={task.typeId}
      computeNodeId={computeNodeId}
      className={className}
      testId="task-runs-drawer"
    />
  );
}
