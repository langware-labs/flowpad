import type { GitOrigin } from './GitOrigin';

/** Fields shared by every filesystem-origin locator. */
export interface FSOrigin {
  kind: string;
  rel_path: string;
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

export function isGitOrigin(value: FSOriginField | null | undefined): value is GitOrigin {
  return value?.kind === 'git';
}

export function isLocalOrigin(value: FSOriginField | null | undefined): value is LocalOrigin {
  return value?.kind === 'local';
}
