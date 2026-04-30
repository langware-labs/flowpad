import type { ITask } from '@sdk/entities/task';
import { toast } from 'sonner';
import { approveAndReload, buildMergedPrompt } from './prompt-building';
import { useRunHeadlessOnTask } from './useRunHeadlessOnTask';

interface UseApproveAndExecuteHeadlessOptions {
  task: ITask;
}

interface UseApproveAndExecuteHeadlessResult {
  /**
   * Mark the prompt attachment(s) as approved, then run them invisibly via
   * `task/<id>/run-headless`. Backend handles process resolution
   * (reuse-when-alive `task.shared_process_id`, otherwise spawn a fresh
   * invisible AgenticProcess) and stages the assistant output as a draft
   * FlowMessage on the task's conversation.
   *
   * No PTY tab navigation — the Runs drawer surfaces progress and the draft
   * surfaces in `ConversationView` for the user to edit / send.
   */
  approveAndExecute: (
    messageId: string,
    attachmentIndex: number,
  ) => Promise<void>;
}

export function useApproveAndExecuteHeadless({ task }: UseApproveAndExecuteHeadlessOptions): UseApproveAndExecuteHeadlessResult {
  const { run } = useRunHeadlessOnTask(task);

  const approveAndExecute = async (messageId: string, attachmentIndex: number) => {
    if (!task.id || !messageId) return;

    const workdir = task.project_root ?? undefined;
    if (!workdir) {
      toast.warning('Map this conversation to a local project first.');
      return;
    }

    const flowMessage = await approveAndReload(messageId, attachmentIndex);
    if (!flowMessage) return;

    const promptText = await buildMergedPrompt(flowMessage);
    if (!promptText) {
      toast.error('Prompt is empty — nothing to execute.');
      return;
    }

    try {
      await run(promptText);
    } catch (err) {
      console.error('[useApproveAndExecuteHeadless] run-headless failed', err);
      toast.error('Failed to run prompt headlessly.');
    }
  };

  return { approveAndExecute };
}
