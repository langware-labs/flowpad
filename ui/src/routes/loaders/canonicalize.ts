import { canonicalProcessDockPath, canonicalVibeHostPath } from '@src/navigation/process-dock-canonicalization';
import { canonicalWorkspaceDisplayPath } from '@src/navigation/workspace-display-canonicalization';
import { canonicalRetiredViewDockPath } from '@src/navigation/retired-views-dock-canonicalization';
import { canonicalWorldViewDockPath } from '@src/navigation/worldview-dock-canonicalization';

/** One syntactic rewrite: the canonical `path+search` for a URL, or null when it already is. */
type Canonicalizer = (pathname: string, search: string) => string | null;

/**
 * Step 2 of docs/navigation/dock-loading.md: the URL-only rewrites, applied in
 * order and COMPOSED — a URL that needs two of them redirects once, straight to
 * the final form (I2: at most one redirect per navigation). Pure: no entity, no
 * network, nothing written.
 *
 *  - retired `/display/<proc>` → the process's one shell URL
 *  - a process URL asking for Vibe by option → the Vibe host dock `/dock/vibe/<proc>`
 *  - the workspace display host only exists with the display pane on screen
 *  - retired WorldView spellings → the WorldView dock
 *  - retired views and sections (RETIRED_DOCK_VIEWS / RETIRED_DOCK_POINTERS): credential
 *    aliases → credentials/<subview>, Data sources › Channels → inbound, …
 */
const CANONICALIZERS: readonly Canonicalizer[] = [
  canonicalProcessDockPath,
  canonicalVibeHostPath,
  canonicalWorkspaceDisplayPath,
  canonicalWorldViewDockPath,
  canonicalRetiredViewDockPath,
];

export function canonicalizeDockUrl(pathname: string, search: string): string | null {
  // The two halves are carried as strings and re-split only after a rewrite fires:
  // parsing a URL per canonicalizer allocated four of them per navigation to learn
  // nothing, on a path with a millisecond budget.
  let [path, query] = [pathname, search];
  for (const canonicalize of CANONICALIZERS) {
    const next = canonicalize(path, query);
    if (!next) continue;
    const cut = next.indexOf('?');
    [path, query] = cut < 0 ? [next, ''] : [next.slice(0, cut), next.slice(cut)];
  }
  const out = `${path}${query}`;
  return out === `${pathname}${search}` ? null : out;
}
