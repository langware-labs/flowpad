import { DockPointer } from './DockPointer';

/**
 * Legacy-URL canonicalization for PROCESS surfaces.
 *
 * A process has exactly ONE canonical URL family — `/dock/shell/agentic_process-<id>`
 * — in BOTH view modes; vibe is a rendering mode of that same dock (carried by
 * the `?viewMode` param, never by a URL family). The old model gave vibe its
 * own `/dock/display/...` family backed by a second Tab identity; those rows
 * are reaped server-side, and any legacy display URL (pre-collapse bookmark,
 * history entry, popped-out `/win` window) redirects here to the shell form
 * with its search string — including `viewMode` and scope keys — preserved
 * verbatim. Pure — the main loader throws `redirect()` on a non-null result.
 *
 * Returns the redirect target (path + search) or null when already canonical.
 */
export function canonicalProcessDockPath(pathname: string, search: string): string | null {
  // Stays a regex on purpose, unlike its credentials sibling. That one maps
  // RETIRED views, which are still decodable — `DockPointer.fromUrl` parses
  // them and `normalizeRetiredDockPointer` resolves them forward. `display` is
  // not retired but GONE: the identity was removed from the view registry
  // entirely, so `fromUrl` rejects it and there is no pointer to transform.
  // Reading a grammar the pointer model has deliberately forgotten is the one
  // job a raw path match is still the right tool for.
  const match = pathname.match(/^(\/(?:dock|win))\/display\/([^/?]+)\/?$/);
  if (!match) return null;
  const [, layoutSeg, pointer] = match;
  if (!DockPointer.isAgenticProcessPointer(pointer)) return null;
  return `${layoutSeg}/shell/${pointer}${search}`;
}

/**
 * A process URL that asks for Vibe by OPTION — `/dock/shell/agentic_process-<id>?viewMode=vibe`,
 * the spelling before Vibe became a host tab type — is the Vibe host dock,
 * `/dock/vibe/agentic_process-<id>`. Every other option is kept verbatim. Pure;
 * `withViewMode` owns the mapping, so this cannot drift from what openers build.
 * Same tab either way: the Vibe dock's `tabHash` folds onto the shell identity.
 */
export function canonicalVibeHostPath(pathname: string, search: string): string | null {
  // Cheap pre-filter, so the hot path never parses: only a shell URL carrying a
  // Vibe option can be the old spelling (every hosted child carries one too).
  if (!pathname.includes('/shell/') || !search.includes('viewMode=vibe')) return null;
  let dock: DockPointer;
  try {
    dock = DockPointer.fromUrl(`${pathname}${search}`);
  } catch {
    return null;
  }
  // `withViewMode` is the one rule: it only changes the family for a process.
  const canonical = dock.withViewMode(dock.viewMode);
  return canonical.viewType !== dock.viewType ? canonical.toUrl(pathname) : null;
}
