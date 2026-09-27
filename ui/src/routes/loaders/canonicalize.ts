import { canonicalCredentialsDockPath } from '@src/navigation/credentials-dock-canonicalization';
import { canonicalProcessDockPath } from '@src/navigation/process-dock-canonicalization';
import { canonicalWorkspaceDisplayPath } from '@src/navigation/workspace-display-canonicalization';
import { canonicalWorldViewDockPath } from '@src/navigation/worldview-dock-canonicalization';

/** One syntactic rewrite: the canonical `path+search` for a URL, or null when it already is. */
type Canonicalizer = (pathname: string, search: string) => string | null;

/**
 * Step 2 of docs/navigation/dock-loading.md: the URL-only rewrites, applied in
 * order and COMPOSED — a URL that needs two of them redirects once, straight to
 * the final form (I2: at most one redirect per navigation). Pure: no entity, no
 * network, nothing written.
 *
 *  - retired `/display/<proc>` → the process's one shell URL (vibe rides ?viewMode)
 *  - the workspace display host only exists with the display pane on screen
 *  - retired WorldView spellings → the WorldView dock
 *  - retired credential views (environment / connections / api-keys) → credentials/<subview>
 */
const CANONICALIZERS: readonly Canonicalizer[] = [
  canonicalProcessDockPath,
  canonicalWorkspaceDisplayPath,
  canonicalWorldViewDockPath,
  canonicalCredentialsDockPath,
];

export function canonicalizeDockUrl(pathname: string, search: string): string | null {
  let current = `${pathname}${search}`;
  let changed = false;
  for (const canonicalize of CANONICALIZERS) {
    const url = new URL(current, 'http://canonical.invalid');
    const next = canonicalize(url.pathname, url.search);
    if (next && next !== current) {
      current = next;
      changed = true;
    }
  }
  return changed ? current : null;
}
