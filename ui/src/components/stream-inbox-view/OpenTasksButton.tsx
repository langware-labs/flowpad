import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import { Task } from '@sdk';
import { Button } from '@src/components/ui/button';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { isOpenTask } from '@src/components/task-bar/task-utils';
import { useProjectTasks } from '@src/hooks/use-project-tasks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** Opens the task list, with the number of open tasks. Drawn only while there is one. */
export function OpenTasksButton() {
  const { navigation } = useDockNavigation();
  const { data: tasks } = useProjectTasks();
  const open = useMemo(() => tasks.filter(isOpenTask).length, [tasks]);
  const Icon = iconForType(Task.type);
  if (open === 0) return null;
  return (
    <Button
      variant="outline"
      onClick={() => navigation.openDock(DockPointer.forTasks())}
      data-testid="stream-inbox-tasks-button"
    >
      <Icon />
      <Trans>Tasks</Trans>
      <span
        className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground"
        data-testid="stream-inbox-tasks-count"
      >
        {open}
      </span>
    </Button>
  );
}
