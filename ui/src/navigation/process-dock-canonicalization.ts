import { DockPointer, VIEW_MODE_PARAM } from './DockPointer';
import { ViewType } from '@src/types/ViewType';

/**
 * The canonical PROCESS-surface viewType per mode — the single home of the
 * "vibe's process surface is the Display, standard's is the shell/terminal"
 * pairing. Consumed by the URL canonicalizer below and by
 * `NavigationActions.openShellProcess` so the two can't drift.
 */
export function processSurfaceViewType(vibe: boolean): ViewType.DISPLAY | ViewType.SHELL {
  return vibe ? ViewType.DISPLAY : ViewType.SHELL;
}

/**
 * Mode-canonical URL for a PROCESS surface.
 *
 * The Display is a real Tab owned by its process, but each view mode has ONE
 * canonical URL family for that process surface:
 *   - vibe:     `/dock/display/agentic_process-<id>` — the always-present
 *               Display pane; the process itself is the left-side chat.
 *   - standard: `/dock/shell/agentic_process-<id>` — the ordinary terminal
 *               dock; display tabs behave like any other tab and bounce here.
 *
 * Cross-mode / legacy URLs (pre-display bookmarks, history entries, a mode
 * toggle while parked on the other family) canonicalize so the session/tab
 * machinery only ever sees one URL family per mode. Pure — the main loader
 * throws `redirect()` on a non-null result.
 *
 * The effective mode is the URL param when present, else `preferenceVibe`
 * (the caller resolves it from the view-mode preference) — the same
 * `override ?? preference` resolution the renderer uses, so the redirect and
 * the render always agree.
 *
 * Returns the redirect target (path + search) or null when already canonical.
 */
export function canonicalProcessDockPath(
  pathname: string,
  search: string,
  preferenceVibe = false,
): string | null {
  const match = pathname.match(/^(\/(?:dock|win))\/(shell|display)\/([^/?]+)\/?$/);
  if (!match) return null;
  const [, layoutSeg, view, pointer] = match;
  if (!DockPointer.isAgenticProcessPointer(pointer)) return null;
  const param = new URLSearchParams(search).get(VIEW_MODE_PARAM);
  const vibe = param ? param === 'vibe' : preferenceVibe;
  const surface = processSurfaceViewType(vibe);
  if (view === surface) return null;
  return `${layoutSeg}/${surface}/${pointer}${search}`;
}
