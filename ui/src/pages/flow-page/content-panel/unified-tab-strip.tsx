/**
 * UnifiedTabStrip — the content-panel header strip (docs/tab-management.md).
 *
 * ONE ordered list, backend-owned. The strip renders exactly the tabs the `tab`
 * action returns, in global order, read from the single `all-tabs-store`.
 * `scope='project'` (default) shows the active project + projectless tabs (the
 * backend `filter_for_project` rule, applied client-side); `scope='all'` shows
 * every project's tabs (the developer sessions view). There is no reactive entity
 * query and no second store.
 *
 * URL-first (non-negotiable): a chip click only calls `navigation.*`; the active
 * chip is `currentDock.tabHash`; the loader is the single writer that materializes
 * the Tab. Every chip — terminal or content — is keyed by its `dockPointer.tabHash`,
 * so there is no kind-branching here.
 *
 * The controller is kept ONLY for the surrounding controls: leading/trailing
 * toolbars, the new-tab menu, spawn modals, and the close-shortcut label.
 */
import { Project, Tab } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { TabStrip } from '@src/components/tabs/TabStrip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTabStripItems } from '@src/tabs/tab-row-item';
import { resolveNextTab } from '@src/tabs/tab-candidates';
import { applyPredictedOrder, refreshAllTabs, useAllTabs } from '@src/tabs/all-tabs-store';
import { closeTabWithLifecycle } from '@src/tabs/tab-lifecycle';
import { uniqueTabsByDockKey, useCurrentTabs, useSyncContentTabNames } from '@src/tabs/useTabs';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import React, { useCallback, useEffect, useMemo } from 'react';
import { useNavigation } from 'react-router';

export interface UnifiedTabStripProps {
  /** `'project'` (default) shows the active project + projectless tabs; `'all'`
   *  shows every project's tabs (the developer sessions view). */
  scope?: 'project' | 'all';
}

