import { DockPointer } from '@src/navigation/DockPointer';
import { allScope, projectScope } from '@src/lib/scope-filter';
import { VIEWER_REGISTRY, ViewType } from '@src/types/ViewType';
import { refreshAllTabs } from '@src/tabs/all-tabs-store';
import { resolveNextTab, tabHasRecency, tabInProject, tabIsProcess } from '@src/tabs/tab-candidates';

/** Whether a view keeps one tab per scope (Assets, Explorer, Desktop) — the
 *  browse surfaces that translate across projects by swapping the scope. */
function isScopeKeyedView(viewType: string | null | undefined): viewType is ViewType {
  return !!viewType && !!VIEWER_REGISTRY[viewType as ViewType]?.scopeKeyed;
}

/**
 * The dock to navigate to when ENTERING a scope — a project (`projectId`) or the
 * Global scope (`projectId === null`). The single "switch scope" resolver shared
 * by every switcher (the strip's `ProjectsCounterChip`, the footer
 * `OpenProjectComponent` modal).
 *
 * Resolution order:
 *   1. The scope's KNOWN last-active tab — only tabs that carry a
 *      `last_active_at` stamp count (every tab landing stamps it, see
 *      `setupTab`). No recency stamp anywhere means "we don't know", never
 *      "guess by strip order".
 *   2. No known tab: when the CURRENT view is scope-keyed (Assets/Explorer/
 *      Desktop), stay on that view re-scoped to the destination — switching
 *      projects from a browse surface keeps you on that surface.
 *   3. Otherwise the project landing (or Home for the Global scope).
 */
export async function dockForScopeEntry(
  projectId: string | null,
  currentDock?: DockPointer | null,
): Promise<DockPointer> {
  const tabs = (await refreshAllTabs()).filter((t) => tabInProject(t, projectId));
  const known = tabs.filter(tabHasRecency);
  const dock = resolveNextTab(known)?.dockPointer ?? null;
  if (dock) return dock as DockPointer;

  if (isScopeKeyedView(currentDock?.viewType)) {
    return new DockPointer(currentDock.viewType, '').withScopeFilter(
      projectId == null ? allScope() : projectScope(projectId),
    );
  }
  return projectId == null ? DockPointer.forHome() : DockPointer.forProject(projectId);
}

/** Enter a project scope. Thin alias of {@link dockForScopeEntry}. */
export function dockForProjectEntry(projectId: string, currentDock?: DockPointer | null): Promise<DockPointer> {
  return dockForScopeEntry(projectId, currentDock);
}

/** Pick the active AgenticProcess tab for a project, or null when the project
 *  has no process tab. Vibe project switching uses this instead of
 *  dockForProjectEntry because its fallback must be a Vibe empty state, never
 *  project home. */
export async function agenticProcessIdForProjectEntry(projectId: string): Promise<string | null> {
  const tabs = (await refreshAllTabs()).filter((t) => tabInProject(t, projectId) && tabIsProcess(t));
  return resolveNextTab(tabs)?.target_id ?? null;
}

/** Enter the Global (projectless) scope. Thin alias of {@link dockForScopeEntry}. */
export function dockForGlobalEntry(currentDock?: DockPointer | null): Promise<DockPointer> {
  return dockForScopeEntry(null, currentDock);
}
