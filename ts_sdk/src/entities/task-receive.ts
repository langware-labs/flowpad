import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { GitOrigin } from '../models/GitOrigin';
import type { PullKind } from './git-workdir';

export interface FindProjectResult {
  found: boolean;
  local_path: string | null;
  git_origin: GitOrigin | null;
  known_projects: Array<{ name: string; path: string }>;
}

/** A task-repo pull — the `GitRepo` pull outcome, so a conflict is handled like the footer's Pull. */
export interface PullResult {
  success: boolean;
  kind: PullKind;
  branch: string | null;
  message: string;
  local_path: string | null;
  error: string | null;
}

export interface CloneResult {
  success: boolean;
  /** Present when the target existed and was pulled instead of cloned. */
  kind?: PullKind;
  branch?: string | null;
  message?: string;
  error: string | null;
  cloned_path: string | null;
}

export async function findProjectForTask(
  taskId: string,
  fallback?: { gitOrigin?: GitOrigin | null },
): Promise<FindProjectResult> {
  const action = new ActionInfo('find-project', 'task', taskId, 'POST');
  if (fallback?.gitOrigin) {
    action.bodyParameters = { git_origin: fallback.gitOrigin };
  }
  const res = await dataManager.callAction<undefined, FindProjectResult>(action);
  return res ?? { found: false, local_path: null, git_origin: null, known_projects: [] };
}

export async function pullForTask(
  taskId: string,
  localPath?: string,
  fallback?: { gitOrigin?: GitOrigin | null },
): Promise<PullResult> {
  const action = new ActionInfo('pull-for-task', 'task', taskId, 'POST');
  action.bodyParameters = {
    ...(localPath ? { local_path: localPath } : {}),
    ...(fallback?.gitOrigin ? { git_origin: fallback.gitOrigin } : {}),
  };
  const res = await dataManager.callAction<undefined, PullResult>(action);
  return (
    res ?? { success: false, kind: 'generic', branch: null, message: '', local_path: null, error: 'Unknown error' }
  );
}

export async function cloneForTask(
  taskId: string,
  targetDir: string,
  fallback?: { gitOrigin?: GitOrigin | null },
): Promise<CloneResult> {
  const action = new ActionInfo('clone-for-task', 'task', taskId, 'POST');
  action.bodyParameters = {
    target_dir: targetDir,
    ...(fallback?.gitOrigin ? { git_origin: fallback.gitOrigin } : {}),
  };
  const res = await dataManager.callAction<undefined, CloneResult>(action);
  return res ?? { success: false, error: 'Unknown error', cloned_path: null };
}
