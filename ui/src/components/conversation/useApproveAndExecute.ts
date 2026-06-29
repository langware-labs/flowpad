import { dataManager } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';

interface UseApproveAndExecuteResult {
  /**
   * Execute a received prompt. Backend-owned: the `execute-prompt` action
   * approves the prompt, spawns/reuses a headless process, runs it, captures
   * the assistant reply, and saves it as a DRAFT — or SENDS it when
   * `autoReply` is true. The manual click and the auto-on-receive path
   * (`process_inbound_message`) converge on the same backend entrypoint
   * (`execute_prompt_from_message`), so this is just the trigger.
   */
  executePrompt: (messageId: string, opts?: { autoReply?: boolean }) => Promise<void>;
}

/**
 * Thin trigger for backend prompt execution. The heavy orchestration that used
 * to live here (spawn headless AgenticProcess → captureTurn stream → draft) now
 * runs server-side in `flow_sdk/app/actions/execute_prompt.py`. UI feedback is
 * unchanged: the spawned process surfaces in the Runs panel via data_ops, and
 * the reply lands in the conversation as a draft (or a sent message).
 */
export function useApproveAndExecute(): UseApproveAndExecuteResult {
  const executePrompt = async (messageId: string, opts?: { autoReply?: boolean }) => {
    if (!messageId) return;
    const action = new ActionInfo('execute-prompt', 'flow_message', messageId, 'POST');
    action.bodyParameters = { auto_reply: !!opts?.autoReply };
    await dataManager.callAction(action);
  };

  return { executePrompt };
}
