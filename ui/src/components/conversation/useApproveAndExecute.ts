import { AgenticProcess, dataManager, FlowMessage, ProcessStatus, Task, TypeId } from '@sdk';
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

/**
 * Merge every PROMPT attachment on a message into one instruction. Inline
 * text comes first (whatever the user typed in the dialog), followed by each
 * file's contents under a labelled section. Lets a "type some prompt + drop
 * a file" reply run as a single Claude turn instead of N sequential ones.
 */
async function buildMergedPrompt(flowMessage: FlowMessage): Promise<string> {
  const promptAtts = (flowMessage.attachment ?? []).filter(
    (a) => a.attachment_type === AttachmentType.PROMPT,
  );
  const inlineParts: string[] = [];
  const filePromptParts: string[] = [];

  for (const att of promptAtts) {
    const isFile = !!att.data && att.data.startsWith('prompt/');
    const text = await resolvePromptText(att);
    if (!text) continue;
    if (isFile) {
      const filename = att.data.split('/').pop() ?? att.data;
      filePromptParts.push(`--- ${filename} ---\n${text}`);
    } else {
      inlineParts.push(text);
    }
  }

  return [...inlineParts, ...filePromptParts].join('\n\n');
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

    // Approve every PROMPT attachment on the message in one shot, then re-fetch
    // so we can read the resolved local_path / approved_by on each.
    const approveAction = new ActionInfo('approve-prompt', 'flow_message', messageId, 'POST');
    approveAction.bodyParameters = { attachment_index: attachmentIndex, approve_all: true };
    await dataManager.callAction(approveAction);

    const flowMessage = await dataManager
      .getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, messageId))
      .catch(() => null);
    if (!flowMessage) return;

    // Merge text + file PROMPT attachments into a single instruction so the
    // recipient's typed prompt and any attached prompt files run as one turn.
    const promptText = await buildMergedPrompt(flowMessage);
    if (!promptText) {
      toast.error('Prompt is empty — nothing to execute.');
      return;
    }

    // Workdir must come from the task's own mapped project — never from the
    // global active project. The mapping gate guarantees project_root is set
    // by the time we get here.
    const workdir = taskMeta.project_root as string | undefined;
    if (!workdir) {
      toast.warning('Map this conversation to a local project first.');
      return;
    }
    const sharedProcessId = taskMeta.shared_process_id as string | undefined;

    // Subsequent Approve & Execute on the same task. Always re-resolve the
    // AgenticProcess from the DB and re-check liveness — the in-memory cache
    // held by the conversation tab can be stale, and the cached PTY client
    // can be silently dropped while the user was in the shell tab. The bug
    // we hit ("second approve just resumes the session without running the
    // new prompt") was the fast-path executeInstruction firing into a closed
    // PTY: navigation succeeded, the write went nowhere.
    if (sharedProcessId) {
      const existing = await dataManager
        .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, sharedProcessId))
        .catch(() => null);
      if (existing) {
        const isAlive = existing.status !== ProcessStatus.STOPPED
          && existing.status !== ProcessStatus.FAILED
          && existing.status !== ProcessStatus.STOPPING;
        if (isAlive) {
          // Reattach + inject in one call. start({ instruction }) handles both
          // "PTY still connected" and "PTY client was dropped between turns",
          // unlike executeInstruction which silently no-ops on a closed PTY.
          await existing.start({ instruction: promptText });
          taskApprovalCache.set(taskId, existing);
          navigation.openInBrowserTab(existing.dockPointer);
          return;
        }
        if (existing.session_id) {
          // Worker stopped after the previous turn — spawn-resume the same
          // session (no forkSession) and bake the new prompt into the first
          // message of the resumed worker.
          const { process: resumed } = await AgenticProcess.spawn(
            { workdir, resumeSessionId: existing.session_id },
            { instruction: promptText, visible: true },
          );
          taskApprovalCache.set(taskId, resumed);
          // spawn returns a new AgenticProcess entity — track it so subsequent
          // approves resolve the right id from task metadata.
          const t = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId));
          if (t) {
            t.metadata = { ...(t.metadata ?? {}), shared_process_id: resumed.id };
            await t.save();
          }
          navigation.openInBrowserTab(resumed.dockPointer);
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
    navigation.openInBrowserTab(forked.dockPointer);
  };

  return { approveAndExecute };
}
