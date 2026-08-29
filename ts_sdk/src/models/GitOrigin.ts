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
  kind: 'git';
  provider: string;
  owner: string;
  name: string;
  branch: string;
  head_commit?: string | null;
  /** Asset ROOT's path relative to the repo root — a folder or a file. */
  rel_path: string;
  /**
   * Optional project this origin resolves inside. Declared here as well as on
   * `FSOrigin` because this interface predates that base and does not extend it
   * (extending would make the two modules import each other). Same meaning and
   * same backend field — keep them in step.
   */
  project_id?: string;
}

const HOST_PROVIDERS: Record<string, string> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
};

function stripGitSuffix(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -4) : name;
}

function providerHost(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'github') return 'github.com';
  if (normalized === 'gitlab') return 'gitlab.com';
  if (normalized === 'bitbucket') return 'bitbucket.org';
  return provider.trim();
}

function hostOfGitUrl(url: string): string {
  const value = url.trim();
  if (value.includes('://')) {
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  const match = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):/);
  return match?.[1]?.toLowerCase() ?? '';
}

/** Build a repo-root GitOrigin from a clone/origin URL. */
export function gitOriginFromUrl(url: string, branch = '', relPath = '.'): GitOrigin | null {
  if (!url.trim() || !isSafeRelPath(relPath)) return null;
  const host = hostOfGitUrl(url);
  if (!host) return null;
  const match = url.trim().match(/[:/]([^/:\s]+\/[^/:\s]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  const [owner, name] = match[1].split('/');
  if (!owner || !name || owner.toLowerCase() === host) return null;
  return {
    kind: 'git',
    provider: HOST_PROVIDERS[host] ?? host,
    owner,
    name: stripGitSuffix(name),
    branch,
    head_commit: null,
    rel_path: relPath,
  };
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
  return o.rel_path && o.rel_path !== '.' ? `${head} — ${o.rel_path}` : head;
}

/** Canonical clone URL for a GitOrigin. Mirrors backend GitOrigin.clone_url(). */
export function gitOriginCloneUrl(o: GitOrigin): string {
  if (o.provider.trim().toLowerCase() === 'file') {
    const owner = o.owner.replace(/\/+$/, '');
    const leaf = stripGitSuffix(o.name.trim());
    return `file://${owner}/${leaf}.git`;
  }
  return `https://${providerHost(o.provider)}/${o.owner}/${stripGitSuffix(o.name)}.git`;
}

/**
 * Per-provider path segment for browsing a ref inside a repo's web UI. Anything
 * not listed has no known browse grammar (and ``file`` origins have no web UI at
 * all) — the caller then has no link to offer.
 */
function providerBrowseSegment(provider: string, isDir: boolean): string | null {
  switch (provider.trim().toLowerCase()) {
    case 'github':
      return isDir ? 'tree' : 'blob';
    case 'gitlab':
      return isDir ? '-/tree' : '-/blob';
    case 'bitbucket':
      return 'src';
    default:
      return null;
  }
}

/**
 * Browsable web URL for a GitOrigin — the page a human opens, NOT the clone URL
 * (see {@link gitOriginCloneUrl}). Deep-links to ``rel_path`` at the origin's
 * branch (or, on a detached head, its commit); degrades to the repo root when
 * there is no ref or no safe path to point at.
 *
 * Returns null when the provider has no known web UI (e.g. a ``file`` origin) or
 * the origin doesn't name a repo — callers should render no link at all.
 */
export function gitOriginWebUrl(o: GitOrigin, opts?: { isDir?: boolean }): string | null {
  if (!o?.owner || !o?.name) return null;
  // No known browse grammar (a ``file`` remote, a self-hosted host we can't
  // address) ⇒ no page to send anyone to. Say so instead of guessing a URL.
  const segment = providerBrowseSegment(o.provider, opts?.isDir === true);
  if (!segment) return null;

  const root = `https://${providerHost(o.provider)}/${encodeURIComponent(o.owner)}/${encodeURIComponent(stripGitSuffix(o.name))}`;
  const ref = (o.branch || o.head_commit || '').trim();
  const rel = (o.rel_path || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!ref || rel === '.' || !isSafeRelPath(rel)) return root;

  // Segment-wise, never whole-string: a `feature/x` branch must keep its slash —
  // providers do not resolve `feature%2Fx` in a tree/blob path.
  const encodePath = (p: string) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${root}/${segment}/${encodePath(ref)}/${encodePath(rel)}`;
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

/** Read a (possibly absent) git-kind origin off any entity. `origin` is the
 *  entity field; `git_origin` is the hub's wire name for the same value. */
export function gitOriginOf(
  entity: { origin?: GitOrigin | null; git_origin?: GitOrigin | null } | null | undefined,
): GitOrigin | null {
  const o = entity?.origin ?? entity?.git_origin ?? null;
  return o && (o.kind === undefined || o.kind === 'git') ? o : null;
}