export const UnifiedTabStrip: React.FC<UnifiedTabStripProps> = ({ scope = 'project' }) => {
  const { navigation, currentDock } = useDockNavigation();
  const { t } = useLingui();
  const controller = useTerminalStripController({ addTabButton: true });

  const projectId = controller.tabsProjectId ?? null;
  // One source: the global `tab` list, filtered to the strip's scope. `'project'`
  // = the active project + projectless tabs (the backend `filter_for_project`
  // rule), in the backend's global order (preserved by the filter).
  const allTabs = useAllTabs();
  // Keep content-tab chip labels in step with their backing entities (generic
  // entity → tab name mirror; terminals keep their own auto-rename path).
  useSyncContentTabNames();
  const currentTabs = useCurrentTabs();
  const globalTabs = useMemo(() => uniqueTabsByDockKey(allTabs), [allTabs]);
  const tabs = scope === 'all' ? globalTabs : currentTabs;
  const baseItems = useTabStripItems(tabs);
  const tabByKey = useMemo(() => {
    const m = new Map<string, Tab>();
    for (const t of tabs) {
      const key = t.dockPointer?.tabHash ?? t.id;
      m.set(key, t);
    }
    return m;
  }, [tabs]);

  // "Open Project" — the footer's project-name shortcut surfaced on the chip
  // menu as a distinguished (emphasized) header entry. Owner-injected so the
  // mapper stays a pure display layer and other strips (e.g. the vibe
  // workspace child strip) don't inherit it. Navigates to the TAB's own
  // project home, URL-first; global (projectless) tabs skip it.
  const items = useMemo(() => {
    const openProjectLabel = t`Open Project`;
    const ProjectIcon = iconForType(Project.type);
    return baseItems.map((item) => {
      const projectId = tabByKey.get(item.key)?.project_id;
      if (!projectId) return item;
      return {
        ...item,
        contextMenuItems: [
          {
            label: openProjectLabel,
            Icon: ProjectIcon,
            emphasized: true,
            onSelect: () => navigation.openDock(DockPointer.forProject(projectId)),
          },
          ...(item.contextMenuItems ?? []),
        ],
      };
    });
  }, [baseItems, tabByKey, navigation, t]);

  // Active highlight is the URL, full stop (every chip is keyed by its tabHash).
  const activeKey = currentDock?.tabHash ?? '';

  // A tab click navigates URL-first (click → navigate → loader → context). Under
  // load the target route's loader can still be resolving when the user closes
  // that SAME tab (click, then X a moment later) — so the committed `currentDock`
  // (hence `activeKey`) still names the PREVIOUS tab, `handleClose`'s active-close
  // branch is skipped, and the in-flight navigation later commits the URL onto the
  // tab that was just closed (a dead pointer, no self-heal). React-router's data
  // router exposes that in-flight target as `navigation.location`; treat the
  // closing tab as "the one on screen" when it matches EITHER the committed dock
  // OR that pending target, so the close still heals to a surviving tab. Purely
  // additive: with no navigation in flight `pendingActiveKey` is null and the
  // behavior is identical to `key === activeKey`.
  const routerNavigation = useNavigation();
  const pendingActiveKey = useMemo(() => {
    const loc = routerNavigation.location;
    if (!loc) return null;
    try {
      return DockPointer.fromUrl(`${loc.pathname}${loc.search}`).tabHash;
    } catch {
      return null;
    }
  }, [routerNavigation.location]);
  const isCurrentTab = useCallback(
    (key: string) => key !== '' && (key === activeKey || key === pendingActiveKey),
    [activeKey, pendingActiveKey],
  );

  const handleSelect = useCallback(
    (key: string) => {
      const tab = tabByKey.get(key);
      if (!tab?.dockPointer) return;
      navigation.openDock(tab.dockPointer);
    },
    [tabByKey, navigation],
  );

  const handlePopout = useCallback(
    (key: string) => {
      const tab = tabByKey.get(key);
      if (!tab?.dockPointer) return;
      navigation.openDockInWindow(tab.dockPointer);
    },
    [tabByKey, navigation],
  );

  // Where to go when the active tab(s) close: the next tab in the current
  // project (confined to its scope — `resolveNextTab` with `projectId`), or the
  // project home (`DockPointer.forProject`, which renders `ProjectHome`) when the
  // project has no tabs left. Closing a project's last tab lands on its project
  // home rather than jumping to a tab in another project — same destination a
  // fresh project entry resolves to (`dockForProjectEntry`). Falls back to Home
  // only when there's no project scope at all.
  const navigateAfterClose = useCallback(
    (closing: Tab[]) => {
      const closingIds = new Set(closing.map((t) => t.id));
      const remaining = allTabs.filter((t) => !closingIds.has(t.id));
      const next = resolveNextTab(remaining, new Set(), projectId);
      if (next?.dockPointer) navigation.openDock(next.dockPointer);
      else if (projectId) navigation.openDock(DockPointer.forProject(projectId));
      else navigation.closeDock();
    },
    [allTabs, projectId, navigation],
  );

  const handleClose = useCallback(
    (key: string) => {
      const tab = tabByKey.get(key);
      if (!tab) return;
      if (isCurrentTab(key)) navigateAfterClose([tab]);
      void closeTabWithLifecycle(tab).finally(() => void refreshAllTabs());
    },
    [tabByKey, isCurrentTab, navigateAfterClose],
  );

  const handleCloseMany = useCallback(
    (keys: string[]) => {
      const closing = keys.map((k) => tabByKey.get(k)).filter((t): t is Tab => t != null);
      if (keys.some((k) => isCurrentTab(k))) navigateAfterClose(closing);
      void Promise.allSettled(closing.map((t) => closeTabWithLifecycle(t))).finally(() => void refreshAllTabs());
    },
    [tabByKey, isCurrentTab, navigateAfterClose],
  );

  const handleRename = useCallback(
    (key: string, newName: string) => {
      const tab = tabByKey.get(key);
      if (!tab) return;
      void Tab.renameById(tab.id, newName).then(() => void refreshAllTabs());
    },
    [tabByKey],
  );

  // Drag-reorder: optimistic predict on the store; commit posts Tab.reorder and a
  // refresh adopts the canonical order (a cancel just refreshes back to truth).
  const handleReorderPreview = useCallback(
    (reorderKey: string, afterKey: string | null, beforeKey: string | null) => {
      const id = tabByKey.get(reorderKey)?.id;
      if (!id) return;
      applyPredictedOrder(
        id,
        afterKey ? (tabByKey.get(afterKey)?.id ?? null) : null,
        beforeKey ? (tabByKey.get(beforeKey)?.id ?? null) : null,
      );
    },
    [tabByKey],
  );

  const handleReorderCommit = useCallback(
    (reorderKey: string, afterKey: string | null, beforeKey: string | null) => {
      const id = tabByKey.get(reorderKey)?.id;
      if (!id) return;
      const afterId = afterKey ? (tabByKey.get(afterKey)?.id ?? null) : null;
      const beforeId = beforeKey ? (tabByKey.get(beforeKey)?.id ?? null) : null;
      void Tab.reorder(id, afterId, beforeId, projectId).finally(() => void refreshAllTabs());
    },
    [tabByKey, projectId],
  );

  // Keyboard shortcuts (the strip owns them): mod+W close active, mod+T new
  // terminal, mod+PgUp/PgDn cycle. Mac=Ctrl, Windows=Meta, Linux=Alt.
  useEffect(() => {
    const osPlatform: string =
      (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
      navigator.userAgent;
    const modKey = /Mac/i.test(osPlatform) ? 'Ctrl' : /Win/i.test(osPlatform) ? 'Meta' : 'Alt';
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = modKey === 'Ctrl' ? e.ctrlKey : modKey === 'Meta' ? e.metaKey : e.altKey;
      if (!mod) return;
      if (e.key === 'w' || e.key === 'W') {
        if (!activeKey || !tabByKey.has(activeKey)) return;
        e.preventDefault();
        handleClose(activeKey);
      } else if (e.key === 't' || e.key === 'T') {
        // mod+T = New Terminal, matching the advertised labels. Claude gets no
        // binding: the mod is Ctrl on Mac, and Ctrl+C is terminal interrupt.
        e.preventDefault();
        void controller.handleStartTerminal();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        const idx = tabs.findIndex((t) => (t.dockPointer?.tabHash ?? t.id) === activeKey);
        if (idx > 0) handleSelect(tabs[idx - 1].dockPointer?.tabHash ?? tabs[idx - 1].id);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        const idx = tabs.findIndex((t) => (t.dockPointer?.tabHash ?? t.id) === activeKey);
        if (idx >= 0 && idx < tabs.length - 1) handleSelect(tabs[idx + 1].dockPointer?.tabHash ?? tabs[idx + 1].id);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [activeKey, tabs, tabByKey, handleClose, handleSelect, controller]);

  return (
    <>
      <TabStrip
        items={items}
        activeKey={activeKey}
        onSelect={handleSelect}
        onClose={handleClose}
        onCloseMany={handleCloseMany}
        onRename={handleRename}
        onPopout={handlePopout}
        onReorderPreview={handleReorderPreview}
        onReorderCommit={handleReorderCommit}
        onReorderCancel={() => void refreshAllTabs()}
        newTabMenuItems={controller.newTabMenuItems}
        closeShortcutLabel={controller.closeShortcutLabel}
        leading={controller.leading}
        trailing={controller.trailing}
      />
      {controller.modals}
    </>
  );
};

export default UnifiedTabStrip;
