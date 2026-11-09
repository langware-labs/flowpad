import { tabManager, type TabList } from '@sdk';
import { highlightTab } from '@src/tabs/tab-highlight';
import { DockPointer } from './DockPointer';
import { ViewType } from '../types/ViewType';
import { projectScope } from '@src/lib/scope-filter';

/** The dock as it is presented inside `projectId` — the same address a tab or a URL carries. */
export function placeDockInProject(dock: DockPointer, projectId: string | null | undefined): DockPointer {
  // Rebasing preserves one tab per document instead of replacing the Assets browser.
  const placed = DockPointer.rebaseAssetsOntoProject(dock, projectId);
  // Raw files and URLs have no entity from which the tab can inherit a project.
  if (!projectId) return placed;
  if (!placed.targetTypeId) return placed.scopeFilter === null ? placed.withScopeFilter(projectScope(projectId)) : placed;
  // An entity's tab would otherwise go to the entity's own project, a strip the person may not be on.
  return placed.viewType === ViewType.PROJECT ? placed : placed.presentedInProject(projectId);
}

/** Shared by agent shows and user opens; focus remains the caller's choice. */
export async function presentDockTab(
  dock: DockPointer,
  placement: { afterTabId?: string | null; parentTabId?: string | null; projectId?: string | null },
): Promise<DockPointer> {
  const placed = placeDockInProject(dock, placement.projectId);
  const ensured = await tabManager.ensureDock(placed, {
    afterTabId: placement.afterTabId,
    parentTabId: placement.parentTabId,
    viewMode: placed.viewMode,
  });
  // ensureDock already adopted the global list when the backend sent one; an older backend doesn't.
  if (!ensured.all) {
    const tabs: TabList = await tabManager.listAll();
    tabManager.adoptGlobal(tabs, tabs.version);
  }
  if (placed.tabHash) highlightTab(placed.tabHash);
  return placed;
}
