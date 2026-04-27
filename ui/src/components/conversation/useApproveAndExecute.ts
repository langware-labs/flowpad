import { AgenticProcess, Conversation, dataContext, dataManager, FlowMessage, Task, TypeId } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** task_id → forked AgenticProcess (kept separate from the original session). */
const taskApprovalCache = new Map<string, AgenticProcess>();

interface UseApproveAndExecuteOptions {
  task: ITask;
}

interface UseApproveAndExecuteResult {
  /**
   * Mark the prompt attachment as approved on the backend, then run it in a
   * forked Claude Code session (rehydrating the initiator's transcript on
   * first use when needed).
   */
  approveAndExecute: (
    messageId: string,
    attachmentIndex: number,
  ) => Promise<void>;
}

async function rehydrateInitiatorSession(
  flowMessageId: string,
  conversationJsonlSubpath: string,
  projectRoot: string | undefined,
): Promise<{ session_id: string; jsonl_path: string } | null> {
  const action = new ActionInfo('rehydrate-claude-session', null, null, 'POST');
  action.bodyParameters = {
    flow_message_id: flowMessageId,
    attachment_data: conversationJsonlSubpath,
    project_root: projectRoot ?? '',
  };
  const res = await dataManager.callAction<unknown, { session_id: string; jsonl_path: string }>(action);
  return res ?? null;
}

/** Find the FlowMessage that carries the initiator's conversation.jsonl attachment. */
async function findInitiatorTranscriptMessage(task: ITask): Promise<{ messageId: string; subpath: string } | null> {
  if (!task.conversation_id) return null;
  const conv = await dataManager.getByTypeId<Conversation>(
    new TypeId(Conversation.type, task.conversation_id),
  );
  const ptrs = conv?.conversationMessageIds ?? [];
  for (const ptr of ptrs) {
    const fm = await dataManager.getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, ptr.message_id)).catch(() => null);
    if (!fm) continue;
    const att = (fm.attachment ?? []).find(
      (a) => a.attachment_type === AttachmentType.FILE && a.data.endsWith('conversation.jsonl'),
    );
    if (att) return { messageId: ptr.message_id, subpath: att.data };
  }
  return null;
}

export function useApproveAndExecute({ task }: UseApproveAndExecuteOptions): UseApproveAndExecuteResult {
  const { navigation } = useDockNavigation();

  const approveAndExecute = async (
    messageId: string,
    attachmentIndex: number,
  ) => {
    const taskId = task.id ?? '';
    if (!taskId || !messageId) return;

    // Flip approved_by on the backend, then re-fetch so we get the resolved
    // local_path / approved_by on the prompt attachment.
    const approveAction = new ActionInfo('approve-prompt', 'flow_message', messageId, 'POST');
    approveAction.bodyParameters = { attachment_index: attachmentIndex };
    await dataManager.callAction(approveAction);

    const flowMessage = await dataManager.getByTypeId<FlowMessage>(
      new TypeId(FlowMessage.type, messageId),
    ).catch(() => null);
    if (!flowMessage) return;

    const att = (flowMessage.attachment ?? [])[attachmentIndex];
    if (!att || att.attachment_type !== AttachmentType.PROMPT) return;

    // Resolve the prompt text: either inline in `data` or from the file at `local_path`.
    let promptText = '';
    if (att.data && att.data.startsWith('prompt/') && att.local_path) {
      try {
        const res = await fetch(att.local_path);
        if (res.ok) promptText = await res.text();
      } catch {
        promptText = '';
      }
      if (!promptText) promptText = `(Attached prompt file: ${att.data})`;
    } else {
      promptText = att.data ?? '';
    }

    const taskMeta = (task.metadata as Record<string, unknown> | undefined) ?? {};
    const workdir = (taskMeta.project_root as string | undefined) ?? dataContext.project?.fs_storage_mount_path;

    // Reuse cached fork if it already exists for this task.
    const cached = taskApprovalCache.get(taskId);
    if (cached) {
      await cached.executeInstruction(promptText, { sync: false });
      navigation.openDock(cached.dockPointer);
      return;
    }

    // Determine the session to fork from:
    //   - On the initiator's machine, agentic_session_id is the live original session.
    //   - On the receiver's machine, initiator_session_id is the rehydrated transcript;
    //     if absent, rehydrate from the attached conversation.jsonl now (first approve).
    let resumeSessionId = (taskMeta.agentic_session_id as string | undefined)
      ?? (taskMeta.initiator_session_id as string | undefined);

    if (!resumeSessionId) {
      const transcript = await findInitiatorTranscriptMessage(task);
      if (transcript) {
        const result = await rehydrateInitiatorSession(transcript.messageId, transcript.subpath, workdir);
        if (result?.session_id) {
          resumeSessionId = result.session_id;
          const t = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
          if (t) {
            t.metadata = { ...(t.metadata ?? {}), initiator_session_id: result.session_id };
            await t.save();
          }
        }
      }
    }

    const { process: forked } = await AgenticProcess.spawn(
      {
        workdir,
        ...(resumeSessionId ? { resumeSessionId, forkSession: true } : {}),
      },
      { instruction: promptText, visible: true },
    );
    taskApprovalCache.set(taskId, forked);
    navigation.openDock(forked.dockPointer);
  };

  return { approveAndExecute };
}
