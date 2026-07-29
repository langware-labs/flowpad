import { DockPointer } from './DockPointer';
import { isContentAssetDock } from './content-asset-dock';
import { ViewType } from '@src/types/ViewType';

/**
 * A PLAIN shell dock — a terminal, not a session anchor.
 *
 * The process's own dock is ALSO `ViewType.SHELL` (pointer
 * `agentic_process-<id>`): that tab is the workspace ANCHOR the vibe layout is
 * mounted over, and adopting it would nest a workspace inside itself — the
 * shell-under-display corruption the parent invariant exists to prevent. A bare
 * `<id>` pointer addresses a Shell too (see
 * `DockPointer.terminalTargetTypeIdForShellPointer`), so the test is "not the
 * process", not "starts with shell-". `new_terminal` is the launcher landing,
 * which redirects into a real shell before any tab is materialized.
 */
export function isPlainShellDock(dock: DockPointer): boolean {
  if (dock.viewType !== ViewType.SHELL) return false;
  const pointer = dock.pointer?.trim();
  if (!pointer || pointer === 'new_terminal') return false;
  return !DockPointer.isAgenticProcessPointer(pointer);
}

/**
 * May this dock join a mounted workspace as a CHILD (`Tab.parent_tab_id`)?
 *
 * Content assets/files, plus a plain terminal: a shell opened from inside the
 * vibe workspace is content in its display area, the same as a file, and the
 * display pane already renders one (`ContentPanel`'s `ViewType.SHELL` case).
 * Navigation surfaces (assets lists, project home, explorer) and workspace
 * anchors (the process dock, a project dock) are navigations AWAY and stay out.
 *
 * Deliberately SEPARATE from `isContentAssetDock`, which answers a different
 * question — "is this a single asset surface" — and drives asset-specific
 * behavior: the `AssetVibeWorkspace` host switch and shell-dock scope seeding.
 * Widening that predicate to cover terminals would silently change both. The
 * backend mirrors this allow-list in `_pointer_is_adoptable_child` (tab.py).
 */
export function isAdoptableChildDock(dock: DockPointer): boolean {
  return isContentAssetDock(dock) || isPlainShellDock(dock);
}
