import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { ITask } from './task';

export interface SendReplyExtras {
  /** Inline prompt text to attach as a PROMPT attachment. */
  promptText?: string;
  /** Files to attach as PROMPT attachments (each stored under prompt/<filename>). */
  promptFiles?: File[];
}

export async function sendReply(
  task: ITask,
  message: string,
  files?: File[],
  extras?: SendReplyExtras,
): Promise<void> {
  const action = new ActionInfo('append-conversation', 'notification', null, 'POST');
  const hasFiles = (files && files.length > 0) || (extras?.promptFiles && extras.promptFiles.length > 0);
  if (hasFiles) {
    const form = new FormData();
    form.append('task_id', task.id ?? '');
    form.append('message', message);
    if (extras?.promptText) form.append('prompt_text', extras.promptText);
    for (const file of files ?? []) {
      form.append('files', file, file.name);
    }
    for (const file of extras?.promptFiles ?? []) {
      form.append('prompt_files', file, file.name);
    }
    action.bodyParameters = form;
  } else {
    action.bodyParameters = { task_id: task.id, message, ...(extras?.promptText ? { prompt_text: extras.promptText } : {}) };
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
  /** Sender's clean AgenticProcess id — stamped on the *sender's* task as task.metadata.my_process_id so the per-message Open chip is wired immediately. Receiver-side materialisation strips it. */
  sender_process_id?: string | null;
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

