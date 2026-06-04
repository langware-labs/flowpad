/**
 * Conversation dock loader for
 * /dock/conversation/<conversationId>[/message/<messageId>].
 *
 * The optional `/message/<id>` deep-link segment is view-level state — the
 * route component derives the selected bubble from `currentDock` and scrolls
 * it into view; the loader only resolves the conversation (head segment).
 *
 * Pure primitive `loadConversation(id)`:
 *   - Cache-first fetch of the Conversation entity.
 *   - If the conversation has a parent task, fetch it too (and the Project
 *     it's mapped to via task.project_id) so the page renders warm
 *     instead of flashing through "Loading task context…".
 *   - Writes `dataContext`:
 *       - CurrentProjectTypeId  — from task.project_id, or conv.project_id
 *                                 when there's no task
 *       - CurrentActiveEntityTypeId — to the conversation itself
 *       - workdir              — from task.project_root when known
 *
 * Wrapper `loadConversationRoute(pointer)` is the URL-aware shell. Mirrors
 * the load-shell / load-project two-layer split: the primitive doesn't know
 * about URLs and only throws typed errors; the wrapper translates failures
 * into redirects + toasts.
 */

import {
  type Conversation,
  ContextEntitiesEnum,
  dataContext,
  dataManager,
  Project,
  type Task,
  TypeId,
} from '@sdk';
import { Conversation as ConversationEntity, Task as TaskEntity } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { notify } from '@src/notifications';
import { redirect } from 'react-router';

export class ConversationLoadError extends Error {
  constructor(
    readonly kind: 'not_found',
    readonly conversationId: string,
  ) {
    super(`conversation-load:${kind}`);
  }
}

/**
 * Pure primitive — fetch the Conversation, parent Task, and Project; write
 * dataContext. Throws `ConversationLoadError` on a hard failure. Best-effort
 * for parent fetches: a missing task or project doesn't fail the conversation
 * load (the page can still render the conversation without those).
 */
export async function loadConversation(conversationId: string): Promise<Conversation> {
  const conv = await dataManager
    .getByTypeId<Conversation>(new TypeId(ConversationEntity.type, conversationId))
    .catch(() => null);
  if (!conv) {
    throw new ConversationLoadError('not_found', conversationId);
  }

  // Parent task — best-effort. Project-scoped conversations don't have one.
  let task: Task | null = null;
  const taskTypeId = conv.firstContextOfType('task');
  if (taskTypeId) {
    task = await dataManager.getByTypeId<Task>(taskTypeId).catch(() => null);
  }

  // Task wins when present (it owns project_root for cwd). Otherwise fall
  // through to the conversation's own project_id — task-less conversations
  // (project-scoped chats, hub-direct convs) carry their mapping there. Without
  // this fallback, refreshing a task-less conversation drops ctx.project to
  // null and the StatusBar renders the red "Select Project" pill even though
  // the conversation already knows which local Project it belongs to.
  const projectId = task?.project_id ?? conv.project_id ?? undefined;
  const projectRoot = task?.project_root ?? undefined;

  // Active entity = the conversation. Same pattern as the session view's
  // setActiveEntity for AgenticProcess.
  await dataContext.setActiveEntityTypeId(new TypeId(ConversationEntity.type, conversationId));

  if (projectId) {
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId(Project.type, projectId),
    );
    // Prefetch the Project entity into the cache so the footer label / any
    // useEntity(Project, …) read in the page is warm on first paint.
    await dataManager
      .getByTypeId<Project>(new TypeId(Project.type, projectId))
      .catch(() => null);
  } else {
    // Conversation has no mapped project (receiver pre-mapping, or
    // project-scoped conversation that lost its project). Drop the global
    // active project to null — the StatusBar will render the red
    // "Select Project" pill until the user picks one (via the gate dialog
    // or the footer's Switch Project button).
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      null,
    );
  }

  if (projectRoot) {
    dataContext.setWorkdir(projectRoot);
  }

  return conv;
}

/**
 * Route-level loader for /dock/conversation/<id>. Owns redirect policy.
 * Delegates the actual work to `loadConversation`.
 */
export async function loadConversationRoute(pointer: string | undefined): Promise<void> {
  if (!pointer) {
    // No conversation id — page renders its empty state ("No conversation
    // specified."). Nothing to load.
    return;
  }

  // Trailing segments (e.g. `/message/<id>`) are view-level deep-link state;
  // the loader only needs the head id. Same parser as `ConversationRoute.tsx`
  // so the pointer grammar lives in exactly one place.
  const { conversationId } = DockPointer.parseConversationPointer(pointer);
  if (!conversationId) return;

  try {
    await loadConversation(conversationId);
  } catch (e) {
    if (!(e instanceof ConversationLoadError)) throw e;
    notify.error({
      title: 'Conversation not found',
      message: 'This conversation no longer exists.',
    });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/dock/inbox');
  }
}
