import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';

/** A project's hub-hosted repository (`GET project/<id>/hosted_repo`); null when the project has none. */
export interface HostedRepo {
  /** The repo's TypeId string, `git_repo-<id>`. */
  repo: string;
  clone_url: string;
  default_branch: string;
  head_commit: string | null;
}

/** One commit as the hub's `git_repo/<id>/log` answers it. */
export interface RepoCommit {
  sha: string;
  author: string;
  /** ISO 8601. */
  date: string;
  subject: string;
}

/** One branch with its last commit (`git_repo/<id>/branches`). */
export interface RepoBranch extends Partial<RepoCommit> {
  name: string;
}

/** The project's hosted repo, or null when it has none yet. */
export async function getHostedRepo(projectId: string): Promise<HostedRepo | null> {
  const info = new ActionInfo('hosted_repo', 'project', projectId, 'GET');
  const res = await dataManager.callAction<void, HostedRepo | null>(info);
  return res && typeof res === 'object' && 'repo' in res ? res : null;
}

/** A hub without these actions reads the repo row instead (an unknown action parses as a plain GET). */
function listOrThrow<T>(res: unknown, action: string): T[] {
  if (Array.isArray(res)) return res as T[];
  throw new Error(`this hub does not support git_repo/${action} yet`);
}

function repoId(repo: string): string {
  return repo.replace(/^git_repo-/, '');
}

async function repoList<T>(repo: string, action: string, query?: Record<string, string>): Promise<T[]> {
  const info = new ActionInfo(action, 'git_repo', repoId(repo), 'GET');
  if (query) info.queryParameters = query;
  return listOrThrow<T>(await dataManager.callAction<void, T[]>(info), action);
}

/** Every branch of a hosted repo, newest first. */
export function getRepoBranches(repo: string): Promise<RepoBranch[]> {
  return repoList<RepoBranch>(repo, 'branches');
}

/** The last `limit` commits on `branch` (the default branch when omitted; the hub caps at 50). */
export function getRepoLog(repo: string, branch?: string, limit = 20): Promise<RepoCommit[]> {
  return repoList<RepoCommit>(repo, 'log', { ...(branch ? { branch } : {}), limit: String(limit) });
}
