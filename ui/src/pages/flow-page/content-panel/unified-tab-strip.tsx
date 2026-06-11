/**
 * UnifiedTabStrip — the content-panel header strip that replaces the viewer
 * tab chips (docs/tab-management.md Part 3 §6). One row composing, in order:
 *
 *   1. terminal tabs (useTerminalStripController — same items, openers,
 *      counter chip and strategies as the embedded TabbedTerminal strip)
 *   2. entity member tabs for the current project (useEntityTabs)
 *   3. ONE transient preview chip for the current dock when it matches no
 *      member (Part 3 §5; "Keep as tab" is the only promotion path)
 *   4. the global section (projectId == null) after a quiet divider —
 *      always visible (the toggle checkbox was removed as confusing)
 *
 * URL-first (non-negotiable): clicks only call navigation.*; the active chip
 * derives from currentDock; loaders remain the only context writers.
 */
import { dataManager, TypeId } from '@sdk';
import { type TabStripItem, TabStrip } from '@src/components/tabs/TabStrip';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  closeTabTargets,
  openTabTargets,
  useEntityTabs,
  type EntityTabRow,
  type TerminalTab,
} from '@src/tabs/useTabs';
import {
  dockTargetTypeIdKey,
  partitionEntityRows,
  transientForDock,
} from '@src/tabs/unified-strip-model';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import { FileText } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';

export interface UnifiedTabStripProps {
  /** Standard terminal navigation handlers (useStandardTabNav). */
  onTabClick?: (targetKey: string, session: TerminalTab) => void;
  onTabClose?: (targetKey: string | string[]) => void;
  onTabOpen?: (session: TerminalTab) => void;
}

function entityRowItem(row: EntityTabRow): TabStripItem {
  // Per-type icon strictly from the backend type registry (CLAUDE.md rule);
  // iconForType falls back to the generic document glyph for unknown types.
  const Icon = iconForType(row.kind);
  return {
    key: row.key,
    title: row.name ?? row.key,
    icon: <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={`${row.kind} tab`} />,
    // v1: entity tabs are not renamed from the strip (rename via the entity
    // editor save can come later — Part 3 §3 gates rename on targetEntity).
    renameable: false,
    testId: `tab-entity-${row.key}`,
    dataAttributes: { 'data-tab-kind': row.kind },
  };
}

