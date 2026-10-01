import { useMemo } from 'react';
import { Conversation, normalizeEmail, QueryRequest, Task, TaskKind } from '@sdk';
import { useAuth, useEntitiesQuery } from '@sdk/react/hooks';
import { useEntityBatch } from '@src/components/entity-batch/EntityBatchHydrator';
import { isTaskArchived } from '@src/components/task-bar/constants';
import { statusFamily, TaskStatus } from '@src/components/task-bar/task-utils';

export interface VibeTaskRow {
  task: Task;
  /** The conversation the task was asked in (`Task.origin_conversation`); null when none was sent
   *  (assigned to yourself). */
  conversationId: string | null;
  /** Messages waiting in that conversation — the backend's `Conversation.unread_count`. */
  unread: number;
}

/**
 * My open help tasks, newest first: still going (not done / failed / canceled, not archived) and
 * opened by me. "Opened by me" is the task's `reporter` — assigning stamps the asker's email there —
 * so the helper's received copy (reporter unset, assignee = them) is never listed on their button.
 */
export function openHelpTasks(tasks: Task[], myEmail: string | null): Task[] {
  return tasks
    .filter(
      (task) =>
        !!myEmail &&
        normalizeEmail(task.reporter) === myEmail &&
        statusFamily(task.status) !== TaskStatus.DONE &&
        !isTaskArchived(task),
    )
    .sort((a, b) => String(b.created_date ?? '').localeCompare(String(a.created_date ?? '')));
}

/** Each open task with its conversation's waiting messages, and the total — what the button shows. */
export function vibeTaskRows(
  open: Task[],
  conversations: Pick<Conversation, 'id' | 'unread_count'>[],
): { rows: VibeTaskRow[]; unread: number } {
  const unreadById = new Map(conversations.map((c) => [c.id, c.unread_count ?? 0]));
  const rows = open.map((task) => {
    const conversationId = task.origin_conversation || null;
    return { task, conversationId, unread: conversationId ? (unreadById.get(conversationId) ?? 0) : 0 };
  });
  return { rows, unread: rows.reduce((sum, row) => sum + row.unread, 0) };
}

/**
 * The Vibe "Ask for help" button's state: every help task I opened from Vibe in this project that is
 * still open, each with its conversation's unread count. Live: a new reply, a read, or the helper
 * closing the task repaints it.
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
  const { cloudUser, currentUser } = useAuth();
  const myEmail = normalizeEmail(cloudUser?.email || currentUser?.email);

  const open = useMemo(() => openHelpTasks(tasks, myEmail), [tasks, myEmail]);
  const conversationIds = useMemo(
    () => open.map((task) => task.origin_conversation).filter((id): id is string => !!id),
    [open],
  );
  const conversations = useEntityBatch<Conversation>(Conversation.type, conversationIds);

  return useMemo(() => vibeTaskRows(open, conversations), [open, conversations]);
}
