import { DockPointer } from '@src/navigation/DockPointer';
import { refreshAllTabRows } from '@src/tabs/all-tabs-store';
import { resolveNextTabRow } from '@src/tabs/tab-candidates';

/**
 * The dock to navigate to when ENTERING a project — the single "switch to a
 * project" resolver shared by every project switcher (the strip's
 * `ProjectsCounterChip`, the footer `OpenProjectComponent` modal).
 *
 * Resolves the project's most-recently-active open tab via `resolveNextTabRow`
 * and returns the dock that tab opens (`DockPointer.fromTabHash(tab.pointer)`) —
 * i.e. navigating to it is identical to clicking that tab in the strip. Falls
 * back to the project landing when the project has no open tab (the
 * discovered-but-not-yet-opened case the modal can hit; the chip's list only
 * contains projects with ≥1 open tab, so it always resolves a tab).
 */
export async function dockForProjectEntry(projectId: string): Promise<DockPointer> {
  const rows = (await refreshAllTabRows()).filter((r) => r.project_id === projectId);
  const tab = resolveNextTabRow(rows);
  return (tab ? DockPointer.fromTabHash(tab.pointer) : null) ?? DockPointer.forProject(projectId);
}
