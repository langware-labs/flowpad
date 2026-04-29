import { useMemo } from 'react';
import { Conversation, Project, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';

export interface UseConversationResult {
  conversation: Conversation | null | undefined;
  task: Task | null | undefined;
  /**
   * Local Project the task is bound to (sender's source project, OR the
   * project the receiver mapped to via ProjectMappingDialog). Resolved from
   * `task.metadata.project_id`. `undefined` while loading; `null` when the
   * task hasn't been mapped to a local project yet (receiver pre-mapping).
   */
  project: Project | null | undefined;
  /** Sender label derived from task metadata, falling back to shared_by_id. */
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
 * - User 1 (sender): `task.metadata.project_id` is stamped at send time from
 *   `_resolve_local_project_identity(project_root)`.
 * - User 2 (receiver): unset until `ProjectMappingDialog` writes it on first
 *   click of a Claude Code action. Until then `project` is `null`.
 */
export function useConversation(conversationId: string | null | undefined): UseConversationResult {
  const convTypeId = useMemo(
    () => (conversationId ? new TypeId(Conversation.type, conversationId) : null),
    [conversationId],
  );
  const { data: conversation } = useEntity<Conversation>(convTypeId);

  const taskTypeId = useMemo(
    () => (conversation?.task_id ? new TypeId(Task.type, conversation.task_id) : null),
    [conversation?.task_id],
  );
  const { data: task } = useEntity<Task>(taskTypeId);

  const projectId = (task?.metadata as Record<string, unknown> | undefined)?.project_id as
    | string
    | undefined;
  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);

  const senderName =
    (task?.metadata as Record<string, unknown> | undefined)?.sender_name as string | undefined ||
    task?.shared_by_id ||
    undefined;

  const taskMissing = !!conversation?.task_id && task === null;

  return { conversation, task, project, senderName, taskMissing };
}
