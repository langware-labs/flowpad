/**
 * Resolving document-relative `img` / `a` targets in rendered markdown.
 *
 * `MarkdownView` renders a string and has no idea where that string came from,
 * so `![](./brand/logo.png)` resolves against the SPA route and 404s, and
 * `[next](./setup.md)` opens a broken new tab. Anything rendering markdown that
 * lives in a project folder needs to rewrite both against that project.
 *
 * The functions here are pure so the rewriting rules can be tested without a
 * DOM or a backend; `useMarkdownAssetComponents` binds them to a project.
 */

/** Targets that must be left exactly as authored. */
export function isExternalHref(href: string): boolean {
  // Protocol-relative (`//host/x`) counts as external; a bare `#anchor` and an
  // empty href are in-page and equally must not be rewritten into a file path.
  return (
    !href ||
    href.startsWith('#') ||
    href.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(href)
  );
}

/**
 * Resolve a document-relative path against the directory of the article that
 * contains it, yielding a path relative to the project root.
 *
 * @param docPath  the article, relative to the project root (`docs/a/b.md`)
 * @param rel      the href/src as authored (`./img.png`, `../shared/x.png`, `/top.png`)
 *
 * A leading `/` means "project root", not filesystem root — inside a repo that
 * is the only reading that makes sense. Returns null when the path climbs above
 * the root, which the backend would refuse to serve anyway.
 */
export function resolveDocRelativePath(docPath: string, rel: string): string | null {
  if (!rel) return null;
  const relSegments = rel.startsWith('/') ? rel.slice(1).split('/') : rel.split('/');
  // A target built only from `.` / `..` / slashes names a DIRECTORY, not a file
  // — there is nothing to fetch, and resolving it would hand back the article's
  // own folder as if it were an asset.
  if (!relSegments.some((s) => s && s !== '.' && s !== '..')) return null;

  const base = rel.startsWith('/') ? [] : docPath.split('/').slice(0, -1);
  const out: string[] = [];
  for (const segment of [...base, ...relSegments]) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      // Escaping the project root is not a path we can serve.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length ? out.join('/') : null;
}

/** Split a link into its path and the `#fragment`/`?query` tail, which must
 *  survive resolution — `[x](./setup.md#step-2)` keeps the anchor. */
export function splitHrefTail(href: string): { path: string; tail: string } {
  const cut = href.search(/[#?]/);
  return cut === -1 ? { path: href, tail: '' } : { path: href.slice(0, cut), tail: href.slice(cut) };
}
