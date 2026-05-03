import { dataManager } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import type { ITask } from '@sdk/entities/task';

interface UseRunHeadlessOnTaskResult {
  /** POST /task/<id>/run-headless — fires the run and returns the AgenticProcess id. */
  run: (promptText: string) => Promise<string | undefined>;
}

/**
 * Thin client for the `run-headless` task action. The backend resolves
 * `task.shared_process_id` (reuse-when-alive, otherwise spawn a fresh
 * invisible AgenticProcess), runs `promptText` via Claude print-mode, and
 * stages the assistant output as a draft FlowMessage on the task's
 * conversation.
 *
 * The HTTP response returns immediately with `process_id` so the caller can
 * surface progress in the Runs drawer; the draft surfaces in
 * `ConversationView` via the standard entity-query channel.
 */
export function useRunHeadlessOnTask(task: ITask): UseRunHeadlessOnTaskResult {
  const run = async (promptText: string): Promise<string | undefined> => {
    if (!task.id) return undefined;
    const action = new ActionInfo('run-headless', 'task', task.id, 'POST');
    action.bodyParameters = { prompt: promptText };
    const res = await dataManager.callAction<{ prompt: string }, { process_id: string }>(action);
    return res?.process_id;
  };
  return { run };
}
