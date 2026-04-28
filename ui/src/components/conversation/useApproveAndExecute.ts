import { AgenticProcess, dataContext, dataManager, FlowMessage, ProcessStatus, Task, TypeId } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { toast } from 'sonner';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** task_id → cached forked AgenticProcess (only valid while the worker is alive). */
const taskApprovalCache = new Map<string, AgenticProcess>();

interface UseApproveAndExecuteOptions {
  task: ITask;
}

interface UseApproveAndExecuteResult {
  /**
   * Mark the prompt attachment as approved on the backend, then run it on
   * the initiator's `shared_process_id` — which is a fork of `my_process_id`,
   * created on first approve and reused (or resumed) thereafter.
   */
  approveAndExecute: (
    messageId: string,
    attachmentIndex: number,
  ) => Promise<void>;
}

async function resolvePromptText(att: { data: string; local_path?: string | null }): Promise<string> {
  if (att.data && att.data.startsWith('prompt/') && att.local_path) {
    try {
      const res = await fetch(att.local_path);
      if (res.ok) return await res.text();
    } catch {
      // fall through
    }
    return `(Attached prompt file: ${att.data})`;
  }
  return att.data ?? '';
}

export function useApproveAndExecute({ task }: UseApproveAndExecuteOptions): UseApproveAndExecuteResult {
  const { navigation } = useDockNavigation();

  const approveAndExecute = async (messageId: string, attachmentIndex: number) => {
    const taskId = task.id ?? '';
    if (!taskId || !messageId) return;

    const taskMeta = (task.metadata as Record<string, unknown> | undefined) ?? {};
    const myProcessId = taskMeta.my_process_id as string | undefined;
    if (!myProcessId) {
      toast.warning('Start Claude Code session first', {
        description: 'Click "Start Claude Code session" before approving prompts so we know which session to fork.',
      });
      return;
    }

    // Flip approved_by, then re-fetch so we can read the resolved local_path / approved_by.
    const approveAction = new ActionInfo('approve-prompt', 'flow_message', messageId, 'POST');
    approveAction.bodyParameters = { attachment_index: attachmentIndex };
    await dataManager.callAction(approveAction);

    const flowMessage = await dataManager
      .getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, messageId))
      .catch(() => null);
    if (!flowMessage) return;

    const att = (flowMessage.attachment ?? [])[attachmentIndex];
    if (!att || att.attachment_type !== AttachmentType.PROMPT) return;
    const promptText = await resolvePromptText(att);
    if (!promptText) {
      toast.error('Prompt is empty — nothing to execute.');
      return;
    }

    const workdir = (taskMeta.project_root as string | undefined) ?? dataContext.project?.fs_storage_mount_path;
    const sharedProcessId = taskMeta.shared_process_id as string | undefined;

    // Subsequent calls — reuse the cached fork if alive, otherwise resume it.
    if (sharedProcessId) {
      const cached = taskApprovalCache.get(taskId);
      if (cached) {
        await cached.executeInstruction(promptText, { sync: false });
        navigation.openDock(cached.dockPointer);
        return;
      }
      const existing = await dataManager
        .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, sharedProcessId))
        .catch(() => null);
      if (existing) {
        const isAlive = existing.status !== ProcessStatus.STOPPED
          && existing.status !== ProcessStatus.FAILED
          && existing.status !== ProcessStatus.STOPPING;
        if (isAlive) {
          await existing.start({ instruction: promptText });
          taskApprovalCache.set(taskId, existing);
          navigation.openDock(existing.dockPointer);
          return;
        }
        if (existing.session_id) {
          const { process: resumed } = await AgenticProcess.spawn(
            { workdir, resumeSessionId: existing.session_id },
            { instruction: promptText, visible: true },
          );
          taskApprovalCache.set(taskId, resumed);
          navigation.openDock(resumed.dockPointer);
          return;
        }
      }
    }

    // First approve for this task — fork from my_process_id's session.
    const myProcess = await dataManager
      .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, myProcessId))
      .catch(() => null);
    if (!myProcess?.session_id) {
      toast.error('Could not find your Claude Code session to fork from. Try opening it first.');
      return;
    }
    const { process: forked } = await AgenticProcess.spawn(
      { workdir, resumeSessionId: myProcess.session_id, forkSession: true },
      { instruction: promptText, visible: true },
    );
    taskApprovalCache.set(taskId, forked);
    const t = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
    if (t) {
      t.metadata = { ...(t.metadata ?? {}), shared_process_id: forked.id };
      await t.save();
    }
    navigation.openDock(forked.dockPointer);
  };

  return { approveAndExecute };
}
