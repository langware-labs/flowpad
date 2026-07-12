import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models';
import { ComputeNode } from './compute-node';

// ---------------------------------------------------------------------------
// Response schema — 1:1 mirror of the `_CamelModel` subclasses in
// flow_sdk/builtin/faas/git_repo.py (same names, camelCase fields). New fields
// land on the backend model first; this file only reflects them.
// ---------------------------------------------------------------------------

export interface GitStatusFile {
  status: string;
  path: string;
  /** True when the change is in the index (porcelain X column). */
  staged: boolean;
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

export interface GitFileDiff {
  diff: string;
}

export interface GitFileContent {
  content: string;
}

export interface GitAssetDiff {
  diff: string;
  files: GitStatusFile[];
}

export interface GitRevision {
  hash: string;
  version: number | null;
  message: string;
  date: string;
  author: string;
}

export interface GitRevisionList {
  revisions: GitRevision[];
  /** Current (HEAD) version parsed from the newest revision. */
  version: number | null;
  /** Commits to this file ahead of @{u} (0 when no upstream). */
  unpushed: number;
}

export interface GitRestoreResult {
  ok: boolean;
  message: string;
}

/** Typed publish outcome — mirror of `PushKind` in git_repo.py. */
export type PushKind =
  | 'pushed'
  | 'nothing'
  | 'conflict'
  | 'permission'
  | 'no_remote'
  | 'network'
  | 'no_repo'
  | 'generic';

export interface GitPushResult {
  ok: boolean;
  conflict: boolean;
  nothing: boolean;
  kind: PushKind;
  branch: string | null;
  message: string;
}

/**
 * Thin client-side wrapper for git operations on a specific working directory.
 *
 * The complete subpath-for-method mirror of `GitRepo.dispatch()`
 * (flow_sdk/builtin/faas/git_repo.py) — all logic is backend-only; every
 * method delegates to the ComputeNode `git-ops` action.
 * The `computeNodeId` defaults to `@local` (the local machine).
 *
 * Renamed from `GitRepo` (now an APIEntity) — this class is a workdir-bound
 * ops helper, not a stored entity.
 *
 * @example
 * ```typescript
 * const git = new GitWorkdir('/home/user/my-repo');
 * const status = await git.getStatus();
 * await git.stageFile('README.md');
 * const result = await git.push();
 * ```
 */
export class GitWorkdir {
  constructor(
    public readonly workDir: string,
    public readonly computeNodeId: string = '@local',
  ) {}

  private async _call<T>(subpath: string, params: Record<string, string> = {}): Promise<T> {
    const action = new ActionInfo('git-ops', ComputeNode.type, this.computeNodeId);
    action.subpath = subpath;
    action.queryParameters = { workdir: this.workDir, ...params };
    return dataManager.callAction<void, T>(action);
  }

  private async _post<T>(subpath: string, params: Record<string, string> = {}): Promise<T> {
    const action = new ActionInfo('git-ops', ComputeNode.type, this.computeNodeId, 'POST');
    action.subpath = subpath;
    action.bodyParameters = { workdir: this.workDir, ...params };
    return dataManager.callAction<Record<string, string>, T>(action);
  }

  // ------------------------------------------------------------------
  // Read probes
  // ------------------------------------------------------------------

  /** Full git status (branch, ahead/behind, per-file staged/insertions/deletions). */
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

  // ------------------------------------------------------------------
  // Diffs / revisions
  // ------------------------------------------------------------------

  /** Unified diff of a file's pending change (untracked `?` shows the whole file). */
  async fileDiff(file: string, status: string): Promise<GitFileDiff> {
    return this._call<GitFileDiff>('diff', { file, status });
  }

  /** Unified diff of an asset's pending changes plus its changed-file list. */
  async assetDiff(file: string): Promise<GitAssetDiff> {
    return this._call<GitAssetDiff>('asset-diff', { file });
  }

  /** Commit history for an asset (folder-scoped for folder-backed assets). */
  async fileRevisions(file: string): Promise<GitRevisionList> {
    return this._call<GitRevisionList>('file-revisions', { file });
  }

  /** Unified diff of an asset between a past revision and the working tree. */
  async revisionDiff(file: string, hash: string): Promise<GitFileDiff> {
    return this._call<GitFileDiff>('revision-diff', { file, hash });
  }

  /** Full file content at a revision (`hash` may be `HEAD`). */
  async show(file: string, hash: string): Promise<GitFileContent> {
    return this._call<GitFileContent>('show', { file, hash });
  }

  /** Full file content from the current working tree. */
  async workingFile(file: string): Promise<GitFileContent> {
    return this._call<GitFileContent>('working-file', { file });
  }

  // ------------------------------------------------------------------
  // Working-tree mutations
  // ------------------------------------------------------------------

  /** Initialize a git repository in workDir (idempotent). */
  async init(): Promise<GitRestoreResult> {
    return this._post<GitRestoreResult>('init');
  }

  /** Greedy "non-tech" publish: stage-all → commit → pull --rebase → push. */
  async push(): Promise<GitPushResult> {
    return this._post<GitPushResult>('push');
  }

  /** Check out an asset at a past revision (working-tree mutation). */
  async restoreFile(file: string, hash: string): Promise<GitRestoreResult> {
    return this._post<GitRestoreResult>('restore-file', { file, hash });
  }

  /** Undo a file's pending change (status `?` deletes; otherwise restores to HEAD). */
  async discardFile(file: string, status: string): Promise<GitRestoreResult> {
    return this._post<GitRestoreResult>('discard-file', { file, status });
  }

  /** Stage just this file (`git add -- <file>`). */
  async stageFile(file: string): Promise<GitRestoreResult> {
    return this._post<GitRestoreResult>('stage-file', { file });
  }

  /** Unstage just this file (`git restore --staged -- <file>`). */
  async unstageFile(file: string): Promise<GitRestoreResult> {
    return this._post<GitRestoreResult>('unstage-file', { file });
  }
}
