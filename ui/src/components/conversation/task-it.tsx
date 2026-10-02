import { t } from '@lingui/core/macro';
import { useMemo } from 'react';
import { dataManager, fsManager, Project, QueryRequest, Task, TypeId, type TaskableMessage } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { DockPointer } from '@src/navigation/DockPointer';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { registerCommand } from '@src/notifications/commands';
import { notify } from '@src/notifications/notify';

/**
 * "Task it" — one click turns a conversation message into a task: a plain {@link Task} assigned to
 * me, pointing back at the message (`origin_conversation` / `origin_message`). The same call serves
 * the bubble's hover action and the composer's "send as task" toggle.
 */

const UNDO_COMMAND = 'task-it.undo';
const NO_TASKS: Task[] = [];
/** Messages whose task is being created right now. The server answers a repeat create with the
 *  first task, but only once that task is saved; a double click lands inside the save. */
const inFlight = new Set<string>();

/** The control's tooltip, shared by the bubble and the composer. */
export const taskItHint = () => t`Task it — make this message a task`;

/** The Task type's own glyph (`TaskInfo.icon`), resolved only where the control renders. */
export function TaskItIcon({ className }: { className?: string }) {
  const Glyph = iconForType(Task.type);
  return <Glyph className={className} />;
}

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
  const { data: tasks = NO_TASKS } = useEntitiesQuery<Task>(request, { enabled: !!conversationId });
  return useMemo(() => {
    const byMessage = new Map<string, Task>();
    for (const task of tasks) if (task.origin_message) byMessage.set(task.origin_message, task);
    return byMessage;
  }, [tasks]);
}

/** Create the task for a message, then offer Open / Undo. */
export async function taskIt(
  message: TaskableMessage,
  opts: { me?: string | null; projectId?: string | null },
): Promise<void> {
  const key = message.id ?? '';
  if (key && inFlight.has(key)) return;
  if (key) inFlight.add(key);
  try {
    const project = opts.projectId ? { typeId: new TypeId(Project.type, opts.projectId) } : null;
    const task = await Task.fromMessage(message, { me: opts.me, project });
    const typeId = task.typeId.toString();
    notify.success({
      id: `task-it-${message.id ?? typeId}`,
      title: t`Tasked: ${task.title}`,
      typeId,
      actions: [
        { label: t`Open`, href: DockPointer.forAssetEditorByTypeId(Task.type, task.typeId).toUrl() },
        { label: t`Undo`, command: UNDO_COMMAND, args: { typeId } },
      ],
    });
  } catch (err) {
    console.error('[task-it] create failed', err);
    notify.error({ title: t`Could not create the task` });
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Undo = the task never happened: its row AND its folder. Deleting the row alone leaves `task.md`
 * on disk (the graph delete removes only the row — a workaround until it removes the carrier), and
 * the left folder would keep the name taken and come back on the next index scan.
 */
async function undoTaskIt(typeId: string): Promise<void> {
  const task = await dataManager.getByTypeId<Task>(new TypeId(typeId));
  if (!task) return;
  const folder = task.asset_ref;
  await task.delete();
  if (folder) await fsManager.delete(LOCAL_COMPUTE_NODE, folder.replace(/^\/+/, ''));
}

registerCommand(UNDO_COMMAND, (args, ctx) => {
  if (!args.typeId) return;
  notify.dismiss(ctx.id);
  void undoTaskIt(String(args.typeId)).catch((err) => {
    console.error('[task-it] undo failed', err);
    notify.error({ title: t`Could not remove the task` });
  });
});
