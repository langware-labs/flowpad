/**
 * A project's private GitHub repo, shared with its members through the hub —
 * the TS twin of `GitShare` (`flow_sdk/schema/data_spec/git_share_spec.py`).
 *
 * Members clone and push it with their FlowPad login; their project role decides
 * how (readers pull, editors push). `status` says where the share stands, and
 * when GitHub needs a step first, which one.
 */

export type GitShareStatus =
  /** Members clone and push through the hub at `clone_url`. */
  | 'shared'
  /** Not shared (never was, or was unshared). */
  | 'not_shared'
  /** The Flowpad GitHub App is not installed on the repo: install it at `install_url`, then share again. */
  | 'install_required'
  /** The hub needs the caller's GitHub connection to check they may share the repo. */
  | 'github_connect_required'
  /** The repo is public: anyone can already clone it. */
  | 'not_private';

export interface GitShare {
  status: GitShareStatus;
  /** The GitHub repo, `owner/name`. */
  repo: string;
  /** The hub's `git_repo` typeid serving it (when shared). */
  git_repo: string | null;
  /** What a member clones, with their hub login (when shared). */
  clone_url: string | null;
  /** The GitHub App install page for `repo` (when the App must be installed first). */
  install_url: string | null;
  default_branch: string;
}

const STATUSES: readonly GitShareStatus[] = [
  'shared',
  'not_shared',
  'install_required',
  'github_connect_required',
  'not_private',
];

/** Read a `git_share` answer field by field; anything missing or unknown reads as not shared. */
export function gitShareFrom(data: unknown): GitShare {
  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const status = STATUSES.includes(raw.status as GitShareStatus) ? (raw.status as GitShareStatus) : 'not_shared';
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  return {
    status,
    repo: text(raw.repo) ?? '',
    git_repo: text(raw.git_repo),
    clone_url: text(raw.clone_url),
    install_url: text(raw.install_url),
    default_branch: text(raw.default_branch) ?? 'main',
  };
}
