import { DockPointer } from '@src/navigation/DockPointer';
import { allScope, projectScope } from '@src/lib/scope-filter';
import { VIEWER_REGISTRY, ViewType } from '@src/types/ViewType';
import { ContextEntitiesEnum, dataContext, tabHasRecency, tabInProject, tabIsProcess, tabManager } from '@sdk';

/** Whether a view keeps one tab per scope (Assets, Explorer, Desktop) — the
 *  browse surfaces that translate across projects by swapping the scope. */
function isScopeKeyedView(viewType: string | null | undefined): viewType is ViewType {
  return !!viewType && !!VIEWER_REGISTRY[viewType as ViewType]?.scopeKeyed;
}

/**
 * The dock to navigate to when ENTERING a scope — a project (`projectId`) or the
 * Global scope (`projectId === null`). The single "switch scope" resolver shared
 * by every switcher (the nav bar's `RuntimeChip` project list, the footer
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
  const tabs = (await tabManager.refresh()).filter((t) => tabInProject(t, projectId));
  const known = tabs.filter(tabHasRecency);
  const dock = tabManager.resolveNext(known)?.dockPointer ?? null;
  if (dock) return dock as DockPointer;

  if (isScopeKeyedView(currentDock?.viewType)) {
    return new DockPointer(currentDock.viewType, '').withScopeFilter(
      projectId == null ? allScope() : projectScope(projectId),
    );
  }
  // Global entry states its scope EXPLICITLY, Home included — every other
  // branch above already does. An unscoped context-neutral dock is the one
  // shape `adoptScopeProject` reads as "restore the remembered project", so a
  // bare Home would pull the caller back into the project they asked to leave.
  return projectId == null
    ? DockPointer.forHome().withScopeFilter(allScope())
    : DockPointer.forProject(projectId);
}

/**
 * Leave the current project scope: resolve the Global destination, then drop
 * the project from context. Returns the dock for the caller to navigate to.
 *
 * The context write lives here, not in the destination's loader, because the
 * URL cannot carry the distinction. `adoptScopeProject` never writes the
 * project for a globally-scoped dock, and it cannot start: `scope-mode=all` on
 * a browse surface is also what its own "All" scope chip produces, and clearing
 * there would eject a user who merely widened a filter — and disable the chip
 * that takes them back. Nor does "is the view scope-keyed" separate the two:
 * leaving a project FROM Assets/Explorer/Desktop deliberately stays on that
 * surface re-scoped (see above), so both arrive as the same scope-keyed,
 * all-scoped dock. No loader will ever own this write; the verb that ends the
 * membership does, and it is named so the next "leave the project" affordance
 * calls it instead of rediscovering it.
 */
export async function leaveProjectScope(currentDock?: DockPointer | null): Promise<DockPointer> {
  // Resolve while the caller's rows still exist, and clear BEFORE it navigates,
  // so no loader races the write.
  const dock = await dockForGlobalEntry(currentDock);
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
  return dock;
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
  const tabs = (await tabManager.refresh()).filter((t) => tabInProject(t, projectId) && tabIsProcess(t));
  return tabManager.resolveNext(tabs)?.target_id ?? null;
}

/** Enter the Global (projectless) scope. Thin alias of {@link dockForScopeEntry}. */
export function dockForGlobalEntry(currentDock?: DockPointer | null): Promise<DockPointer> {
  return dockForScopeEntry(null, currentDock);
}
