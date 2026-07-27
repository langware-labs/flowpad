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
  const match = pathname.match(/^(\/(?:dock|win))\/display\/([^/?]+)\/?$/);
  if (!match) return null;
  const [, layoutSeg, pointer] = match;
  if (!DockPointer.isAgenticProcessPointer(pointer)) return null;
  return `${layoutSeg}/shell/${pointer}${search}`;
}
