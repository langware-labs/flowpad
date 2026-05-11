import type { ITask } from '@sdk/entities/task';
import { toast } from 'sonner';
import { approveAndReload, buildMergedPrompt } from './prompt-building';
import { useRunHeadless } from './useRunHeadless';

interface UseApproveAndExecuteHeadlessOptions {
  /** Task to scope the headless run to. Pass an inert task (`{id: '', metadata: {}}`)
   * for task-less hub-direct conversations; in that case `conversationId` is used. */
  task: ITask;
  /** Required when `task.id` is empty — drives the conversation-scoped variant. */
  conversationId?: string | null;
}

interface UseApproveAndExecuteHeadlessResult {
  /**
   * Mark the prompt attachment(s) as approved, then run them invisibly via
   * either `task/<id>/run-headless` or `conversation/<id>/run-headless`
   * depending on which scope is available.
   *
   * No PTY tab navigation — the Runs drawer surfaces progress and the draft
   * surfaces in `ConversationView` for the user to edit / send.
   */
  approveAndExecute: (
    messageId: string,
    attachmentIndex: number,
  ) => Promise<void>;
}

export function useApproveAndExecuteHeadless(
  { task, conversationId }: UseApproveAndExecuteHeadlessOptions,
): UseApproveAndExecuteHeadlessResult {
  const useTaskScope = !!task.id;
  // One hook, two scopes — the URL is `task/<id>/run-headless` or
  // `conversation/<id>/run-headless` depending on which scope wins below.
  const { run: runOnTask } = useRunHeadless('task', task.id || null);
  const { run: runOnConversation } = useRunHeadless('conversation', conversationId ?? null);

  const approveAndExecute = async (messageId: string, attachmentIndex: number) => {
    if (!messageId) return;
    if (!useTaskScope && !conversationId) return;

    // Project gate: tasks expose project_root directly; conversation-scoped
    // runs resolve their workdir server-side from Conversation.project_id.
    // We still surface the same toast when the local project mapping is
    // missing, but the conversation path delegates the actual check.
    if (useTaskScope) {
      const workdir = task.project_root ?? undefined;
      if (!workdir) {
        toast.warning('Map this conversation to a local project first.');
        return;
      }
    }

    const flowMessage = await approveAndReload(messageId, attachmentIndex);
    if (!flowMessage) return;

    const promptText = await buildMergedPrompt(flowMessage);
    if (!promptText) {
      toast.error('Prompt is empty — nothing to execute.');
      return;
    }

    try {
      if (useTaskScope) {
        await runOnTask(promptText);
      } else {
        await runOnConversation(promptText);
      }
    } catch (err) {
      console.error('[useApproveAndExecuteHeadless] run-headless failed', err);
      toast.error('Failed to run prompt headlessly.');
    }
  };

  return { approveAndExecute };
}
