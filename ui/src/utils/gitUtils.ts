/**
 * Utility functions for Git repository operations
 *
 * Remote-repo questions go to the backend git lib (`/api/v1/git/...`), never to
 * github.com from the browser: the backend already holds the credential and
 * runs the same git commands the clone will.
 */

import { ActionInfo, dataContext, dataManager, Folder, gitOriginFromUrl, TypeId, type GitOrigin } from '@sdk';
import apiClient from '@sdk/client';

/**
 * Stable, machine-independent identity for a GitOrigin — the same string on
 * every machine (unlike a local checkout path). Use it to key/dedup a git
 * attachment and to match one against a project's cloned context folders.
 * Returns null for an incomplete origin.
 *
 * Mirrors the backend `GitOrigin.key()` (`canonical_git_origin_repo_key` +
 * rel_path): case-folded, `.git`-stripped, and deliberately **branch- and
 * commit-independent** — the same repo + subpath is ONE folder identity in the
 * whole system (a git `Folder`'s id IS this key), so two local clones (any
 * branch/commit) reconcile to the same entry. Branch is not part of identity;
 * it still rides in the stored `git_origin` for the clone URL.
 */
export function gitOriginKey(o: GitOrigin | null | undefined): string | null {
  if (!o || !o.owner || !o.name) return null;
  const provider = (o.provider || 'git').trim().toLowerCase();
  const owner = o.owner.trim().toLowerCase();
  const name = o.name
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '');
  const rel = (o.rel_path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.$/, '')
    .replace(/^\/+|\/+$/g, '');
  return `git:${provider}:${owner}/${name}#${rel}`;
}

/**
 * Resolve a git attachment's checkout root ON THIS MACHINE by matching its
 * origin against the project's git context folders (each carries a local
 * `path` plus the linked Folder's `typeid`). Returns the local root, or null
 * when the repo isn't cloned here yet. The sender's absolute path never
 * travels — every machine resolves its own from the shared `git_origin`.
 */
export async function resolveLocalGitRoot(
  origin: GitOrigin,
  gitDirs: ReadonlyArray<{ path: string; typeid?: string }>,
): Promise<string | null> {
  const want = gitOriginKey(origin);
  if (!want) return null;
  for (const dir of gitDirs) {
    if (!dir.typeid) continue;
    try {
      const folder = await Folder.getById(new TypeId(dir.typeid).id);
      const fo = (folder?.origin ?? null) as GitOrigin | null;
      if (fo && gitOriginKey(fo) === want) return dir.path.replace(/\/+$/, '');
    } catch {
      // Unreadable / absent folder — skip and try the next candidate.
    }
  }
  return null;
}


/**
 * Can we read this repo, and what is its default branch?
 *
 * Asks the backend (`/api/v1/git/remote-access`), which runs `git ls-remote`
 * over the SAME credential path a clone would use — anonymous for a public
 * repo, the caller's stored GitHub token for a private one. So a passing check
 * guarantees the clone that follows can authenticate too.
 *
 * Returns null only when the question could not be asked (bad URL, backend
 * unreachable) — `{hasAccess:false}` is a real answer that gates on
 * "connect GitHub to continue".
 */
export const hasGitHubRepoAccess = async (
  gitUrl: string,
): Promise<{ hasAccess: boolean; defaultBranch: string | null } | null> => {
  if (!gitUrl) return null;
  try {
    // The apiClient interceptor unwraps the {status,data} envelope, so this IS
    // the payload — not an axios response.
    const data = (await apiClient.post('/api/v1/git/remote-access', { clone_url: gitUrl })) as unknown as
      | { accessible?: boolean; default_branch?: string | null }
      | undefined;
    if (!data) return null;
    return { hasAccess: !!data.accessible, defaultBranch: data.default_branch ?? null };
  } catch (error) {
    console.error('Error checking git remote access:', error);
    return null;
  }
};

interface GitHubBranch {
  name: string;
  protected: boolean;
}

/**
 * Fetches available branches for a GitHub repository
 * @param gitUrl - The Git repository URL
 * @returns Promise<GitHubBranch[]> - Array of branch objects, or empty array on error
 */
export const fetchGitHubBranches = async (gitUrl: string): Promise<GitHubBranch[]> => {
  if (!gitUrl) return [];
  const gitOrigin = gitOriginFromUrl(gitUrl);
  if (!gitOrigin) return [];

  try {
    // The user typeid must be passed so the backend's _get_github_token can
    // look up the SOD credential under the signed-in user. Without it, the
    // call hits as anonymous and 401s on private repos.
    const userTypeId = dataContext.userTypeId;
    const actionInfo = new ActionInfo('repo', userTypeId?.type ?? null, userTypeId?.id ?? null, 'POST');
    actionInfo.subpath = 'branches';
    actionInfo.bodyParameters = {
      git_origin: gitOrigin,
    };

    const result = await dataManager.callAction(actionInfo);
    if (Array.isArray(result)) {
      return result as GitHubBranch[];
    }

    console.warn('Unexpected response from GitHub branches fetch:', result);
    return [];
  } catch (error) {
    console.error('Error fetching GitHub branches:', error);
    return [];
  }
};
