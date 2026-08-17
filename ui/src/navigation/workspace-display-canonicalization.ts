import { DockPointer } from './DockPointer';
import { ViewMode } from '@src/contexts/view-mode-context';

/**
 * Canonicalization for HOSTED-DISPLAY urls.
 *
 * A document shown inside a vibe workspace is addressed
 * `/dock/project/<P>/process/<typeid>/display/<tail>` — the host segments say
 * which workspace is displaying it. That is only meaningful when the display
 * pane is on screen, so in standard mode the host is stripped and the document
 * falls back to its natural address, `/dock/project/<P>/<tail>`.
 *
 * Parsed through `DockPointer` rather than a path regex, unlike its sibling
 * `canonicalProcessDockPath`: that one matches a viewType REMOVED from the
 * registry, which `fromUrl` rejects outright, so a raw match is the only tool
 * left. This form parses perfectly, and `withHost(null).toUrl()` is the exact
 * inverse of the lift — so the grammar stays spelled in one place instead of
 * being restated as regex text that a renamed constant would silently break.
 *
 * Deliberately keyed on an explicit `?viewMode=vibe` rather than the effective
 * mode. The effective mode is not stable at loader time — a project's own
 * `last_mode` is applied later by `applyProjectViewMode`, so an early read is
 * wrong for exactly the projects that default to vibe. That is safe because
 * `openDock` stamps `?viewMode` on essentially every navigation that can produce
 * a host-bearing URL.
 *
 * Runs before the pointer is used, so nothing downstream ever observes a host in
 * standard mode. Returns the redirect target, or null when already canonical.
 */
export function canonicalWorkspaceDisplayPath(pathname: string, search: string): string | null {
  let dock: DockPointer;
  try {
    dock = DockPointer.fromUrl(`${pathname}${search}`);
  } catch {
    return null;
  }
  if (!dock.hostProcessId || dock.viewMode === ViewMode.Vibe) return null;
  return dock.withHost(null).toUrl(pathname);
}
