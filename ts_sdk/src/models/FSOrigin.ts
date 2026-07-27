import { formatGitOrigin, type GitOrigin } from './GitOrigin';

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

/** Canonical SDK union mirroring the backend FSOriginField discriminator. */
export type FSOriginField = GitOrigin | LocalOrigin;

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
  throw new Error(`Unsupported filesystem origin kind: ${kind}`);
}

/**
 * Human label for any origin kind — `owner/name · branch — rel_path` for git
 * (via `formatGitOrigin`), `base/rel_path` for local.
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
  return formatGitOrigin(origin);
}

export function isGitOrigin(value: FSOriginField | null | undefined): value is GitOrigin {
  return value?.kind === 'git';
}

export function isLocalOrigin(value: FSOriginField | null | undefined): value is LocalOrigin {
  return value?.kind === 'local';
}
