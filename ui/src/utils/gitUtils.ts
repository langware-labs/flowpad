/**
 * Utility functions for Git repository operations
 *
 * Note: GitHub API calls are made through a secure backend proxy to avoid
 * exposing tokens in the frontend and to handle rate limits properly.
 */

import { ActionInfo, dataContext, dataManager, Folder, gitOriginFromUrl, TypeId, type GitOrigin } from '@sdk';

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
 * Response structure from the proxy action
 * Used for external API calls made through the backend proxy
 * The response is unwrapped from ApiResponse, so this represents the inner data structure
 */
interface ProxyActionResponse<T = unknown> {
  /** Whether the request was successful (status code < 400) */
  success?: boolean;
  /** Response data from the proxied API */
  data?: T;
  /** HTTP status code from the proxied API */
  status_code?: number;
  /** Response headers from the proxied API */
  headers?: Record<string, string>;
  /** Error message if the request failed */
  error?: string;
}

// Constants for GitHub API
const GITHUB_ACCEPT_HEADER = 'application/vnd.github.v3+json';
const GITHUB_API_BASE = 'https://api.github.com/repos';

/**
 * Converts a Git repository URL to a GitHub API URL
 * @param gitUrl - The Git repository URL (e.g., https://github.com/owner/repo.git)
 * @returns The GitHub API URL (e.g., https://api.github.com/repos/owner/repo)
 */
function convertGitUrlToApiUrl(gitUrl: string): string | null {
  try {
    // Remove .git suffix if present
    const cleanUrl = gitUrl.replace(/\.git$/, '');

    // Parse the URL
    const url = new URL(cleanUrl);

    // Check if it's a GitHub URL
    if (url.hostname !== 'github.com') {
      return null;
    }

    // Extract owner and repo from pathname
    const pathParts = url.pathname.split('/').filter((part) => part.length > 0);
    if (pathParts.length < 2) {
      return null;
    }

    const [owner, repo] = pathParts;
    return `${GITHUB_API_BASE}/${owner}/${repo}`;
  } catch (error) {
    console.warn('Failed to parse Git URL:', gitUrl, error);
    return null;
  }
}

/**
 * Checks if a user has access to a GitHub repository and gets the default branch
 * @param gitUrl - The Git repository URL
 * @returns Promise with access status and default branch
 */
export const hasGitHubRepoAccess = async (
  gitUrl: string,
): Promise<{ hasAccess: boolean; defaultBranch: string | null } | null> => {
  if (!gitUrl) return null;

  try {
    // Convert Git URL to GitHub API URL
    const apiUrl = convertGitUrlToApiUrl(gitUrl);
    if (!apiUrl) {
      console.warn('Invalid GitHub URL:', gitUrl);
      return null;
    }

    // Create action info for the generic proxy - no project context needed for public API calls
    const actionInfo = new ActionInfo('proxy', null, null, 'POST');
    actionInfo.bodyParameters = {
      url: apiUrl,
      method: 'GET',
      headers: {
        Accept: GITHUB_ACCEPT_HEADER,
        'User-Agent': 'FlowPad-Frontend/1.0',
      },
      timeout: 10,
    };

    // Call the backend proxy
    // Note: apiClient interceptor automatically unwraps ApiResponse, so we get ProxyActionResponse directly
    const result = await dataManager.callAction<
      unknown,
      ProxyActionResponse<{
        default_branch?: string;
      }>
    >(actionInfo);

    if (result && result.success && result.data) {
      // 200 response means user has access to the repository
      const defaultBranch = result.data.default_branch || null;
      return { hasAccess: true, defaultBranch };
    } else if (result && result.data && result.status_code === 404) {
      // 404 means no access (repository doesn't exist or user doesn't have permission)
      return { hasAccess: false, defaultBranch: null };
    } else if (result && result.data && result.status_code === 403) {
      // 403 could mean rate limited or no access
      const rateLimitRemaining = result.headers?.['X-RateLimit-Remaining'];
      if (rateLimitRemaining === '0') {
        console.warn('GitHub API rate limit exceeded');
        return null;
      }
      // Likely no access
      return { hasAccess: false, defaultBranch: null };
    } else if (result && result.error) {
      console.warn('GitHub repo check error:', result.error);
      return null;
    } else {
      console.warn('Unexpected response from GitHub repo check:', result);
      return null;
    }

    // Fallback return
    return null;
  } catch (error) {
    console.error('Error checking GitHub repository access via proxy:', error);
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
