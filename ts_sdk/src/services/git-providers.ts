import { ActionInfo, dataContext, dataManager } from '../index';

/**
 * Provider abstraction for git-hosting platforms. v1 implements only `github`;
 * other values shape the API but return a clean ApiFailResponse from the backend.
 * GitLab nested namespaces will need a multi-level `owner` extension when added.
 */
export type GitProvider = 'github' | 'gitlab' | 'bitbucket';

export interface RepoSummary {
  provider: GitProvider;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string; // ISO timestamp
  role: 'admin' | 'write' | 'read';
  html_url: string;
  description: string;
  fork: boolean;
}

export interface BranchSummary {
  name: string;
  protected: boolean;
}

export interface RepoInvitation {
  id: number;
  repo: { owner: string; name: string; full_name: string; private: boolean };
  inviter_login: string;
  permissions: string;
  invited_at: string;
  html_url: string;
}

interface ListReposPage {
  repos: RepoSummary[];
  next_page: number | null;
  page: number;
}

function _userInfo() {
  // The repo/* action is user-scoped; the user typeid comes from dataContext
  // (populated at bootstrap). Throws clearly if missing rather than producing
  // a malformed URL (`/api/v1/graph/user/<empty>/repo/...` 404s silently).
  const userTypeId = dataContext.userTypeId;
  if (!userTypeId?.id) throw new Error('No user in context — bootstrap not ready');
  return userTypeId;
}

async function _fetchReposPage(provider: GitProvider, page: number): Promise<ListReposPage> {
  const user = _userInfo();
  const info = new ActionInfo('repo', user.type, user.id, 'POST');
  info.subpath = 'list';
  info.bodyParameters = { provider, page };
  const res = await dataManager.callAction<unknown, ListReposPage>(info);
  if (!res || !Array.isArray(res.repos)) {
    throw new Error('Invalid /repo/list response');
  }
  return res;
}

/**
 * Returns the full list of repositories the user has access to via the given
 * provider. Walks pages sequentially using the server-supplied next_page
 * cursor; with per_page=100 a 500-repo account takes 5 sequential round-trips.
 *
 * Guarantees:
 *  - Starts the walk from page 1, then advances using `first.next_page` (so the
 *    second request hits the page the server pointed at, not a hardcoded `2`).
 *  - Monotonicity: each next cursor must be strictly greater than the current
 *    page; otherwise the walk stops. This prevents a misbehaving server from
 *    pinning us in an infinite loop.
 *  - Partial success: if a mid-walk fetch throws (transient 5xx, network blip)
 *    the accumulated pages so far are still returned, so the picker shows what
 *    we know rather than an empty list. The first-page error still propagates
 *    so the caller can render an explicit error state.
 *  - Safety cap at 50 pages (≈5000 repos).
 */
export async function getRepos(provider: GitProvider): Promise<RepoSummary[]> {
  const first = await _fetchReposPage(provider, 1);
  const all: RepoSummary[] = [...first.repos];
  let cursor = first.next_page;
  let lastPage = 1;
  const HARD_CAP = 50;
  while (cursor != null && cursor > lastPage && lastPage < HARD_CAP) {
    let next: ListReposPage;
    try {
      next = await _fetchReposPage(provider, cursor);
    } catch (err) {
      // Surface partial results rather than dropping everything we accumulated.
      console.warn('[git-providers] mid-walk fetch failed; returning partial repos', err);
      return all;
    }
    all.push(...next.repos);
    lastPage = cursor;
    cursor = next.next_page;
  }
  return all;
}

function _isBranchSummary(x: unknown): x is BranchSummary {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.name === 'string';
}

export async function getBranches(repo: {
  provider: GitProvider;
  owner: string;
  name: string;
}): Promise<BranchSummary[]> {
  const user = _userInfo();
  const info = new ActionInfo('repo', user.type, user.id, 'POST');
  info.subpath = 'branches';
  info.bodyParameters = { provider: repo.provider, owner: repo.owner, name: repo.name };
  // Backend returns ApiSuccessResponse(data=[{name, protected}, …]); the
  // dataManager unwraps `.data` once so we get the bare array here. Validate
  // the shape so a future schema drift doesn't silently feed garbage into the
  // picker.
  const res = await dataManager.callAction<unknown, unknown>(info);
  if (Array.isArray(res)) {
    return res.filter(_isBranchSummary).map((b) => ({
      name: b.name,
      protected: Boolean(b.protected),
    }));
  }
  console.warn('[git-providers] unexpected /repo/branches response shape', res);
  return [];
}

export async function getInvitations(provider: GitProvider): Promise<RepoInvitation[]> {
  const user = _userInfo();
  const info = new ActionInfo('repo', user.type, user.id, 'POST');
  info.subpath = 'invitations';
  info.bodyParameters = { provider };
  const res = await dataManager.callAction<unknown, { invitations: RepoInvitation[] }>(info);
  return res?.invitations ?? [];
}

export async function respondInvitation(
  provider: GitProvider,
  invitationId: number,
  action: 'accept' | 'decline',
): Promise<void> {
  const user = _userInfo();
  const subpath = action === 'accept' ? 'invitation-accept' : 'invitation-decline';
  const info = new ActionInfo('repo', user.type, user.id, 'POST');
  info.subpath = subpath;
  info.bodyParameters = { provider, invitation_id: invitationId };
  await dataManager.callAction<unknown, { ok: boolean }>(info);
}

export interface MaterializeRepoArgs {
  provider: GitProvider;
  full_name: string;
  branch: string;
  head_commit?: string | null;
  owner?: string;
  name?: string;
}

export interface MaterializeRepoResult {
  typeid: string;
  id: string;
  full_name: string;
  branch: string;
  html_url: string;
  private: boolean;
}

/**
 * Create a shareable ``GitRepo`` entity from the picker's selection.
 * The local backend creates a fresh entity with a uuid4 id, optionally
 * enriches it from the GitHub API, saves, and returns the TypeId.
 * The caller then attaches the returned TypeId to a FlowMessage via
 * ``sendReply({...}, ..., {assetReferences: [typeid]})``.
 */
export async function materializeRepo(
  args: MaterializeRepoArgs,
): Promise<MaterializeRepoResult> {
  const user = _userInfo();
  const info = new ActionInfo('repo', user.type, user.id, 'POST');
  info.subpath = 'materialize';
  info.bodyParameters = args;
  const res = await dataManager.callAction<MaterializeRepoArgs, MaterializeRepoResult>(info);
  if (!res || !res.typeid) {
    throw new Error('Invalid /repo/materialize response');
  }
  return res;
}
