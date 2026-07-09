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
  const childItems = useTabStripItems(children);

  const displayKey = displayDock.tabHash ?? 'workspace-display';
  const items: TabStripItem[] = useMemo(() => {
    const displayItem: TabStripItem = {
      key: displayKey,
      title: displayTab?.name || t`Display`,
      icon: <Monitor className="h-3.5 w-3.5" />,
      closable: false,
      renameable: false,
      testId: 'workspace-display-tab',
    };
    return [displayItem, ...childItems];
  }, [displayKey, displayTab?.name, childItems, t]);

  const activeKey = currentDock?.tabHash ?? '';

  const childByKey = useMemo(() => {
    const m = new Map<string, Tab>();
    for (const tab of children) m.set(tabKey(tab), tab);
    return m;
  }, [children]);

  const handleSelect = useCallback(
    (key: string) => {
      if (key === displayKey) {
        navigation.openDock(displayDock);
        return;
      }
      const tab = childByKey.get(key);
      if (tab?.dockPointer) navigation.openDock(tab.dockPointer);
    },
    [displayKey, displayDock, childByKey, navigation],
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
    <div className="shrink-0 border-b border-border bg-muted/20">
      <TabStrip
        items={items}
        activeKey={activeKey}
        onSelect={handleSelect}
        onClose={handleClose}
        hideCloseAllButton
        testId="workspace-child-strip"
      />
    </div>
  );
}

export default WorkspaceChildStrip;
