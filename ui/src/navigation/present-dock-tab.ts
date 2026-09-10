import { tabManager } from '@sdk';
import { highlightTab } from '@src/tabs/tab-highlight';
import { DockPointer } from './DockPointer';
import { projectScope } from '@src/lib/scope-filter';

/** Shared by agent shows and user opens; focus remains the caller's choice. */
export async function presentDockTab(
  dock: DockPointer,
  placement: { afterTabId?: string | null; parentTabId?: string | null; projectId?: string | null },
): Promise<DockPointer> {
  // Rebasing preserves one tab per document instead of replacing the Assets browser.
  let placed = DockPointer.rebaseAssetsOntoProject(dock, placement.projectId);
  // Raw files and URLs have no entity from which the tab can inherit a project.
  if (placement.projectId && !placed.targetTypeId && placed.scopeFilter === null) {
    placed = placed.withScopeFilter(projectScope(placement.projectId));
  }
  await tabManager.ensureDock(placed, { afterTabId: placement.afterTabId, parentTabId: placement.parentTabId });
  // ensureDock returns a scoped list; only the unscoped list can be adopted globally.
  tabManager.adoptGlobal(await tabManager.listAll());
  if (placed.tabHash) highlightTab(placed.tabHash);
  return placed;
}
