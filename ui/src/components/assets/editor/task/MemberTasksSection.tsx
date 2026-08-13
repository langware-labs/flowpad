import { ActionInfo, dataManager, QueryRequest, Task, TaskKind } from '@sdk';
import { useContacts } from '@src/components/contact-picker/use-contacts';
import { statusLabel } from '@src/components/task-bar/constants';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { CheckCircle, ChevronDown, ChevronRight, Loader2, User as UserIcon, Users } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface MemberTasksSectionProps {
  /** The group overview task (kind=group). */
  task: Task;
}

/**
 * Collapsible "Member tasks" section in the group task's editor (right pane,
 * above Attachments): one row per member task with the member's name and their
 * current status. Expanding fires `sync-group` so statuses catch up (there is
 * no hub→local push for tasks); the watched query repaints rows as merges land.
 */
export function MemberTasksSection({ task }: MemberTasksSectionProps) {
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);

  const request = useMemo(
    () => new QueryRequest({ type: Task.type, query: { parent_id: task.id || '__none__' } }),
    [task.id],
  );
  const { data: members = [] } = useEntitiesQuery<Task>(request, { enabled: !!task.id });

  // Resolve assignee emails to contact display names where known.
  const { contacts } = useContacts(null, open);
  const displayName = useCallback(
    (assignee?: string | null) => {
      if (!assignee) return 'Unassigned';
      const contact = contacts.find((c) => (c.email || '').toLowerCase() === assignee.toLowerCase());
      return contact?.name || assignee;
    },
    [contacts],
  );

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Opening → opportunistic status catch-up (quiet no-op offline).
    if (next && task.id) {
      void dataManager.callAction(new ActionInfo('sync-group', Task.type, task.id, 'POST')).catch(() => undefined);
    }
  };

  if (task.kind !== TaskKind.GROUP && members.length === 0) return null;

  const done = members.filter((m) => m.status === 'done').length;

  return (
    <div className="border-b">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 px-6 py-1.5 text-start hover:bg-muted/40"
        data-testid="member-tasks-section-toggle"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Member tasks</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {done}/{members.length} done
        </span>
      </button>

      {open && (
        <div className="flex flex-col pb-2" data-testid="member-tasks-list">
          {members.length === 0 ? (
            <div className="px-6 py-2 text-sm text-muted-foreground">No member tasks yet.</div>
          ) : (
            members.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => navigation.openDock(DockPointer.forAssetEditorByTypeId('task', m.typeId))}
                className="flex items-center gap-2 px-6 py-1.5 text-start text-sm hover:bg-muted/50"
                data-testid="member-task-line"
              >
                {m.status === 'done' ? (
                  <CheckCircle className="h-3.5 w-3.5 shrink-0 text-green-500" />
                ) : m.status === 'in_progress' ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />
                ) : (
                  <UserIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{displayName(m.assignee)}</span>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
                    m.status === 'done'
                      ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                      : m.status === 'in_progress'
                        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        : 'bg-muted text-muted-foreground',
                  )}
                >
                  {statusLabel(m.status)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