export const UnifiedTabStrip: React.FC<UnifiedTabStripProps> = ({ onTabClick, onTabClose, onTabOpen }) => {
  const { navigation, currentDock } = useDockNavigation();
  const controller = useTerminalStripController({
    addTabButton: true,
    onTabClick,
    onTabClose,
    onTabOpen,
  });
  const entityRows = useEntityTabs();
  const { projectRows, globalRows } = partitionEntityRows(entityRows, controller.tabsProjectId);

  // VISIBLE members only (project section + global section). The strip's
  // invariant is "the current view always has a chip": a member tab filtered
  // out by the project scope must still get the transient preview chip when
  // its URL is open — counting ALL members here left cross-project member
  // docs with no chip at all (found live, 2026-06-11).
  const memberKeySet = useMemo(
    () => new Set([...projectRows, ...globalRows].map((r) => r.key)),
    [projectRows, globalRows],
  );
  const terminalKeySet = useMemo(
    () => new Set(controller.stripItems.map((i) => i.key)),
    [controller.stripItems],
  );

  // Transient preview slot (Part 3 §5). Browsing creates no membership; the
  // ONLY `tabs/open` call in this file is the explicit "Keep as tab" action.
  const transient = transientForDock(currentDock, {
    isMemberKey: (key) => memberKeySet.has(key),
    entityNameForTypeId: (key) => {
      try {
        const cached = dataManager.getByTypeIdFromCache(new TypeId(key)) as { name?: string | null } | null;
        return cached?.name ?? null;
      } catch {
        return null;
      }
    },
  });

  const transientItem: TabStripItem | null = useMemo(() => {
    if (!transient) return null;
    const Icon = (transient.iconName && lucideByName(transient.iconName)) || FileText;
    return {
      key: transient.key,
      title: transient.title,
      icon: <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
      renameable: false,
      testId: 'tab-transient',
      contextMenuItems: transient.promotableTypeIdKey
        ? [
            {
              label: 'Keep as tab',
              onSelect: () => {
                void openTabTargets([transient.promotableTypeIdKey!]);
              },
            },
          ]
        : undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transient?.key, transient?.title, transient?.iconName, transient?.promotableTypeIdKey]);

  const items: TabStripItem[] = useMemo(
    () => [
      ...controller.stripItems,
      ...projectRows.map(entityRowItem),
      ...(transientItem ? [transientItem] : []),
    ],
    [controller.stripItems, projectRows, transientItem],
  );
  const globalItems = useMemo(() => globalRows.map(entityRowItem), [globalRows]);

  // Active highlight derives ONLY from the URL: a dock-less URL highlights
  // nothing; the transient chip IS the current URL when present; an entity
  // member highlights when the URL's asset pointer resolves to its typeid;
  // ViewType.SHELL delegates to the controller's URL-derived terminal key.
  const dockKey = dockTargetTypeIdKey(currentDock);
  const activeKey = !currentDock
    ? ''
    : transientItem
      ? transientItem.key
      : dockKey && memberKeySet.has(dockKey)
        ? dockKey
        : controller.activeTargetKey;

  const entityRowByKey = useCallback(
    (key: string) => entityRows.find((r) => r.key === key) ?? null,
    [entityRows],
  );

  const handleSelect = useCallback(
    (key: string) => {
      if (terminalKeySet.has(key)) {
        controller.handleSelect(key);
        return;
      }
      const row = entityRowByKey(key);
      if (row) navigation.openDock(DockPointer.forAssetEditorByTypeId(row.kind, row.typeId));
      // Transient chip: it IS the current URL — nothing to do.
    },
    [terminalKeySet, controller, entityRowByKey, navigation],
  );

  /** Member close (one batched POST); navigation fallback for terminal kinds. */
  const closeMembers = useCallback(
    async (keys: string[]) => {
      const result = await closeTabTargets(keys);
      if (result.invalid.length > 0 || result.missing.length > 0) {
        console.warn('[UnifiedTabStrip] Some close targets were not accepted:', result);
      }
      const acceptedTerminals = result.accepted.filter((k) => terminalKeySet.has(k));
      if (acceptedTerminals.length > 0) onTabClose?.(acceptedTerminals);
    },
    [terminalKeySet, onTabClose],
  );

  const handleClose = useCallback(
    (key: string) => {
      if (transientItem && key === transientItem.key) {
        // Transient close = dismiss: navigate away, nothing persisted (§3).
        navigation.closeDock();
        return;
      }
      void closeMembers([key]);
    },
    [transientItem, navigation, closeMembers],
  );

  const handleCloseMany = useCallback(
    (keys: string[]) => {
      // ONE batched POST for all member keys (the backend dispatches per-kind
      // semantics); the transient slot dismisses locally.
      const memberKeys = keys.filter((k) => !transientItem || k !== transientItem.key);
      if (memberKeys.length > 0) void closeMembers(memberKeys);
      if (transientItem && keys.includes(transientItem.key)) navigation.closeDock();
    },
    [transientItem, closeMembers, navigation],
  );

  const handlePopout = useCallback(
    (key: string) => {
      if (terminalKeySet.has(key)) {
        controller.handleOpenExternalTab(key);
        return;
      }
      // Non-terminal popouts also open the chrome-less win/ focus window
      // (Part 3 §7); no origin detach — only the terminal popout hands its
      // active view off (§8), entity/transient chips stay where they are.
      if (transientItem && key === transientItem.key) {
        if (currentDock) navigation.openDockInWindow(currentDock);
        return;
      }
      const row = entityRowByKey(key);
      if (row) navigation.openDockInWindow(DockPointer.forAssetEditorByTypeId(row.kind, row.typeId));
    },
    [terminalKeySet, controller, transientItem, currentDock, navigation, entityRowByKey],
  );

  return (
    <>
      <TabStrip
        items={items}
        activeKey={activeKey}
        onSelect={handleSelect}
        onClose={handleClose}
        onCloseMany={handleCloseMany}
        onRename={controller.handleRenameCommit}
        onPopout={handlePopout}
        newTabMenuItems={controller.newTabMenuItems}
        closeShortcutLabel={controller.closeShortcutLabel}
        leading={controller.leading}
        trailing={controller.trailing}
        globalItems={globalItems}
      />
      {controller.modals}
    </>
  );
};

export default UnifiedTabStrip;
