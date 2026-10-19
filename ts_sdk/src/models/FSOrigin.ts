import { formatGitOrigin, type GitOrigin, gitOriginCloneUrl, isInstallableOrigin } from './GitOrigin';

/** Fields shared by every filesystem-origin locator. */
export interface FSOrigin {
  kind: string;
  rel_path: string;
  /**
   * Optional project this origin resolves inside — mirrors the backend
   * `FSOrigin.project_id`. When set it is the most direct way back to a local
   * path (`project.cwd` + `rel_path`), with no need to infer a checkout from
   * repo coordinates. Absent on every origin persisted before the field
   * existed, so treat it as a hint, never a requirement.
   */
  project_id?: string;
}

/** A path already present on this machine; it is not transportable. */
export interface LocalOrigin extends FSOrigin {
  kind: 'local';
  base: string;
}

/**
 * A published asset inside its project's HUB-HOSTED git repository — the
 * backend ``HubRepoOrigin``. The hub is its only remote (a git client reaches
 * it at ``<hub>/api/v1/graph/git_repo/<id>/git`` with the user's hub token), so
 * there is no GitHub page for it. ``tree`` is the git object id of the asset's
 * own file/folder at ``head_commit`` — the asset's version.
 */
export interface HubRepoOrigin extends FSOrigin {
  kind: 'hub_repo';
  /** The hosted ``git_repo`` typeid on the hub (``git_repo-<uuid>``). */
  repo: string;
  /** The commit the hub last synced this asset at. */
  head_commit?: string;
  /** The asset's own git object id at ``head_commit``. */
  tree?: string;
}

/** Canonical SDK union mirroring the backend FSOriginField discriminator. */
export type FSOriginField = GitOrigin | LocalOrigin | HubRepoOrigin;

export type FSOriginInput = FSOriginField | (Omit<GitOrigin, 'kind'> & { kind?: 'git' });

/**
 * Normalize the tolerant wire boundary.  Origins persisted before the
 * discriminator existed were always Git origins, so a missing kind means git.
 */
export function normalizeFSOrigin(value: FSOriginInput | null | undefined): FSOriginField | null {
  if (!value || typeof value !== 'object') return null;
  const kind = String(value.kind || 'git')
    .trim()
    .toLowerCase();
  if (kind === 'git') {
    const git = value as GitOrigin;
    return { ...git, kind: 'git' };
  }
  if (kind === 'local') {
    const local = value as LocalOrigin;
    return { ...local, kind: 'local' };
  }
  if (kind === 'hub_repo') {
    const hub = value as HubRepoOrigin;
    return { ...hub, kind: 'hub_repo' };
  }
  throw new Error(`Unsupported filesystem origin kind: ${kind}`);
}

/**
 * Human label for any origin kind — `owner/name · branch — rel_path` for git
 * (via `formatGitOrigin`), `base/rel_path` for local, `hub · rel_path` for a
 * hub-hosted repo (whose `git_repo-<uuid>` id means nothing to a reader).
 *
 * Lives here rather than at the call sites because the local branch had already
 * been written twice, with the two copies disagreeing on whether a `rel_path` of
 * `"."` should be appended.
 */
export function formatFSOrigin(origin: FSOriginField): string {
  if (isLocalOrigin(origin)) {
    const base = origin.base.replace(/\/$/, '');
    const rel = origin.rel_path;
    return !rel || rel === '.' ? base : `${base}/${rel}`;
  }
  if (isHubRepoOrigin(origin)) {
    const rel = origin.rel_path;
    return !rel || rel === '.' ? 'hub' : `hub · ${rel}`;
  }
  return formatGitOrigin(origin);
}

export function isGitOrigin(value: FSOriginField | null | undefined): value is GitOrigin {
  return value?.kind === 'git';
}

export function isLocalOrigin(value: FSOriginField | null | undefined): value is LocalOrigin {
  return value?.kind === 'local';
}

export function isHubRepoOrigin(value: { kind?: string } | null | undefined): value is HubRepoOrigin {
  return value?.kind === 'hub_repo';
}

/** An origin a whole PROJECT can be checked out from — its git repository, or the
 *  hub-hosted copy of it (a share made `via: hub_repo`). Mirrors the backend
 *  `as_project_origin`. */
export type ProjectOrigin = GitOrigin | HubRepoOrigin;

/** The project origin off an entity (`origin`, or the hub's wire name `git_origin`),
 *  or null when it is absent or nothing a project can be cloned from. */
export function projectOriginOf(
  entity: { origin?: FSOriginInput | null; git_origin?: FSOriginInput | null } | null | undefined,
): ProjectOrigin | null {
  const o = normalizeFSOrigin(entity?.origin ?? entity?.git_origin ?? null);
  if (isHubRepoOrigin(o)) return o.repo ? o : null;
  return isGitOrigin(o) && isInstallableOrigin(o) ? o : null;
}

/** Where a project's files come from, as one line to show: a git origin's clone URL,
 *  or the hub-hosted copy's label (it has no URL of its own). */
export function projectSourceLabel(origin: ProjectOrigin): string {
  return isGitOrigin(origin) ? gitOriginCloneUrl(origin) : formatFSOrigin(origin);
}
