import { AgenticProcess, dataManager, ProcessStatus, Task, TypeId } from '@sdk';
import type { ITask } from '@sdk/entities/task';
import { toast } from 'sonner';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { approveAndReload, buildMergedPrompt } from './prompt-building';

/** task_id → cached forked AgenticProcess (only valid while the worker is alive). */
const taskApprovalCache = new Map<string, AgenticProcess>();

interface UseApproveAndExecutePtyOptions {
  task: ITask;
}

interface UseApproveAndExecutePtyResult {
  /**
   * Mark the prompt attachment as approved on the backend, then run it on
   * the initiator's `shared_process_id` — which is a fork of `my_process_id`,
   * created on first approve and reused (or resumed) thereafter.
   *
   * Opens the resulting Claude PTY tab in the dock. For the headless variant
   * (output staged as a draft instead of attaching to a terminal), use
   * `useApproveAndExecuteHeadless`.
   */
  approveAndExecute: (
    messageId: string,
    attachmentIndex: number,
  ) => Promise<void>;
}

export function useApproveAndExecutePty({ task }: UseApproveAndExecutePtyOptions): UseApproveAndExecutePtyResult {
  const { navigation } = useDockNavigation();

  const approveAndExecute = async (messageId: string, attachmentIndex: number) => {
    const taskId = task.id ?? '';
    if (!taskId || !messageId) return;

    const myProcessId = task.my_process_id ?? undefined;
    if (!myProcessId) {
      toast.warning('Start Claude Code session first', {
        description: 'Click "Start Claude Code session" before approving prompts so we know which session to fork.',
      });
      return;
    }

    const flowMessage = await approveAndReload(messageId, attachmentIndex);
    if (!flowMessage) return;

    const promptText = await buildMergedPrompt(flowMessage);
    if (!promptText) {
      toast.error('Prompt is empty — nothing to execute.');
      return;
    }

    // Workdir must come from the task's own mapped project — never from the
    // global active project. The mapping gate guarantees project_root is set
    // by the time we get here.
    const workdir = task.project_root ?? undefined;
    if (!workdir) {
      toast.warning('Map this conversation to a local project first.');
      return;
    }
    const sharedProcessId = task.shared_process_id ?? undefined;

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
          navigation.openDock(existing.dockPointer);
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
            t.shared_process_id = resumed.id;
            await t.save();
          }
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
      t.shared_process_id = forked.id;
      await t.save();
    }
    navigation.openDock(forked.dockPointer);
  };

  return { approveAndExecute };
}
