import { useCallback } from 'react';
import { ConversationParticipant, dataContext, fsManager, Task, VFSPath } from '@sdk';
import { useSendToConversation } from '@src/hooks/use-send-to-conversation';
import { useTaskGitAttachmentFolders } from '@src/hooks/use-task-git-attachments';

/**
 * The "assign a task" notification message — the same channel as the
 * context-folder push notify: one new conversation to all recipients carrying
 * the optional text plus entity chips. Chips = the task itself + a Folder chip
 * for every git context folder referenced by the task's attachments (those
 * ride origin-only via transferMode 'git', so the recipient's chip click
 * clones the repo). LOOSE attachment files — everything outside a git context
 * folder — ride as ORDINARY message file attachments, exactly like a user
 * attaching files to any message (no task-specific bundle packing).
 */
export function useTaskAssignmentMessage(task: Task | null | undefined) {
  const { send, busy } = useSendToConversation();
  const { gitFolderTypeids, loosePaths } = useTaskGitAttachmentFolders(task);

  /** Read each loose attachment off the local VFS as a regular File. A path
   *  that can't be read (deleted/moved since attach) is skipped — the message
   *  still goes out with the rest. */
  const collectLooseFiles = useCallback(async (): Promise<File[]> => {
    const cn = dataContext.computeNodeTypeId;
    if (!cn || loosePaths.length === 0) return [];
    const files: File[] = [];
    for (const p of loosePaths) {
      try {
        const rel = VFSPath.fromMachinePath(p, cn).entitySubPath;
        if (!rel) continue;
        const blob = await fsManager.download(cn, rel, { asBlob: true });
        if (blob instanceof Blob) {
          files.push(new File([blob], p.split('/').pop() || 'attachment'));
        }
      } catch {
        // Unreadable attachment (moved/deleted) — send the rest.
      }
    }
    return files;
  }, [loosePaths]);

  const sendAssignment = useCallback(
    async (participants: ConversationParticipant[], message: string): Promise<string | null> => {
      if (!task?.id || participants.length === 0) return null;
      const chips = [task.typeId.toString(), ...gitFolderTypeids];
      const files = await collectLooseFiles();
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
          files,
          assetReferences: chips,
          sharedContextEntities: chips,
          shareConfig: { transferMode: 'git' },
        },
      );
    },
    [task, gitFolderTypeids, collectLooseFiles, send],
  );

  return { sendAssignment, sending: busy };
}
