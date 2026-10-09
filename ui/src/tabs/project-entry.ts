import { DockPointer } from '@src/navigation/DockPointer';
import { allScope, projectScope } from '@src/lib/scope-filter';
import { VIEWER_REGISTRY, ViewType } from '@src/types/ViewType';
import {
  ContextEntitiesEnum,
  dataContext,
  resolveNextTabPure,
  tabHasRecency,
  tabInProject,
  tabManager,
  topLevelTabsForProject,
  type Tab,
} from '@sdk';

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
  const tabs = (await tabManager.snapshotOrRefresh()).filter((t) => tabInProject(t, projectId));
  const dock = tabDock(tabManager.resolveNext(tabs.filter(tabHasRecency)));
  if (dock) return scopedToEntry(dock, projectId);

  if (isScopeKeyedView(currentDock?.viewType)) {
    return new DockPointer(currentDock.viewType, '').withScopeFilter(
      projectId == null ? allScope() : projectScope(projectId),
    );
  }
  // Global entry states its scope EXPLICITLY, Home included — every other
  // branch above already does. An unscoped context-neutral dock is the one
  // shape `adoptScopeProject` reads as "restore the remembered project", so a
  // bare Home would pull the caller back into the project they asked to leave.
  return projectId == null ? globalHomeDock() : DockPointer.forProject(projectId);
}

/** A tab's dock as the UI class. `Tab.dockPointer` is the parsed stored JSON —
 *  hydrate it, or callers chaining `withOption` (`withHomePage`) throw on a plain object. */
export function tabDock(tab: Tab | null | undefined): DockPointer | null {
  return tab?.dockPointer ? new DockPointer(tab.dockPointer) : null;
}

/**
 * The scope's KNOWN last-active top-level tab — what the bar's "Back to tabs"
 * returns to. Same rule as {@link dockForScopeEntry}: only `last_active_at`-stamped
 * tabs count, never a strip-order guess. Pure (it never consumes the manager's
 * pending intent), so it is safe as a store selector.
 */
export function lastKnownTab(tabs: readonly Tab[], projectId: string | null): Tab | null {
  return resolveNextTabPure({ tabs: topLevelTabsForProject(tabs, projectId).filter(tabHasRecency) }).tab;
}

/**
 * A resumed tab's dock, carrying the project being entered in its URL. A stored
 * pointer holds identity only, so a context-neutral tab resumed bare names no
 * project and the switch never happens; an entity-owned dock still corrects it
 * from its own entity, and a dock that already has a scope keeps it.
 * (Not `placeDockInProject`: that one skips entity docks, which need it too.)
 */
function scopedToEntry(dock: DockPointer, projectId: string | null): DockPointer {
  if (projectId == null || dock.scopeFilter) return dock;
  return dock.withScopeFilter(projectScope(projectId));
}

/**
 * Home carrying the all-scope — where the Global scope lands when it has no
 * tab left. A BARE Home is a different place: with no scope and no project its
 * loader restores the remembered project (`adoptScopeProject` → `setupProject`),
 * silently re-entering a project the moment the Global scope is emptied.
 */
export function globalHomeDock(): DockPointer {
  return DockPointer.forHome().withScopeFilter(allScope());
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

/** Enter the Global (projectless) scope. Thin alias of {@link dockForScopeEntry}. */
export function dockForGlobalEntry(currentDock?: DockPointer | null): Promise<DockPointer> {
  return dockForScopeEntry(null, currentDock);
}
