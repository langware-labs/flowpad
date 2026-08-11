import { VIEW_MODE_PARAM } from './DockPointer';
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
 * Deliberately a PURE function of the URL, keyed on an explicit `?viewMode=vibe`
 * rather than the effective mode. The effective mode is not stable at loader
 * time — the instance preference is readable, but a project's own `last_mode` is
 * applied later by `applyProjectViewMode`, so an early read is wrong for exactly
 * the projects that default to vibe. Relying on the explicit param is safe
 * because `openDock` stamps `?viewMode` on essentially every navigation that can
 * produce a host-bearing URL.
 *
 * Runs before `DockPointer.fromUrl`, so nothing downstream ever observes a host
 * in standard mode. Returns the redirect target, or null when already canonical.
 */
export function canonicalWorkspaceDisplayPath(pathname: string, search: string): string | null {
  const match = pathname.match(/^(.*\/(?:dock|win|dev)\/project\/[^/]+)\/process\/[^/]+\/display\/(.+)$/);
  if (!match) return null;
  if (new URLSearchParams(search).get(VIEW_MODE_PARAM) === ViewMode.Vibe) return null;
  const [, projectBase, tail] = match;
  return `${projectBase}/${tail}${search}`;
}
