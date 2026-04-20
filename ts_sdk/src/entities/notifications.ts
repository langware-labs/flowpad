import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { ITask } from './task';

export async function sendReply(task: ITask, message: string, files?: File[]): Promise<void> {
  const action = new ActionInfo('append-conversation', 'notification', null, 'POST');
  if (files && files.length > 0) {
    const form = new FormData();
    form.append('task_id', task.id ?? '');
    form.append('message', message);
    for (const file of files) {
      form.append('files', file, file.name);
    }
    action.bodyParameters = form;
  } else {
    action.bodyParameters = { task_id: task.id, message };
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
}

export async function sendNotification(params: SendNotificationParams): Promise<{ git_error?: string | null; sent?: boolean; email_error?: string | null }> {
  const action = new ActionInfo('share_task', null, null, 'POST');
  action.bodyParameters = { sub_action: 'send', ...params };
  const res = await dataManager.callAction<undefined, { git_error?: string | null; sent?: boolean; email_error?: string | null }>(action);
  return { git_error: res?.git_error ?? null, sent: res?.sent, email_error: res?.email_error ?? null };
}

export async function refreshNotifications(projectPath?: string): Promise<void> {
  const action = new ActionInfo('refresh', 'notification', null, 'POST');
  action.bodyParameters = { project_path: projectPath ?? '' };
  await dataManager.callAction(action);
}

