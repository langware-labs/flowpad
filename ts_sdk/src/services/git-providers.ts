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
 * provider. Internally fetches page 1, then fires the remaining pages in
 * parallel based on the Link-header next_page cursor returned by the server.
 */
export async function getRepos(provider: GitProvider): Promise<RepoSummary[]> {
  const first = await _fetchReposPage(provider, 1);
  if (first.next_page == null) return first.repos;
  // Pages 2..N — fire in parallel. We don't know the total page count up front;
  // probe until we see a page with next_page=null.
  const all: RepoSummary[] = [...first.repos];
  let page = 2;
  // GitHub's next_page only tells us the NEXT page; to keep this bounded and
  // simple we walk sequentially with a 100/page step. With per_page=100 this
  // means a 500-repo account does 5 sequential requests — fine. A future tweak
  // can probe the `last` rel in the Link header for true parallelism.
  while (true) {
    const next = await _fetchReposPage(provider, page);
    all.push(...next.repos);
    if (next.next_page == null) break;
    page = next.next_page;
    if (page > 50) break; // safety cap @ 5000 repos
  }
  return all;
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
  const res = await dataManager.callAction<unknown, BranchSummary[] | { data: BranchSummary[] }>(info);
  // Backend returns ApiSuccessResponse(data=[{...}]) → dataManager unwraps once.
  if (Array.isArray(res)) return res;
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
