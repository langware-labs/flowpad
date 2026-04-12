import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { ITask } from './task';

export async function openTaskNotification(
  projectUrl: string,
  taskId: string,
): Promise<{ navigation_path: string; git_error?: string | null }> {
  const action = new ActionInfo('open-task', 'notification', null, 'POST');
  action.bodyParameters = { project_url: projectUrl, task_id: taskId };
  const res = await dataManager.callAction<undefined, { navigation_path: string; git_error?: string | null }>(action);
  return {
    navigation_path: res?.navigation_path ?? (taskId ? `/dock/tasks/task-${taskId}` : '/dock/tasks'),
    git_error: res?.git_error ?? null,
  };
}

export async function sendReply(task: ITask, message: string): Promise<void> {
  const action = new ActionInfo('send', 'notification', null, 'POST');
  action.bodyParameters = {
    recipient_id: task.shared_by_id ?? '',
    spec_title: task.title ?? 'Re: task',
    spec_content: message,
    spec_type: 'support_ticket',
    task_title: task.title ?? 'Re: task',
    message,
  };
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
}

export async function sendNotification(params: SendNotificationParams): Promise<{ git_error?: string | null; sent?: boolean; email_error?: string | null }> {
  const action = new ActionInfo('send', 'notification', null, 'POST');
  action.bodyParameters = { sub_action: 'send', ...params };
  const res = await dataManager.callAction<undefined, { git_error?: string | null; sent?: boolean; email_error?: string | null }>(action);
  return { git_error: res?.git_error ?? null, sent: res?.sent, email_error: res?.email_error ?? null };
}

