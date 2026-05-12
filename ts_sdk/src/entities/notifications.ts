import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { ITask } from './task';

export interface SendReplyExtras {
  /** Inline prompt text to attach as a PROMPT attachment. */
  promptText?: string;
  /** Files to attach as PROMPT attachments (each stored under prompt/<filename>). */
  promptFiles?: File[];
  /** TypeId strings (e.g. "skill-<uuid>") to attach as TYPE_ID attachments. */
  assetReferences?: string[];
}

export interface SendReplyTarget {
  /** Task-bound reply (legacy; triggers hub push + git commit). */
  task?: ITask | null;
  /** Project-scoped conversation reply (local-only). */
  conversationId?: string | null;
}

export async function sendReply(
  target: SendReplyTarget | ITask,
  message: string,
  files?: File[],
  extras?: SendReplyExtras,
): Promise<void> {
  // Back-compat: callers that pass a Task directly still work.
  const t: SendReplyTarget =
    target && typeof target === 'object' && ('task' in target || 'conversationId' in target)
      ? (target as SendReplyTarget)
      : { task: target as ITask };

  const taskId = t.task?.id ?? null;
  const conversationId = t.conversationId ?? null;

  const action = new ActionInfo('append-conversation', 'notification', null, 'POST');
  const hasAssetRefs = !!(extras?.assetReferences && extras.assetReferences.length > 0);
  const hasFiles =
    (files && files.length > 0) ||
    (extras?.promptFiles && extras.promptFiles.length > 0) ||
    hasAssetRefs;
  if (hasFiles) {
    const form = new FormData();
    if (taskId) form.append('task_id', taskId);
    if (conversationId) form.append('conversation_id', conversationId);
    form.append('message', message);
    if (extras?.promptText) form.append('prompt_text', extras.promptText);
    for (const file of files ?? []) {
      form.append('files', file, file.name);
    }
    for (const file of extras?.promptFiles ?? []) {
      form.append('prompt_files', file, file.name);
    }
    if (hasAssetRefs) {
      form.append('asset_references', JSON.stringify(extras!.assetReferences));
    }
    action.bodyParameters = form;
  } else {
    const body: Record<string, string> = { message };
    if (taskId) body.task_id = taskId;
    if (conversationId) body.conversation_id = conversationId;
    if (extras?.promptText) body.prompt_text = extras.promptText;
    action.bodyParameters = body;
  }
  await dataManager.callAction(action);
}

export interface SendNotificationParams {
  recipient_id: string;
  spec_title: string;
  spec_content: string;
  spec_type: string;
  task_title: string;
  task_id?: string | null;
  message?: string | null;
  plan_id?: string | null;
  project_path?: string | null;
  team_space_id?: string | null;
  sender_name?: string | null;
  files?: File[];
  /** Sender's clean AgenticProcess id — stamped on the *sender's* task as `task.my_process_id` so the per-message Open chip is wired immediately. Receiver-side materialisation strips it. */
  sender_process_id?: string | null;
  /** Pre-forked AgenticProcess id (Scenario C). Stamped on the new Task as `shared_process_id` so the recipient's first Approve & Execute reuses the existing fork instead of spawning a fresh process. */
  forked_process_id?: string | null;
  /** When false, skips creating a hub-side Invitation (no "Accept" button on the recipient's strip). Use for shares to known collaborators where the FlowMessage `grant_role` is enough — e.g. Scenario C (PTY ask-for-assistance). Defaults to true (Scenarios A/B). */
  is_initial_share?: boolean;
}

export async function sendNotification(params: SendNotificationParams): Promise<{ git_error?: string | null; sent?: boolean; email_error?: string | null }> {
  const action = new ActionInfo('share_task', null, null, 'POST');
  const { files, ...rest } = params;
  if (files && files.length > 0) {
    const form = new FormData();
    form.append('sub_action', 'send');
    for (const [key, value] of Object.entries(rest)) {
      if (value != null) form.append(key, String(value));
    }
    for (const file of files) {
      form.append('files', file, file.name);
    }
    action.bodyParameters = form;
  } else {
    action.bodyParameters = { sub_action: 'send', ...rest };
  }
  const res = await dataManager.callAction<undefined, { git_error?: string | null; sent?: boolean; email_error?: string | null }>(action);
  return { git_error: res?.git_error ?? null, sent: res?.sent, email_error: res?.email_error ?? null };
}

export async function refreshNotifications(projectPath?: string): Promise<void> {
  const action = new ActionInfo('refresh', 'notification', null, 'POST');
  action.bodyParameters = { project_path: projectPath ?? '' };
  await dataManager.callAction(action);
}

