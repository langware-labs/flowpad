/**
 * GitOrigin — the FE mirror of the backend ``flow_sdk/builtin/git_origin.py``
 * value object. Git here is purely provenance + placement: a received,
 * shared file-backed asset may carry a ``git_origin`` recording which upstream
 * repo + branch it came from and its path RELATIVE to the repo root, so the
 * backend reconstructs the sender's layout and the UI can show where it came
 * from. The FE never mints or places — it only reads/displays the provenance.
 *
 * ``isSafeRelPath`` mirrors the backend path-traversal guard byte-for-byte in
 * intent: FE and BE must AGREE on what a safe repo-relative path is (the same
 * discipline as TypeId validation), so a display/edit surface never treats an
 * unsafe path as legitimate.
 */
export interface GitOrigin {
  provider: string;
  owner: string;
  name: string;
  branch: string;
  head_commit?: string | null;
  /** Asset ROOT's path relative to the repo root — a folder or a file. */
  rel_path: string;
}

/** ``owner/name`` (the upstream repo's full name), or just the name. */
export function gitOriginRepoFullName(o: GitOrigin): string {
  return o.owner && o.name ? `${o.owner}/${o.name}` : o.name || '';
}

/**
 * Human label for a provenance chip/tooltip:
 *   ``owner/name · branch — rel_path``  (omitting empty parts).
 */
export function formatGitOrigin(o: GitOrigin): string {
  const full = gitOriginRepoFullName(o);
  const head = o.branch ? `${full} · ${o.branch}` : full;
  return o.rel_path ? `${head} — ${o.rel_path}` : head;
}

/**
 * Mirror of the backend ``is_safe_rel_path``: a repo-relative path is safe iff
 * it stays inside the repo root — reject empty, absolute, a Windows drive, or
 * any ``..`` segment. FE and BE MUST agree on this.
 */
export function isSafeRelPath(relPath: string | null | undefined): boolean {
  if (!relPath || !relPath.trim()) return false;
  const p = relPath.trim().replace(/\\/g, '/');
  if (p.startsWith('/')) return false;
  if (p.length >= 2 && p[1] === ':') return false; // windows drive, e.g. "C:/..."
  return !p.split('/').includes('..');
}

/** A GitOrigin is usable for display/placement iff it names a repo + a safe position. */
export function isCompleteGitOrigin(o: GitOrigin | null | undefined): o is GitOrigin {
  return !!o && !!o.owner && !!o.name && isSafeRelPath(o.rel_path);
}

/** Read a (possibly absent) git_origin off any received entity. */
export function gitOriginOf(entity: { git_origin?: GitOrigin | null } | null | undefined): GitOrigin | null {
  return entity?.git_origin ?? null;
}
