import { useCallback, useEffect, useState } from 'react';
import { ActionInfo, dataManager, type GitRepo, type TypeId } from '@sdk';

/**
 * Snapshot returned by ``GET /api/v1/graph/project/<id>/git-state``.
 * Mirrors flow_sdk/app/actions/project_git_state_action.py shape.
 */
export interface ProjectGitState {
  has_repo: boolean;
  remote_full_name: string | null;
  current_branch: string | null;
  has_uncommitted: boolean;
  ahead_of_remote: boolean;
  behind_remote: boolean;
  head_commit: string | null;
  workdir: string | null;
  workdir_exists: boolean;
}

/**
 * The seven cases the modal classifies against and which single action it
 * offers for each. Stable union — UI maps these to button labels +
 * action calls. NEVER change the string values; the unit tests pin them.
 */
export type ProjectRepoCase =
  | 'NO_WORKDIR'        // workdir unset or missing — fix project setup first
  | 'CLONE'             // workdir is empty, no .git inside — first clone
  | 'INCOMPATIBLE_REPO' // workdir has a .git pointing at a different remote
  | 'CHECKOUT'          // same repo, different branch
  | 'COMMIT_AND_PULL'   // same repo + branch, but uncommitted local changes
  | 'PULL'              // same repo + branch, clean tree, remote ahead
  | 'UP_TO_DATE';       // same repo + branch, clean tree, no remote diff

/**
 * Pure reducer extracted from the hook so the unit test in
 * tests/unit/test_git_repo_state.py's TS sibling (or a Vitest spec) can
 * exercise every branch without spinning up React. Don't import React
 * here — keep this purely a data → string mapping.
 */
export function deriveRepoState(
  projectGit: ProjectGitState | null,
  gitRepo: Pick<GitRepo, 'full_name' | 'branch'> | null,
): ProjectRepoCase | null {
  if (!projectGit || !gitRepo) return null;

  if (!projectGit.workdir || !projectGit.workdir_exists) return 'NO_WORKDIR';
  if (!projectGit.has_repo) return 'CLONE';

  const sameRepo =
    !!projectGit.remote_full_name &&
    !!gitRepo.full_name &&
    projectGit.remote_full_name === gitRepo.full_name;
  if (!sameRepo) return 'INCOMPATIBLE_REPO';

  const sameBranch =
    !!projectGit.current_branch &&
    !!gitRepo.branch &&
    projectGit.current_branch === gitRepo.branch;
  if (!sameBranch) return 'CHECKOUT';

  if (projectGit.has_uncommitted) return 'COMMIT_AND_PULL';
  if (projectGit.behind_remote) return 'PULL';
  return 'UP_TO_DATE';
}

export interface UseProjectRepoStateResult {
  state: ProjectRepoCase | null;
  projectGit: ProjectGitState | null;
  loading: boolean;
  error: Error | null;
  /** Re-fetch from the server. */
  refresh: () => Promise<void>;
  /** Ingest a snapshot returned by a mutating action (avoids a round-trip). */
  setProjectGit: (snapshot: ProjectGitState | null) => void;
}

/**
 * Loads ``project/git-state`` for the picked project and derives the case
 * the modal should render. The hook is purposely thin: one fetch on mount
 * (and on projectTypeId change), an explicit ``refresh()``, and an
 * ``setProjectGit`` setter the modal calls after a git action so it can
 * push the returned snapshot through without a follow-up GET.
 */
export function useProjectRepoState(
  projectTypeId: TypeId | null,
  gitRepo: Pick<GitRepo, 'full_name' | 'branch'> | null,
): UseProjectRepoStateResult {
  const [projectGit, setProjectGit] = useState<ProjectGitState | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!projectTypeId) return;
    setLoading(true);
    setError(null);
    try {
      const info = new ActionInfo('git-state', projectTypeId.type, projectTypeId.id, 'GET');
      const res = await dataManager.callAction<undefined, ProjectGitState>(info);
      setProjectGit(res ?? null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setProjectGit(null);
    } finally {
      setLoading(false);
    }
  }, [projectTypeId]);

  useEffect(() => {
    if (!projectTypeId) return;
    void refresh();
  }, [projectTypeId, refresh]);

  const state = deriveRepoState(projectGit, gitRepo);

  return { state, projectGit, loading, error, refresh, setProjectGit };
}
