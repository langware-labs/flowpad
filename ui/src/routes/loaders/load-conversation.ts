/**
 * Conversation dock loader for /dock/conversation/<conversationId>.
 *
 * Pure primitive `loadConversation(id)`:
 *   - Cache-first fetch of the Conversation entity.
 *   - If the conversation has a parent task, fetch it too (and the Project
 *     it's mapped to via task.project_id) so the page renders warm
 *     instead of flashing through "Loading task context…".
 *   - Writes `dataContext`:
 *       - CurrentProjectTypeId  — from task.project_id when known
 *       - CurrentActiveEntityTypeId — to the conversation itself
 *       - workdir              — from task.metadata.project_root when known
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
import { toast } from '@src/hooks/use-toast';
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
  if (conv.task_id) {
    task = await dataManager
      .getByTypeId<Task>(new TypeId(TaskEntity.type, conv.task_id))
      .catch(() => null);
  }

  const taskMeta = (task?.metadata as Record<string, unknown> | undefined) ?? {};
  const projectId = task?.project_id ?? undefined;
  const projectRoot = taskMeta.project_root as string | undefined;

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

  // Pointers can in principle have trailing segments; the conversation view
  // only uses the head id (matches `ConversationRoute.tsx`).
  const conversationId = pointer.split('/')[0];
  if (!conversationId) return;

  try {
    await loadConversation(conversationId);
  } catch (e) {
    if (!(e instanceof ConversationLoadError)) throw e;
    toast({
      title: 'Conversation not found',
      description: 'This conversation no longer exists.',
      variant: 'destructive',
    });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/dock/inbox');
  }
}
