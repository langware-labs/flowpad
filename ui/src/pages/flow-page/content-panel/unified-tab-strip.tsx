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
import { Tab } from '@sdk';
import { TabStrip } from '@src/components/tabs/TabStrip';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTabStripItems } from '@src/tabs/tab-row-item';
import { resolveNextTab } from '@src/tabs/tab-candidates';
import { applyPredictedOrder, refreshAllTabs, useAllTabs } from '@src/tabs/all-tabs-store';
import { closeTabWithLifecycle } from '@src/tabs/tab-lifecycle';
import { uniqueTabsByDockKey, useCurrentTabs, useSyncContentTabNames } from '@src/tabs/useTabs';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import React, { useCallback, useEffect, useMemo } from 'react';

export interface UnifiedTabStripProps {
  /** `'project'` (default) shows the active project + projectless tabs; `'all'`
   *  shows every project's tabs (the developer sessions view). */
  scope?: 'project' | 'all';
}

export const UnifiedTabStrip: React.FC<UnifiedTabStripProps> = ({ scope = 'project' }) => {
  const { navigation, currentDock } = useDockNavigation();
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
  const items = useTabStripItems(tabs);
  const tabByKey = useMemo(() => {
    const m = new Map<string, Tab>();
    for (const t of tabs) {
      const key = t.dockPointer?.tabHash ?? t.id;
      m.set(key, t);
    }
    return m;
  }, [tabs]);

  // Active highlight is the URL, full stop (every chip is keyed by its tabHash).
  const activeKey = currentDock?.tabHash ?? '';

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

  // Where to go when the active tab(s) close: the next tab over the list,
  // preferring the current project (stay in-project while it has tabs, else skip
  // to the next tab anywhere — closing a project's last tab must not drop to
  // Home), or Home when nothing is left. Same precedence the loaders use, so the
  // close-time pick can't diverge from a fresh navigation's.
  const navigateAfterClose = useCallback(
    (closing: Tab[]) => {
      const closingIds = new Set(closing.map((t) => t.id));
      const remaining = allTabs.filter((t) => !closingIds.has(t.id));
      const next = resolveNextTab(remaining, new Set(), projectId);
      if (next?.dockPointer) navigation.openDock(next.dockPointer);
      else navigation.closeDock();
    },
    [allTabs, projectId, navigation],
  );

  const handleClose = useCallback(
    (key: string) => {
      const tab = tabByKey.get(key);
      if (!tab) return;
      if (key === activeKey) navigateAfterClose([tab]);
      void closeTabWithLifecycle(tab).finally(() => void refreshAllTabs());
    },
    [tabByKey, activeKey, navigateAfterClose],
  );

  const handleCloseMany = useCallback(
    (keys: string[]) => {
      const closing = keys.map((k) => tabByKey.get(k)).filter((t): t is Tab => t != null);
      if (keys.includes(activeKey)) navigateAfterClose(closing);
      void Promise.allSettled(closing.map((t) => closeTabWithLifecycle(t))).finally(() => void refreshAllTabs());
    },
    [tabByKey, activeKey, navigateAfterClose],
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

  // Keyboard shortcuts (the strip owns them): mod+W close active, mod+T new Claude,
  // mod+PgUp/PgDn cycle. Mac=Ctrl, Windows=Meta, Linux=Alt.
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
        e.preventDefault();
        void controller.handleStartClaude();
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
