import { DockPointer } from '@src/navigation/DockPointer';
import { refreshAllTabs } from '@src/tabs/all-tabs-store';
import { resolveNextTab } from '@src/tabs/tab-candidates';

/**
 * The dock to navigate to when ENTERING a project — the single "switch to a
 * project" resolver shared by every project switcher (the strip's
 * `ProjectsCounterChip`, the footer `OpenProjectComponent` modal).
 *
 * Resolves the project's most-recently-active open tab via `resolveNextTab`
 * and returns the dock that tab opens — i.e. navigating to it is identical to
 * clicking that tab in the strip. Falls back to the project landing when the
 * project has no open tab (the discovered-but-not-yet-opened case the modal
 * can hit; the chip's list only contains projects with ≥1 open tab, so it
 * always resolves a tab).
 */
export async function dockForProjectEntry(projectId: string): Promise<DockPointer> {
  const tabs = (await refreshAllTabs()).filter((t) => t.project_id === projectId);
  const tab = resolveNextTab(tabs);
  return (tab ? tab.dockPointer : null) ?? DockPointer.forProject(projectId);
}
