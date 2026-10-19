import { tabKey, tabManager, Tab } from '@sdk';
import { Monitor } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTabCloser } from '@src/tabs/tab-close-request';
import { closeTabWithLifecycle } from '@src/tabs/tab-content-lifecycle';
import { useTabStripItems } from '@src/tabs/tab-row-item';
import { useTabLifecycles, useWorkspaceChildren } from '@src/tabs/use-tab-manager';
import { useLingui } from '@lingui/react/macro';

interface WorkspaceChildStripProps {
  /** The workspace's fixed tab (the vibe display / process tab). Children are the
   *  tabs whose `parent_tab_id` is this tab's id. */
  processTab: Tab | null;
  /** The display's dock pointer — the fixed "Display" chip target. */
  processDock: DockPointer;
}

/**
 * The workspace's own tab strip: a fixed, non-closable "Display" chip followed
 * by the tabs opened from inside the workspace (its children). Mirrors the hub
 * micro-app's fixed "Active" tab. URL-first throughout — a chip click only
 * navigates; active state comes back from the URL (`currentDock.tabHash`).
 *
 * The children are ordinary `Tab` rows nested under the Vibe tab (the global
 * strip shows only top-level tabs); this strip is the workspace-local view of
 * them. Grouping (`parent_tab_id`) is minted by the opener context at the tab
 * chokepoint, and vibe-mode continuity by the navigation layer — so this
 * component stays dumb. The workspace itself closes from its chip in the global
 * strip, and the backend closes its children with it (`Tab.close`).
 */
export function WorkspaceChildStrip({ processTab, processDock }: WorkspaceChildStripProps) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();

  // Children = the global list filtered to this display's tab (backend global
  // order preserved by filtering — no separate ordering).
  useTabLifecycles();
  const workspaceChildren = useWorkspaceChildren(processTab?.id);
  const children = tabManager.lifecycle.excludeClosing(workspaceChildren);
  // The workspace's OWN active display is already the fixed "Display" square, so
  // its adopted child row must not ALSO be a chip. Dropped from the STRIP only.
  const visibleChildren = useMemo(
    () => children.filter((tab) => !(tab.dockPointer && new DockPointer(tab.dockPointer).isActiveDisplay)),
    [children],
  );
  // The child TABS only — the Display is NOT a tab (it renders as a fixed,
  // square header to the left of the strip). The strip starts after it.
  const items: TabStripItem[] = useTabStripItems(visibleChildren);

  const processKey = processDock.tabHash ?? 'workspace-display';
  const activeKey = currentDock?.tabHash ?? '';
  // The active display's dock is keyed by `ACTIVE_DISPLAY_HASH_NS`, not the
  // process's tabHash, so a plain comparison never lit the square for it — and
  // with no chip in the strip either, nothing marked the Display as active.
  const processActive = activeKey === processKey || !!currentDock?.isActiveDisplay;

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
      if (key === activeKey) navigation.openDock(processDock);
      void closeTabWithLifecycle(tab).finally(() => void tabManager.refresh());
    },
    [childByKey, activeKey, processDock, navigation],
  );

  // Content asking to close the tab it is shown in closes it the same way the X does.
  useTabCloser(childByKey, handleClose);

  return (
    <div className="flex shrink-0 items-stretch border-b border-border bg-muted/20">
      {/* Fixed, SQUARE Display header — deliberately NOT tab-shaped (no rounded
          chip, a solid right border) so it reads as the persistent surface, not
          a closable tab. The child tab strip begins to its right. */}
      <button
        type="button"
        onClick={() => navigation.openDock(processDock)}
        title={processTab?.name || t`Display`}
        aria-current={processActive ? 'true' : undefined}
        data-testid="workspace-display-tab"
        className={`relative flex h-9 w-9 shrink-0 items-center justify-center border-e border-border transition-colors ${
          processActive
            ? // Match the child tabs' active treatment (TabStrip): raised body
              // surface + shadow + a primary top accent. The narrow square loses
              // a plain bg swap, so it needs the same strong, theme-aware cue.
              'bg-background text-primary shadow-sm'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        }`}
      >
        {/* Active accent — mirrors the tab chip's top bar so the Display reads
            as the selected tab it is; absolute so it never shifts the icon. */}
        {processActive && <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary" />}
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
