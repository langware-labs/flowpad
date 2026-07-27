import { Tab } from '@sdk';
import { Monitor, X } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { refreshAllTabs, useAllTabs } from '@src/tabs/all-tabs-store';
import { resolveNextTab } from '@src/tabs/tab-candidates';
import { closeTabWithLifecycle, excludeClosingTabs, useTabLifecycles } from '@src/tabs/tab-lifecycle';
import { useTabStripItems } from '@src/tabs/tab-row-item';
import { tabKey } from '@src/tabs/useTabs';
import { useLingui } from '@lingui/react/macro';

interface WorkspaceChildStripProps {
  /** The workspace's fixed tab (the vibe display / process tab). Children are the
   *  tabs whose `parent_tab_id` is this tab's id. */
  processTab: Tab | null;
  /** The display's dock pointer — the fixed "Display" chip target. */
  processDock: DockPointer;
  /** The workspace's project scope — used to resolve where to land after the
   *  whole workspace is closed (next tab → project home → base URL). */
  projectId: string | null;
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
export function WorkspaceChildStrip({ processTab, processDock, projectId }: WorkspaceChildStripProps) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const allTabs = useAllTabs();

  // Children = the global list filtered to this display's tab (backend global
  // order preserved by filtering — no separate ordering).
  const lifecycles = useTabLifecycles();
  const children = useMemo(
    () =>
      processTab
        ? excludeClosingTabs(
            allTabs.filter((tab) => tab.parent_tab_id === processTab.id && tab.visible !== false),
            lifecycles,
          )
        : [],
    [allTabs, processTab, lifecycles],
  );
  // The child TABS only — the Display is NOT a tab (it renders as a fixed,
  // square header to the left of the strip). The strip starts after it.
  const items: TabStripItem[] = useTabStripItems(children);

  const processKey = processDock.tabHash ?? 'workspace-display';
  const activeKey = currentDock?.tabHash ?? '';
  const processActive = activeKey === processKey;

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
      void closeTabWithLifecycle(tab).finally(() => void refreshAllTabs());
    },
    [childByKey, activeKey, processDock, navigation],
  );

  // Close the WHOLE workspace: the process/display anchor tab plus every child
  // it opened. Backend close doesn't cascade to children, so we close each one
  // explicitly. Then land on the next view via the same resolver the global
  // strip uses (`resolveNextTab` → project home → base URL). URL-first: the
  // handler only navigates; the loader is the single writer.
  const handleCloseWorkspace = useCallback(() => {
    if (!processTab) return;
    const closing = [...children, processTab]; // children first, then the anchor
    const closingIds = new Set(closing.map((t) => t.id));
    const remaining = allTabs.filter((t) => !closingIds.has(t.id));
    const next = resolveNextTab(remaining, undefined, projectId);
    if (next?.dockPointer) navigation.openDock(next.dockPointer);
    else if (projectId) navigation.openDock(DockPointer.forProject(projectId));
    else navigation.closeDock();
    void Promise.allSettled(closing.map((t) => closeTabWithLifecycle(t))).finally(
      () => void refreshAllTabs(),
    );
  }, [processTab, children, allTabs, projectId, navigation]);

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
        className={`relative flex h-9 w-9 shrink-0 items-center justify-center border-r border-border transition-colors ${
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
        {processActive && (
          <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary" />
        )}
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
      {/* Far-right Close control — tears down the whole workspace (process +
          display + every child tab). Sized/styled to match the display
          toolbar's icon buttons. */}
      {processTab && (
        <div className="flex shrink-0 items-center border-l border-border px-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                data-testid="close-vibe-workspace"
                aria-label={t`Close workspace`}
                onClick={handleCloseWorkspace}
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t`Close workspace`}</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

export default WorkspaceChildStrip;
