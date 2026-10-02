import { t } from '@lingui/core/macro';
import { useMemo } from 'react';
import { dataManager, fsManager, normalizeEmail, Project, QueryRequest, Task, TypeId } from '@sdk';
import { useAuth, useEntitiesQuery } from '@sdk/react/hooks';
import { registerCommand } from '@src/notifications/commands';
import { notify } from '@src/notifications/notify';

/**
 * "Task it" — one click turns a conversation message into a task: a plain {@link Task} assigned to
 * me, pointing back at the message (`origin_conversation` / `origin_message`). The same call serves
 * the bubble's hover action and the composer's "send as task" toggle.
 */

const UNDO_COMMAND = 'task-it.undo';
/** Registered by the command bridge (it needs the router's dock navigation). */
export const OPEN_COMMAND = 'task.open';

/** The tasks made from this conversation's messages, keyed by message id. One query per conversation. */
export function useMessageTasks(conversationId: string | null | undefined): Map<string, Task> {
  const request = useMemo(
    () =>
      new QueryRequest({
        type: Task.type,
        name: `messageTasks:${conversationId ?? 'none'}`,
        query: { origin_conversation: conversationId || '__none__' },
      }),
    [conversationId],
  );
  const { data: tasks = [] } = useEntitiesQuery<Task>(request, { enabled: !!conversationId });
  return useMemo(() => {
    const byMessage = new Map<string, Task>();
    for (const task of tasks) if (task.origin_message) byMessage.set(task.origin_message, task);
    return byMessage;
  }, [tasks]);
}

/** My email — who a "Task it" task is for. */
export function useMyEmail(): string | null {
  const { cloudUser, currentUser } = useAuth();
  return normalizeEmail(cloudUser?.email || currentUser?.email) || null;
}

/** Create the task for a message, then offer Open / Undo. Returns the task (null on failure). */
export async function taskIt(
  message: { id?: string | null; text?: string | null; conversation_id?: string | null; sender_name?: string | null },
  opts: { me?: string | null; projectId?: string | null },
): Promise<Task | null> {
  try {
    const project = opts.projectId ? { typeId: new TypeId(Project.type, opts.projectId) } : null;
    const task = await Task.fromMessage(message, { me: opts.me, project });
    const typeId = task.typeId.toString();
    notify.success({
      id: `task-it-${message.id ?? typeId}`,
      title: t`Tasked: ${task.title}`,
      typeId,
      actions: [
        { label: t`Open`, command: OPEN_COMMAND, args: { typeId } },
        { label: t`Undo`, command: UNDO_COMMAND, args: { typeId } },
      ],
    });
    return task;
  } catch (err) {
    console.error('[task-it] create failed', err);
    notify.error({ title: t`Could not create the task` });
    return null;
  }
}

/** The machine's own file tree — where a task's folder (`asset_ref`, an absolute path) lives. */
const LOCAL_NODE = new TypeId('compute_node', '@local');

/**
 * Undo = the task never happened: its row AND its folder. Deleting the row alone leaves `task.md`
 * on disk (the graph delete removes only the row), and the left folder would keep the name taken
 * and come back on the next index scan.
 */
async function undoTaskIt(typeId: string): Promise<void> {
  const task = await dataManager.getByTypeId<Task>(new TypeId(typeId));
  if (!task) return;
  const folder = task.asset_ref;
  await task.delete();
  if (folder) await fsManager.delete(LOCAL_NODE, folder.replace(/^\/+/, ''));
}

registerCommand(UNDO_COMMAND, (args, ctx) => {
  if (!args.typeId) return;
  notify.dismiss(ctx.id);
  void undoTaskIt(String(args.typeId)).catch((err) => {
    console.error('[task-it] undo failed', err);
    notify.error({ title: t`Could not remove the task` });
  });
});
