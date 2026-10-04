import { useMemo, useState } from 'react';
import { MessageSquare, User as UserIcon } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Task } from '@sdk';
import { STATUS_FAMILY_CHIP, statusLabel } from '@src/components/task-bar/constants';
import { statusFamily } from '@src/components/task-bar/task-utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { CHIP_LAYOUT } from './EntityChip';
import { isOpenTask, TaskItIcon, taskOwner } from './task-it';

/**
 * The conversation drawer's Tasks tab: every task of this conversation — made from its messages
 * ("Task it") or asked in it — open ones by default, all on request. A row opens its task; "Message"
 * selects the message it was made from.
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
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => String(b.created_date ?? '').localeCompare(String(a.created_date ?? ''))),
    [tasks],
  );
  const open = useMemo(() => sorted.filter(isOpenTask), [sorted]);
  const shown = showAll ? sorted : open;

  const filterButton = (all: boolean, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setShowAll(all)}
      aria-pressed={showAll === all}
      data-testid={`conversation-tasks-filter-${all ? 'all' : 'open'}`}
      className={cn(
        'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
        showAll === all ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label} {count}
    </button>
  );

  return (
    <div className="flex flex-col gap-2 p-2" data-testid="conversation-tasks-panel">
      <div className="flex items-center gap-1">
        {filterButton(false, t`Open`, open.length)}
        {filterButton(true, t`All`, sorted.length)}
      </div>
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
          {shown.map((task) => {
            const owner = taskOwner(task);
            return (
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
                  <span
                    className={`${CHIP_LAYOUT} ${STATUS_FAMILY_CHIP[statusFamily(task.status)]}`}
                    data-testid="conversation-task-status"
                  >
                    {statusLabel(task.status)}
                  </span>
                  {owner && (
                    <span
                      className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
                      title={t`Owner: ${owner}`}
                    >
                      <UserIcon className="h-3 w-3 shrink-0" />
                      <span className="truncate">{owner}</span>
                    </span>
                  )}
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
            );
          })}
        </ul>
      )}
    </div>
  );
}
