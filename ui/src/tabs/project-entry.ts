import { DockPointer } from '@src/navigation/DockPointer';
import { refreshAllTabs } from '@src/tabs/all-tabs-store';
import { resolveNextTab, tabInProject, tabIsProcess } from '@src/tabs/tab-candidates';

/**
 * The dock to navigate to when ENTERING a scope — a project (`projectId`) or the
 * Global scope (`projectId === null`). The single "switch scope" resolver shared
 * by every switcher (the strip's `ProjectsCounterChip`, the footer
 * `OpenProjectComponent` modal).
 *
 * Resolves the scope's most-recently-active open tab via `resolveNextTab` (over
 * the canonical one-scope `tabInProject` filter) and returns the dock that tab
 * opens — i.e. navigating to it is identical to clicking that tab in the strip.
 * Falls back to the project landing (or Home for the Global scope) when the scope
 * has no open tab.
 */
export async function dockForScopeEntry(projectId: string | null): Promise<DockPointer> {
  const tabs = (await refreshAllTabs()).filter((t) => tabInProject(t, projectId));
  const dock = resolveNextTab(tabs)?.dockPointer ?? null;
  return dock ?? (projectId == null ? DockPointer.forHome() : DockPointer.forProject(projectId));
}

/** Enter a project scope. Thin alias of {@link dockForScopeEntry}. */
export function dockForProjectEntry(projectId: string): Promise<DockPointer> {
  return dockForScopeEntry(projectId);
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
export function dockForGlobalEntry(): Promise<DockPointer> {
  return dockForScopeEntry(null);
}
