/**
 * UnifiedTabStrip — the content-panel header strip (docs/tab-management.md).
 *
 * ONE ordered list, backend-owned. The strip renders exactly the rows the
 * backend returns (`useTabRows` → `Tab.list`), in global order, filtered to the
 * active project + projectless tabs (inline — no separate section/divider). The
 * frontend decides NOTHING about order; a drag posts `Tab.reorder` and re-renders
 * the returned list (with an optimistic predict for instant drop-feel).
 *
 * URL-first (non-negotiable): a chip click only calls `navigation.*`; the active
 * chip is `currentDock.tabHash`; the loader is the single writer that materializes
 * the Tab (ensure-tab-for-dock → `Tab.newTab`). Every chip — terminal or content —
 * is keyed by its `pointer` (== tabHash), so there is no kind-branching here.
 *
 * The controller is kept ONLY as chrome: leading/trailing toolbars, the new-tab
 * menu, spawn modals, and the close-shortcut label.
 */
import { type TabRow, Tab } from '@sdk';
import { type ITab } from '@sdk/entities/tab';
import { TabStrip } from '@src/components/tabs/TabStrip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTabStripItems } from '@src/tabs/tab-row-item';
import { applyPredictedOrder, applyRows, refresh, useTabRows } from '@src/tabs/tab-store';
import { type TerminalTab } from '@src/tabs/useTabs';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import React, { useCallback, useMemo } from 'react';

export interface UnifiedTabStripProps {
  /** Standard terminal navigation handlers (useStandardTabNav). */
  onTabClick?: (targetKey: string, session: TerminalTab) => void;
  onTabClose?: (targetKey: string | string[]) => void;
  onTabOpen?: (session: TerminalTab) => void;
}

/** Most-recently-active remaining row (close→navigate target), excluding `exclude`. */
function lastActiveExcept(rows: TabRow[], excludeId: string): TabRow | null {
  let best: TabRow | null = null;
  let bestAt = -Infinity;
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const at = typeof r.last_active_at === 'number' ? r.last_active_at : 0;
    if (at >= bestAt) {
      bestAt = at;
      best = r;
    }
  }
  return best;
}

/** Close one Tab by id via the backend action (teardown is target-owned). */
async function closeRow(id: string): Promise<TabRow[]> {
  const tab = new Tab({ id } as Partial<ITab>);
  return tab.closeTab();
}

export const UnifiedTabStrip: React.FC<UnifiedTabStripProps> = ({ onTabClick, onTabClose, onTabOpen }) => {
  const { navigation, currentDock } = useDockNavigation();
  const controller = useTerminalStripController({
    addTabButton: true,
    onTabClick,
    onTabClose,
    onTabOpen,
  });

  const projectId = controller.tabsProjectId ?? null;
  const rows = useTabRows(projectId);
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

  const handleClose = useCallback(
    (key: string) => {
      const row = rowByKey.get(key);
      if (!row) return;
      // Closing the active tab moves focus to the most-recently-active survivor.
      if (key === activeKey) {
        const next = lastActiveExcept(rows, row.id);
        if (next) navigateTo(next.pointer, false);
        else navigation.closeDock();
      }
      void closeRow(row.id).then((updated) => applyRows(updated, projectId));
    },
    [rowByKey, activeKey, rows, navigateTo, navigation, projectId],
  );

  const handleCloseMany = useCallback(
    (keys: string[]) => {
      const closing = keys.map((k) => rowByKey.get(k)).filter((r): r is TabRow => r != null);
      const closingIds = new Set(closing.map((r) => r.id));
      if (keys.includes(activeKey)) {
        const survivors = rows.filter((r) => !closingIds.has(r.id));
        const next = survivors.length ? lastActiveExcept(survivors, '') : null;
        if (next) navigateTo(next.pointer, false);
        else navigation.closeDock();
      }
      // Close concurrently (each is an independent soft-close), then reconcile
      // once from the backend — the per-close returned lists are interim.
      void Promise.all(closing.map((r) => closeRow(r.id)))
        .then(() => refresh(projectId))
        .catch(() => void refresh(projectId));
    },
    [rowByKey, activeKey, rows, navigateTo, navigation, projectId],
  );

  const handleRename = useCallback(
    (key: string, newName: string) => {
      const row = rowByKey.get(key);
      if (!row) return;
      const tab = new Tab({ id: row.id } as Partial<ITab>);
      void tab.rename(newName).then((updated) => applyRows(updated, projectId));
    },
    [rowByKey, projectId],
  );

  // Drag-reorder: preview optimistically (predict mirrors the backend algebra),
  // commit posts Tab.reorder and adopts the canonical returned list; a cancel
  // restores truth. The strip speaks chip keys (pointers); we map them to ids.
  const handleReorderPreview = useCallback(
    (reorderKey: string, afterKey: string | null, beforeKey: string | null) => {
      const id = rowByKey.get(reorderKey)?.id;
      if (!id) return;
      const afterId = afterKey ? rowByKey.get(afterKey)?.id ?? null : null;
      const beforeId = beforeKey ? rowByKey.get(beforeKey)?.id ?? null : null;
      applyPredictedOrder(id, afterId, beforeId);
    },
    [rowByKey],
  );

  const handleReorderCommit = useCallback(
    (reorderKey: string, afterKey: string | null, beforeKey: string | null) => {
      const id = rowByKey.get(reorderKey)?.id;
      if (!id) return;
      const afterId = afterKey ? rowByKey.get(afterKey)?.id ?? null : null;
      const beforeId = beforeKey ? rowByKey.get(beforeKey)?.id ?? null : null;
      void Tab.reorder(id, afterId, beforeId, projectId)
        .then((updated) => applyRows(updated, projectId))
        .catch(() => void refresh(projectId));
    },
    [rowByKey, projectId],
  );

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
        onReorderCancel={() => void refresh(projectId)}
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
