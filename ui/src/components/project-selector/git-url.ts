/**
 * A pasted repository address, split into what `git clone` takes and the branch it names.
 *
 * People paste what their browser shows: GitHub's `…/owner/repo/tree/<branch>` (a branch may
 * contain slashes: `feature/x`), or a URL with a `#<branch>` suffix. Either way the clone must get
 * the repository URL, and the branch rides beside it — `ls-remote` on a `/tree/` URL answers "not
 * found", which reads as "no access".
 */
export function splitGitBranch(pasted: string): { url: string; branch?: string } {
  const raw = pasted.trim();
  const hash = raw.indexOf('#');
  if (hash > 0) {
    const branch = raw.slice(hash + 1).trim();
    return branch ? { url: raw.slice(0, hash), branch } : { url: raw.slice(0, hash) };
  }
  const tree = /^(https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+?)(?:\.git)?\/tree\/(.+?)\/?$/i.exec(raw);
  if (tree) return { url: tree[1], branch: decodeURIComponent(tree[2]) };
  return { url: raw };
}
