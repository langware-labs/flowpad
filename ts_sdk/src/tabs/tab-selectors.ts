import { type ITab, Tab } from '../entities/tab';
import { EntityTypes } from '../schema/types';

export type TabScope = 'project' | 'all';

export interface TabProjectCounts {
  counts: ReadonlyMap<string, number>;
  globalTabCount: number;
}

/** Canonical tab identity used by strips and lifecycle state. */
export function tabKey(tab: Tab): string {
  return tab.getKey();
}

export function uniqueTabsByDockKey(tabs: readonly Tab[]): Tab[] {
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    const key = tabKey(tab);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function tabTargetKey(tab: Tab): string {
  return `${tab.target_type}-${tab.target_id}`;
}

export function tabInProject(tab: Tab, projectId: string | null): boolean {
  return tab.project_id === projectId;
}

/** Epoch milliseconds of a tab's activation stamp, tolerating legacy ISO values. */
export function tabLastActiveMs(tab: Tab): number | null {
  const raw = tab.last_active_at;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function tabHasRecency(tab: Tab): boolean {
  return tabLastActiveMs(tab) != null;
}

export function tabIsProcess(tab: Tab): boolean {
  return tab.target_type === EntityTypes.AgenticProcess;
}

export function isWorkspaceChild(tab: Tab | ITab): boolean {
  return tab.parent_tab_id != null;
}

export function tabsForProject(tabs: readonly Tab[], projectId: string | null): Tab[] {
  return tabs.filter((tab) => tabInProject(tab, projectId));
}

export function topLevelTabsForProject(tabs: readonly Tab[], projectId: string | null): Tab[] {
  return uniqueTabsByDockKey(tabsForProject(tabs, projectId).filter((tab) => !isWorkspaceChild(tab)));
}

export function childrenOfTab(tabs: readonly Tab[], parentTabId: string): Tab[] {
  return tabs.filter((tab) => tab.parent_tab_id === parentTabId && tab.visible !== false);
}

export function terminalTabsForScope(
  tabs: readonly Tab[],
  scope: TabScope,
  projectId: string | null,
): Tab[] {
  const terminals = tabs.filter(
    (tab) => tab.target_type === EntityTypes.Shell || tab.target_type === EntityTypes.AgenticProcess,
  );
  if (scope === 'all') return uniqueTabsByDockKey(terminals);
  return uniqueTabsByDockKey(terminals.filter((tab) => tabInProject(tab, projectId)));
}

export function tabForDockKey(tabs: readonly Tab[], key: string | null | undefined): Tab | null {
  if (!key) return null;
  return tabs.find((tab) => tabKey(tab) === key) ?? null;
}

export function tabForTargetId(tabs: readonly Tab[], targetId: string): Tab | null {
  return tabs.find((tab) => tab.target_id === targetId) ?? null;
}

export function openTabHashes(tabs: readonly Tab[]): Set<string> {
  const hashes = tabs
    .map((tab) => tab.dockPointer?.tabHash)
    .filter((hash): hash is string => Boolean(hash));
  return new Set(hashes);
}

export function openTabTargetIds(tabs: readonly Tab[]): Set<string> {
  const targetIds = tabs
    .map((tab) => tab.target_id)
    .filter((targetId): targetId is string => Boolean(targetId));
  return new Set(targetIds);
}

export function projectTabCounts(tabs: readonly Tab[]): TabProjectCounts {
  const counts = new Map<string, number>();
  let globalTabCount = 0;

  for (const tab of tabs) {
    const projectId = tab.project_id ?? null;
    if (projectId === null) {
      globalTabCount += 1;
      continue;
    }
    if (tab.target_type === EntityTypes.Project) continue;
    counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
  }

  return { counts, globalTabCount };
}
