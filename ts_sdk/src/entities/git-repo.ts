import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export type GitProviderId = 'github' | 'gitlab' | 'bitbucket';

export interface IGitRepo extends IEntity {
  /** "github" — v1 only supports GitHub. */
  provider?: GitProviderId;
  owner?: string;
  /** Repo name (without owner). */
  name?: string;
  /** "owner/repo" — canonical display id. */
  full_name?: string;
  /** Repo's mainline branch, used for fallback labels. */
  default_branch?: string;
  /** The branch this shared location represents (the "current git location"). */
  branch?: string;
  /** Commit SHA at share time (snapshot, optional). */
  head_commit?: string | null;
  /** Public web URL (github.com/owner/repo). */
  html_url?: string;
  description?: string | null;
  private?: boolean;
  fork?: boolean;
}

/**
 * Shareable "git location" entity — represents a repo + branch the sender
 * wants the recipient to work on. Same wire pattern as Markdown/Spec:
 * created locally, attached to a FlowMessage as a `type_id` reference,
 * rendered as a chip on the recipient side, opens an accept-modal on click.
 *
 * Non-secret metadata only. For the workdir-bound git ops helper, see
 * `./git-workdir.ts` (`GitWorkdir`).
 */
@registerEntity
export class GitRepo extends APIEntity<GitRepo> implements IGitRepo {
  provider?: GitProviderId;
  owner?: string;
  name?: string;
  full_name?: string;
  default_branch?: string;
  branch?: string;
  head_commit?: string | null;
  html_url?: string;
  description?: string | null;
  private?: boolean;
  fork?: boolean;
  static type: string = 'git_repo';

  constructor(entity: Partial<IGitRepo> = {}) {
    super(entity);
    this.provider = entity.provider ?? 'github';
    this.owner = entity.owner ?? '';
    this.name = entity.name ?? '';
    this.full_name = entity.full_name ?? '';
    this.default_branch = entity.default_branch ?? 'main';
    this.branch = entity.branch ?? '';
    this.head_commit = entity.head_commit ?? null;
    this.html_url = entity.html_url ?? '';
    this.description = entity.description ?? null;
    this.private = entity.private ?? false;
    this.fork = entity.fork ?? false;
  }

  /** "owner/repo · branch" — what the chip label and modal header show. */
  get displayLabel(): string {
    if (this.full_name && this.branch) return `${this.full_name} · ${this.branch}`;
    if (this.full_name) return this.full_name;
    return this.name ?? '';
  }
}
