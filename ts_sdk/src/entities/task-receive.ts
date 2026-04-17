import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';

export interface FindProjectResult {
  found: boolean;
  local_path: string | null;
  repo_url: string;
  branch: string;
  known_projects: Array<{ name: string; path: string }>;
}

export interface PullResult {
  success: boolean;
  conflicts: boolean;
  error: string | null;
}

export interface CloneResult {
  success: boolean;
  error: string | null;
  cloned_path: string | null;
}

export async function findProjectForTask(taskId: string): Promise<FindProjectResult> {
  const action = new ActionInfo('find-project', 'task', taskId, 'POST');
  const res = await dataManager.callAction<undefined, FindProjectResult>(action);
  return res ?? { found: false, local_path: null, repo_url: '', branch: '', known_projects: [] };
}

export async function pullForTask(taskId: string, localPath?: string): Promise<PullResult> {
  const action = new ActionInfo('pull-for-task', 'task', taskId, 'POST');
  if (localPath) {
    action.bodyParameters = { local_path: localPath };
  }
  const res = await dataManager.callAction<undefined, PullResult>(action);
  return res ?? { success: false, conflicts: false, error: 'Unknown error' };
}

export async function cloneForTask(taskId: string, targetDir: string): Promise<CloneResult> {
  const action = new ActionInfo('clone-for-task', 'task', taskId, 'POST');
  action.bodyParameters = { target_dir: targetDir };
  const res = await dataManager.callAction<undefined, CloneResult>(action);
  return res ?? { success: false, error: 'Unknown error', cloned_path: null };
}
