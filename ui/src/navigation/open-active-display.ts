import type { ShowTarget } from '@sdk';
import { ViewMode } from '@src/contexts/view-mode-context';
import { DockPointer } from './DockPointer';
import {dockForDisplayTarget} from './display-target-pointer';

import { shellIdFromShowTarget } from './shell-show-target';
import type { NavigationActions } from './NavigationActions';

/**
 * A BARE port — a dev server with no artifact behind it.
 *
 * The one display target with no address: `/dock/web-app?port=` folds every port
 * into a single tab, so it cannot carry a workspace's display identity. An `app`
 * IS addressable (the artifact is its identity, `ViewType.APP` renders it), so it
 * is excluded here even though it also carries a port.
 *
 * Every path that turns a show into an address must refuse the same set, which is
 * why this is exported rather than re-spelled per caller.
 */
export function isPortDisplayTarget(target: ShowTarget | null | undefined): boolean {
  return target?.kind === 'webapp' || (target?.kind === 'app' && !target.artifact_id && !target.typeid);
}

/**
 * The address a `flow show` target takes inside a workspace, or null when it has
 * none — the single definition of "what the active display can address".
 *
 * Shared by the two paths that must never disagree: the live show
 * ({@link openActiveDisplay}) and the cold-entry restore
 * (`restoreDisplayRedirect` in `load-shell.ts`). They used to hold two copies of
 * these four rules, kept in step by a comment; a fifth target kind would have made
 * a reload and a live show land in different places.
 *
 * Null for a SHELL target (an address, not content — it is hosted as its own child
 * tab, the same way a journey's `open_terminal` act reaches the workspace), for a
 * bare port (see {@link isPortDisplayTarget}), and for a target that addresses
 * nothing openable (an entity type with no editor and no path — a real answer; the
 * target still lives in the display history).
 */
export function activeDisplayDock(
  target: ShowTarget | null | undefined,
  { host, projectId }: { host: string | null; projectId: string | null },
): DockPointer | null {
  if (!target || shellIdFromShowTarget(target) || isPortDisplayTarget(target)) return null;
  const dock = dockForDisplayTarget(target);
  if (!dock) return null;

  // Rebase onto the host's project before anything else. A bare ASSETS dock is
  // SCOPE-KEYED — `tabHash` folds every sub-pointer of a scope into one tab — so an
  // un-rebased document would hijack that scope's existing Assets tab and rename it
  // instead of getting an identity of its own.
  return DockPointer.rebaseAssetsOntoProject(dock, projectId)
    .withViewMode(ViewMode.Vibe)
    .withHost(host)
    .withActiveDisplay(true);
}

export interface OpenActiveDisplayArgs {
  target: ShowTarget;
  navigation: NavigationActions;
  /** The workspace host, as the POINTER form `agentic_process-<uuid>`. */
  host: string | null;
  /** The host process's project, for rebasing an assets-shaped dock. */
  projectId: string | null;
  /** The dock currently on screen, to skip a no-op commit. */
  currentDock: DockPointer | null;
  /**
   * PUSH this one instead of replacing. True for the first show after a mount:
   * with pure replace the first show would overwrite the URL the user arrived on,
   * so Back would leave the workspace entirely instead of returning to it.
   */
  push?: boolean;
}

/**
 * Point a vibe workspace's DISPLAY at a `flow show` target — by navigating.
 *
 * This is the whole of "show" in vibe. The display used to be React state pinned by
 * an entity event, restored from `context_data.last_shown` on mount, with three
 * delivery channels and a freshness baseline to keep them from fighting. It is now
 * one navigation: the URL names the deliverable, and the route renders it. Reload,
 * Back, share and popout come for free because they were never display features —
 * they are URL features the display was opting out of.
 *
 * Returns whether it handled the target, so the caller can fall back for the kinds
 * the pane still owns (see {@link activeDisplayDock} for what has no address).
 */
export function openActiveDisplay({
  target,
  navigation,
  host,
  projectId,
  currentDock,
  push = false,
}: OpenActiveDisplayArgs): boolean {
  const shellId = shellIdFromShowTarget(target);
  if (shellId) {
    void navigation.openShell(shellId, { viewMode: ViewMode.Vibe, host: host ?? undefined });
    return true;
  }

  const placed = activeDisplayDock(target, { host, projectId });
  if (!placed) return false;

  // Same target twice is not a no-op upstream — the caller still bumps its cache
  // key, which is how a rebuild behind an unchanged URL still reloads. It is only
  // the NAVIGATION that would be redundant.
  if (currentDock?.equals(placed)) return true;

  if (push) navigation.openDock(placed);
  else navigation.replaceDock(placed);
  return true;
}
