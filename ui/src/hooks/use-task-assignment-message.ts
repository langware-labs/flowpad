import { useCallback } from 'react';
import { ConversationParticipant, Task, TypeId } from '@sdk';
import { useSendToConversation } from '@src/hooks/use-send-to-conversation';

/**
 * The "assign a task" notification message — the same channel as the
 * context-folder push notify: one new conversation to all recipients carrying
 * the optional text plus entity chips. A task never rides alone: its PARENT
 * task (the group overview for a member task) rides as its own chip too. Chips
 * = the task + its parent, both as ENTITY chips. The task's Files & Folders are
 * NOT packed into the message — they live on the task entity, so the recipient
 * sees them by opening the task chip. No file bytes or folder chips ride along.
 */
export function useTaskAssignmentMessage(task: Task | null | undefined) {
  const { send, busy, resetDraft } = useSendToConversation();

  const sendAssignment = useCallback(
    async (
      participants: ConversationParticipant[],
      message: string,
      /** Chip to feature instead of the task itself — the GROUP flow passes
       *  each recipient's own MEMBER task typeid here, so every member's
       *  message carries THEIR task, not the group overview. */
      taskChipTypeid?: string,
    ): Promise<string | null> => {
      if (!task?.id || participants.length === 0) return null;
      // Each call is a FRESH conversation — the group flow loops per member,
      // and the retry-draft cache would otherwise reuse the previous member's
      // conversation (wrong participants, wrong chip).
      resetDraft();

      // The task actually being sent — the group flow features each recipient's
      // OWN member task; otherwise it's this task. Resolve it (and its parent)
      // so the parent chip rides along as its own entity chip.
      const featuredTypeid = taskChipTypeid ?? task.typeId.toString();
      const featured = taskChipTypeid ? await Task.getById(new TypeId(taskChipTypeid).id).catch(() => null) : task;
      const parent = featured?.parent_id ? await Task.getById(featured.parent_id).catch(() => null) : null;

      const chips = Array.from(new Set([featuredTypeid, ...(parent ? [parent.typeId.toString()] : [])]));
      return send(
        {
          kind: 'new',
          params: {
            project_id: null, // cross-user bundle conversation
            participants,
            title: task.title || 'Task',
          },
        },
        {
          text: message.trim(),
          assetReferences: chips,
          sharedContextEntities: chips,
        },
      );
    },
    [task, send, resetDraft],
  );

  return { sendAssignment, sending: busy };
}
