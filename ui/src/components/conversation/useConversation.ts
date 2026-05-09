import { useMemo } from 'react';
import { Conversation, Project, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';

export interface UseConversationResult {
  conversation: Conversation | null | undefined;
  task: Task | null | undefined;
  /**
   * Local Project this conversation is filed under. Resolved from
   * `task.project_id` when a task is bound, otherwise from
   * `conversation.project_id`. `undefined` while loading; `null` when the
   * conversation hasn't been mapped to a local project yet.
   */
  project: Project | null | undefined;
  /** Sender label derived from `task.sender_name`, falling back to shared_by_id. */
  senderName?: string;
  /** Conversation entity is loaded but its task entity isn't materialised locally yet. */
  taskMissing: boolean;
}

/**
 * Resolve a Conversation by id along with its parent Task and local Project.
 * Lets any view (inbox reader, conversation route, embedded panels) drop in
 * `<ConversationPanel task={task} conversationId={...} />` without each one
 * re-implementing the same useEntity dance.
 *
 * Project semantics:
 * - Task-bound: `task.project_id` is the source of truth; the conversation
 *   mirrors it (kept in sync by `applyProjectToTask`).
 * - Task-less: `conversation.project_id` is the source of truth — set at
 *   creation (e.g. NewConversationDialog) or by the gate on first pick.
 */
export function useConversation(conversationId: string | null | undefined): UseConversationResult {
  const convTypeId = useMemo(
    () => (conversationId ? new TypeId(Conversation.type, conversationId) : null),
    [conversationId],
  );
  const { data: conversation } = useEntity<Conversation>(convTypeId);

  const taskTypeId = useMemo(
    () => conversation?.firstContextOfType?.('task') ?? null,
    [conversation],
  );
  const { data: task } = useEntity<Task>(taskTypeId);

  const projectId = task?.project_id ?? conversation?.project_id ?? undefined;
  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);

  const senderName =
    task?.sender_name ||
    task?.shared_by_id ||
    undefined;

  const taskMissing = !!taskTypeId && task === null;

  return { conversation, task, project, senderName, taskMissing };
}
