import { useMemo, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Task } from '@sdk';
import { byNewestTask, isOpenTask } from '@src/components/task-bar/task-utils';
import { ScopeBar } from '@src/components/ui/scope-bar';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { TaskItIcon, TaskOwnerChip, TaskStatusChip } from './task-it';

type TaskFilter = 'open' | 'all';

/**
 * The conversation drawer's Tasks tab: every task of this conversation, open ones by default, all
 * on request. A row opens its task; "Message" selects the message it was made from.
 */
export function ConversationTasksPanel({
  tasks,
  onShowMessage,
}: {
  tasks: Task[];
  /** Select a message in the conversation (the one a task was made from). */
  onShowMessage?: (messageId: string) => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [filter, setFilter] = useState<TaskFilter>('open');

  const sorted = useMemo(() => [...tasks].sort(byNewestTask), [tasks]);
  const open = sorted.filter(isOpenTask);
  const shown = filter === 'all' ? sorted : open;

  return (
    <div className="flex flex-col gap-2 p-2" data-testid="conversation-tasks-panel">
      <ScopeBar<TaskFilter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'open', label: t`Open`, count: open.length },
          { value: 'all', label: t`All`, count: sorted.length },
        ]}
      />
      {shown.length === 0 ? (
        <p className="px-1 text-xs italic text-muted-foreground/70">
          {sorted.length === 0 ? (
            <Trans>No tasks yet — "Task it" on a message makes one.</Trans>
          ) : (
            <Trans>No open tasks.</Trans>
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((task) => (
            <li key={task.id} className="rounded-md border border-border/60 p-2" data-testid="conversation-task-row">
              <button
                type="button"
                onClick={() => navigation.openDock(task.dockPointer)}
                className="flex w-full items-start gap-1.5 text-start text-xs font-medium text-foreground hover:underline"
                title={t`Open task`}
              >
                <TaskItIcon className="mt-0.5 h-3 w-3 shrink-0 text-violet-500" />
                <span className="min-w-0 flex-1 break-words">{task.title || t`Task`}</span>
              </button>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <TaskStatusChip status={task.status} />
                <TaskOwnerChip task={task} />
                {task.origin_message && onShowMessage && (
                  <button
                    type="button"
                    onClick={() => onShowMessage(task.origin_message!)}
                    className="ms-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    title={t`Show the message it was made from`}
                    data-testid="conversation-task-message"
                  >
                    <MessageSquare className="h-3 w-3" />
                    <Trans>Message</Trans>
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
