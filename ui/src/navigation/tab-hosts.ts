import { ViewType, VIEWER_REGISTRY } from '@src/types/ViewType';
import { DockPointer } from './DockPointer';
import { isAdoptableChildDock } from './adoptable-child-dock';

/**
 * HOST tabs — tabs that draw their own nested strip of child tabs, one level deep.
 *
 * A view declares itself a host with `hostsTabs` in `VIEWER_REGISTRY`; this module
 * says which docks each host accepts as children. The backend mirrors it in
 * `_HOST_CHILD_RULES` (`flow_sdk/builtin/tab.py`), and
 * `tests/fixtures/tab_host_children.json` pins both sides to the same answers.
 *
 * Depth is 1 by construction: a host dock is a workspace ANCHOR
 * (`isWorkspaceAnchorDock`), and no host accepts an anchor as a child.
 */
export interface TabHost {
  /** The host's view type — also the key `_HOST_CHILD_RULES` uses. */
  viewType: ViewType;
  /** May `child` join this host as a nested tab? `shown`: the agent presented it. */
  accepts(child: DockPointer, opts?: { shown?: boolean }): boolean;
}

const HOSTS: Partial<Record<ViewType, TabHost>> = {
  // Vibe: content assets/files, plain terminals, running apps; any non-anchor the
  // agent showed. Exactly the rule the workspace had before it was a tab type.
  [ViewType.VIBE]: { viewType: ViewType.VIBE, accepts: isAdoptableChildDock },
};

/** The host a view type is, or null for a leaf view. */
export function tabHostFor(viewType: ViewType | null | undefined): TabHost | null {
  if (!viewType || !VIEWER_REGISTRY[viewType]?.hostsTabs) return null;
  return HOSTS[viewType] ?? null;
}

/** Is this dock itself a host tab (as opposed to a child or a leaf)? */
export function isHostDock(dock: DockPointer | null | undefined): boolean {
  return !!dock && tabHostFor(dock.viewType) !== null;
}
