import { useMemo } from 'react';
import { Conversation, ExpressionNode, QueryFilter, QueryRequest, Task, TaskKind } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { statusFamily, TaskStatus } from '@src/components/task-bar/task-utils';

export interface VibeTaskRow {
  task: Task;
  /** The conversation the task was asked in (`Task.origin_conversation`); null when none was sent
   *  (assigned to yourself). */
  conversationId: string | null;
  /** Messages waiting in that conversation — the backend's `Conversation.unread_count`. */
  unread: number;
}

/** A help task still going: not done / failed / canceled, and not archived. */
export function isOpenVibeTask(task: Task): boolean {
  return statusFamily(task.status) !== TaskStatus.DONE && !task.archived_at;
}

/**
 * What the button shows, from what the queries returned: my open help tasks, newest first, each
 * with its conversation's waiting messages, and the total. Pure — the whole selection rule.
 */
export function vibeTaskRows(
  tasks: Task[],
  conversations: Pick<Conversation, 'id' | 'unread_count'>[],
): { rows: VibeTaskRow[]; unread: number } {
  const unreadById = new Map(conversations.map((c) => [c.id, c.unread_count ?? 0]));
  const rows = openHelpTasks(tasks).map((task) => {
    const conversationId = task.origin_conversation || null;
    return { task, conversationId, unread: conversationId ? (unreadById.get(conversationId) ?? 0) : 0 };
  });
  return { rows, unread: rows.reduce((sum, row) => sum + row.unread, 0) };
}

/** Opened by me (not shared with me by someone else) and still open, newest first. */
function openHelpTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => !task.shared_by_id && isOpenVibeTask(task))
    .sort((a, b) => String(b.created_date ?? '').localeCompare(String(a.created_date ?? '')));
}

/**
 * The Vibe "Ask for help" button's state: every help task I opened from Vibe in this project that is
 * still open, each with its conversation's unread count. "Opened by me" = not one someone shared with
 * me (`shared_by_id` unset). Live: a new reply, a read, or the helper closing the task repaints it.
 */
export function useMyVibeTasks(projectId: string | null): { rows: VibeTaskRow[]; unread: number } {
  const taskRequest = useMemo(
    () =>
      new QueryRequest({
        type: Task.type,
        name: `vibeHelpTasks:${projectId ?? 'none'}`,
        query: { kind: TaskKind.VIBE, project_id: projectId || '__none__' },
      }),
    [projectId],
  );
  const { data: tasks = [] } = useEntitiesQuery<Task>(taskRequest, { enabled: !!projectId });

  const open = useMemo(() => openHelpTasks(tasks), [tasks]);
  const conversationIds = useMemo(
    () => [...new Set(open.map((task) => task.origin_conversation).filter((id): id is string => !!id))].sort(),
    [open],
  );
  const conversationRequest = useMemo(
    () =>
      new QueryRequest({
        type: Conversation.type,
        name: `vibeHelpConversations:${conversationIds.join(',')}`,
        query: new QueryFilter({ match: new ExpressionNode({ op: '$IN', operands: ['id', conversationIds] }) }),
      }),
    [conversationIds],
  );
  const { data: conversations = [] } = useEntitiesQuery<Conversation>(conversationRequest, {
    enabled: conversationIds.length > 0,
  });

  return useMemo(() => vibeTaskRows(open, conversations), [open, conversations]);
}
