import { Tab } from '@sdk';
import { Monitor } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { refreshAllTabs, useAllTabs } from '@src/tabs/all-tabs-store';
import { closeTabWithLifecycle } from '@src/tabs/tab-lifecycle';
import { useTabStripItems } from '@src/tabs/tab-row-item';
import { tabKey } from '@src/tabs/useTabs';
import { useLingui } from '@lingui/react/macro';

interface WorkspaceChildStripProps {
  /** The workspace's fixed tab (the vibe display / process tab). Children are the
   *  tabs whose `parent_tab_id` is this tab's id. */
  displayTab: Tab | null;
  /** The display's dock pointer — the fixed "Display" chip target. */
  displayDock: DockPointer;
}

/**
 * The workspace's own tab strip: a fixed, non-closable "Display" chip followed
 * by the tabs opened from inside the workspace (its children). Mirrors the hub
 * micro-app's fixed "Active" tab. URL-first throughout — a chip click only
 * navigates; active state comes back from the URL (`currentDock.tabHash`).
 *
 * The children are ORDINARY global tabs (they also appear in the standard global
 * strip); this strip is just a filtered, workspace-local view of them. Grouping
 * (`parent_tab_id`) is minted by the opener context at the tab chokepoint, and
 * vibe-mode continuity by the navigation layer — so this component stays dumb.
 */
export function WorkspaceChildStrip({ displayTab, displayDock }: WorkspaceChildStripProps) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const allTabs = useAllTabs();

  // Children = the global list filtered to this display's tab (backend global
  // order preserved by filtering — no separate ordering).
  const children = useMemo(
    () => (displayTab ? allTabs.filter((tab) => tab.parent_tab_id === displayTab.id && tab.visible !== false) : []),
    [allTabs, displayTab],
  );
  // The child TABS only — the Display is NOT a tab (it renders as a fixed,
  // square header to the left of the strip). The strip starts after it.
  const items: TabStripItem[] = useTabStripItems(children);

  const displayKey = displayDock.tabHash ?? 'workspace-display';
  const activeKey = currentDock?.tabHash ?? '';
  const displayActive = activeKey === displayKey;

  const childByKey = useMemo(() => {
    const m = new Map<string, Tab>();
    for (const tab of children) m.set(tabKey(tab), tab);
    return m;
  }, [children]);

  const handleSelect = useCallback(
    // The strip carries only children now (the Display is the standalone header
    // below), so a select key is always a child tab.
    (key: string) => {
      const tab = childByKey.get(key);
      if (tab?.dockPointer) navigation.openDock(tab.dockPointer);
    },
    [childByKey, navigation],
  );

  const handleClose = useCallback(
    (key: string) => {
      const tab = childByKey.get(key);
      if (!tab) return; // the Display chip is not closable
      // Closing the active child always returns to the Display (the workspace
      // home), never to an arbitrary sibling.
      if (key === activeKey) navigation.openDock(displayDock);
      void closeTabWithLifecycle(tab).finally(() => void refreshAllTabs());
    },
    [childByKey, activeKey, displayDock, navigation],
  );

  return (
    <div className="flex shrink-0 items-stretch border-b border-border bg-muted/20">
      {/* Fixed, SQUARE Display header — deliberately NOT tab-shaped (no rounded
          chip, a solid right border) so it reads as the persistent surface, not
          a closable tab. The child tab strip begins to its right. */}
      <button
        type="button"
        onClick={() => navigation.openDock(displayDock)}
        title={displayTab?.name || t`Display`}
        aria-current={displayActive ? 'true' : undefined}
        data-testid="workspace-display-tab"
        className={`flex h-9 w-9 shrink-0 items-center justify-center border-r border-border transition-colors ${
          displayActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        }`}
      >
        <Monitor className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">
        <TabStrip
          items={items}
          activeKey={activeKey}
          onSelect={handleSelect}
          onClose={handleClose}
          hideCloseAllButton
          testId="workspace-child-strip"
        />
      </div>
    </div>
  );
}

export default WorkspaceChildStrip;
