import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models';
import { ComputeNode } from './compute-node';

export interface GitStatusFile {
  status: string;
  path: string;
  insertions: number | null;
  deletions: number | null;
}

export interface GitStatus {
  error: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
}

/**
 * Thin client-side wrapper for git operations on a specific working directory.
 *
 * All methods delegate to ComputeNode server actions via the graph API under
 * the unified `git-ops` endpoint.
 * The `computeNodeId` defaults to `@local` (the local machine).
 *
 * @example
 * ```typescript
 * const git = new GitRepo('/home/user/my-repo');
 * const status   = await git.getStatus();
 * const branch   = await git.getBranch();
 * const isRepo   = await git.isInit();
 * const isLinked = await git.isLinkedWorktree();
 * ```
 */
export class GitRepo {
  constructor(
    public readonly workDir: string,
    public readonly computeNodeId: string = '@local',
  ) {}

  private async _call<T>(subpath: string): Promise<T> {
    const action = new ActionInfo('git-ops', ComputeNode.type, this.computeNodeId);
    action.subpath = subpath;
    action.queryParameters = { workdir: this.workDir };
    return dataManager.callAction<void, T>(action);
  }

  /** Full git status (branch, ahead/behind, per-file insertions/deletions). */
  async getStatus(): Promise<GitStatus> {
    return this._call<GitStatus>('status');
  }

  /** Current branch name, or null if detached / not a git repo. */
  async getBranch(): Promise<string | null> {
    return (await this._call<{ branch: string | null }>('branch')).branch;
  }

  /** True if workDir is inside a git repository. */
  async isInit(): Promise<boolean> {
    return (await this._call<{ isInit: boolean }>('is-init')).isInit ?? false;
  }

  /**
   * True if workDir is a *linked* worktree (not the main worktree).
   *
   * Server runs `git rev-parse --git-dir` and checks whether the output
   * contains `.git/worktrees/`.
   */
  async isLinkedWorktree(): Promise<boolean> {
    return (await this._call<{ isLinkedWorktree: boolean }>('is-linked-worktree')).isLinkedWorktree ?? false;
  }

  /** True if the repo has at least one commit (HEAD exists). */
  async hasCommit(): Promise<boolean> {
    return (await this._call<{ hasCommit?: boolean }>('has-commit')).hasCommit ?? false;
  }
}
