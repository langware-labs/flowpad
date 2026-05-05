import { dataManager } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';

/**
 * Thin client for the `run-headless` action.
 *
 * The same backend handler shape is registered for two entity types
 * (`task` and `conversation`) — see `flow_sdk/app/actions/task_action.py`.
 * Both URLs accept the same body and return the same response, so the
 * client is a single function parameterised by `targetType` + `targetId`.
 *
 * The HTTP response returns immediately with `process_id` so the caller can
 * surface progress in the Runs drawer; the resulting draft surfaces in
 * `ConversationView` via the standard entity-query channel once the run
 * completes.
 */
export function useRunHeadless(
  targetType: 'task' | 'conversation',
  targetId: string | null | undefined,
): { run: (promptText: string) => Promise<string | undefined> } {
  const run = async (promptText: string): Promise<string | undefined> => {
    if (!targetId) return undefined;
    const action = new ActionInfo('run-headless', targetType, targetId, 'POST');
    action.bodyParameters = { prompt: promptText };
    const res = await dataManager.callAction<{ prompt: string }, { process_id: string }>(action);
    return res?.process_id;
  };
  return { run };
}
