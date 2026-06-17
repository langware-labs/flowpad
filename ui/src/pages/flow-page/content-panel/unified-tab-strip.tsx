/**
 * UnifiedTabStrip — the content-panel header strip (docs/tab-management.md).
 *
 * ONE ordered list, backend-owned. The strip renders exactly the rows the `tab`
 * action returns, in global order, read from the single `all-tabs-store`.
 * `scope='project'` (default) shows the active project + projectless tabs (the
 * backend `filter_for_project` rule, applied client-side); `scope='all'` shows
 * every project's tabs (the developer sessions view). There is no reactive entity
 * query and no second store.
 *
 * URL-first (non-negotiable): a chip click only calls `navigation.*`; the active
 * chip is `currentDock.tabHash`; the loader is the single writer that materializes
 * the Tab. Every chip — terminal or content — is keyed by its `pointer`
 * (== tabHash), so there is no kind-branching here.
 *
 * The controller is kept ONLY for the surrounding controls: leading/trailing
 * toolbars, the new-tab menu, spawn modals, and the close-shortcut label.
 */
import { type TabRow, Tab } from '@sdk';
import { TabStrip } from '@src/components/tabs/TabStrip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTabStripItems } from '@src/tabs/tab-row-item';
import { resolveNextTabRow, tabRowInProject } from '@src/tabs/tab-candidates';
import { applyPredictedOrder, refreshAllTabRows, useAllTabRows } from '@src/tabs/all-tabs-store';
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
  const allRows = useAllTabRows();
  const rows = useMemo(
    () =>
      scope === 'all' ? allRows : allRows.filter((r) => tabRowInProject(r, projectId)),
    [allRows, scope, projectId],
  );
  const items = useTabStripItems(rows);
  const rowByKey = useMemo(() => {
    const m = new Map<string, TabRow>();
    for (const r of rows) m.set(r.pointer || r.id, r);
    return m;
  }, [rows]);

  // Active highlight is the URL, full stop (every chip is keyed by its tabHash).
  const activeKey = currentDock?.tabHash ?? '';

  const navigateTo = useCallback(
    (pointer: string, inWindow: boolean) => {
      const dock = DockPointer.fromTabHash(pointer);
      if (!dock) return;
      if (inWindow) navigation.openDockInWindow(dock);
      else navigation.openDock(dock);
    },
    [navigation],
  );

  const handleSelect = useCallback((key: string) => navigateTo(key, false), [navigateTo]);
  const handlePopout = useCallback((key: string) => navigateTo(key, true), [navigateTo]);

  // Where to go when the active tab(s) close: the next tab over the GLOBAL list,
  // preferring the current project (stay in-project while it has tabs, else skip
  // to the next tab anywhere — closing a project's last tab must not drop to
  // Home), or Home when nothing is left. Same precedence the loaders use, so the
  // close-time pick can't diverge from a fresh navigation's.
  const navigateAfterClose = useCallback(
    (closing: TabRow[]) => {
      const closingIds = new Set(closing.map((r) => r.id));
      const next = resolveNextTabRow(allRows.filter((r) => !closingIds.has(r.id)), new Set(), projectId);
      if (next) navigateTo(next.pointer, false);
      else navigation.closeDock();
    },
    [allRows, projectId, navigateTo, navigation],
  );

  const handleClose = useCallback(
    (key: string) => {
      const row = rowByKey.get(key);
      if (!row) return;
      if (key === activeKey) navigateAfterClose([row]);
      void Tab.closeById(row.id).then(() => refreshAllTabRows());
    },
    [rowByKey, activeKey, navigateAfterClose],
  );

  const handleCloseMany = useCallback(
    (keys: string[]) => {
      const closing = keys.map((k) => rowByKey.get(k)).filter((r): r is TabRow => r != null);
      if (keys.includes(activeKey)) navigateAfterClose(closing);
      void Promise.all(closing.map((r) => Tab.closeById(r.id))).finally(() => void refreshAllTabRows());
    },
    [rowByKey, activeKey, navigateAfterClose],
  );

  const handleRename = useCallback(
    (key: string, newName: string) => {
      const row = rowByKey.get(key);
      if (!row) return;
      void Tab.renameById(row.id, newName).then(() => refreshAllTabRows());
    },
    [rowByKey],
  );

  // Drag-reorder: optimistic predict on the store; commit posts Tab.reorder and a
  // refresh adopts the canonical order (a cancel just refreshes back to truth).
  const handleReorderPreview = useCallback(
    (reorderKey: string, afterKey: string | null, beforeKey: string | null) => {
      const id = rowByKey.get(reorderKey)?.id;
      if (!id) return;
      applyPredictedOrder(id, afterKey ? rowByKey.get(afterKey)?.id ?? null : null, beforeKey ? rowByKey.get(beforeKey)?.id ?? null : null);
    },
    [rowByKey],
  );

  const handleReorderCommit = useCallback(
    (reorderKey: string, afterKey: string | null, beforeKey: string | null) => {
      const id = rowByKey.get(reorderKey)?.id;
      if (!id) return;
      const afterId = afterKey ? rowByKey.get(afterKey)?.id ?? null : null;
      const beforeId = beforeKey ? rowByKey.get(beforeKey)?.id ?? null : null;
      void Tab.reorder(id, afterId, beforeId, projectId).finally(() => void refreshAllTabRows());
    },
    [rowByKey, projectId],
  );

  // Keyboard shortcuts (the strip owns them): mod+W close active, mod+T new Claude,
  // mod+PgUp/PgDn cycle. Mac=Ctrl, Windows=Meta, Linux=Alt.
  useEffect(() => {
    const osPlatform: string =
      (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.userAgent;
    const modKey = /Mac/i.test(osPlatform) ? 'Ctrl' : /Win/i.test(osPlatform) ? 'Meta' : 'Alt';
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = modKey === 'Ctrl' ? e.ctrlKey : modKey === 'Meta' ? e.metaKey : e.altKey;
      if (!mod) return;
      if (e.key === 'w' || e.key === 'W') {
        if (!activeKey || !rowByKey.has(activeKey)) return;
        e.preventDefault();
        handleClose(activeKey);
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        void controller.handleStartClaude();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        const idx = rows.findIndex((r) => (r.pointer || r.id) === activeKey);
        if (idx > 0) navigateTo(rows[idx - 1].pointer, false);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        const idx = rows.findIndex((r) => (r.pointer || r.id) === activeKey);
        if (idx >= 0 && idx < rows.length - 1) navigateTo(rows[idx + 1].pointer, false);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [activeKey, rows, rowByKey, handleClose, navigateTo, controller]);

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
        onReorderCancel={() => void refreshAllTabRows()}
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
