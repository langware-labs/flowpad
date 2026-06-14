/**
 * UnifiedTabStrip — the content-panel header strip (docs/tab-management.md).
 * One row composing, in order:
 *
 *   1. terminal tabs (useTerminalStripController — shell / agentic_process;
 *      a terminal tab IS its live entity, so membership is status-derived and
 *      rendered with full PTY/openers/rename by the controller)
 *   2. content tabs — EVERY other opened dock (assets, markdown, skill,
 *      workflow, settings, search, diff, …) materialized as a `Tab` entity by
 *      the route loader. These are the single content-tab system: they replace
 *      both the old `tabbed`-flag entity members AND the single transient slot.
 *   3. the global section (Tab.project_id == null) after a quiet divider.
 *
 * URL-first (non-negotiable): clicks only call navigation.*; the active chip
 * derives from currentDock; the loader is the single writer that materializes
 * the Tab (see ensure-tab-for-dock).
 */
import { dataManager, QueryFilter, QueryRequest, Tab, TypeId } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { type TabStripItem, TabStrip } from '@src/components/tabs/TabStrip';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { lucideByName } from '@src/lib/lucide-by-name';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { activeStripKey } from '@src/tabs/active-strip-key';
import { type TerminalTab } from '@src/tabs/useTabs';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import { ViewType, VIEWER_REGISTRY } from '@src/types/ViewType';
import { FileText } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';

export interface UnifiedTabStripProps {
  /** Standard terminal navigation handlers (useStandardTabNav). */
  onTabClick?: (targetKey: string, session: TerminalTab) => void;
  onTabClose?: (targetKey: string | string[]) => void;
  onTabOpen?: (session: TerminalTab) => void;
}

// Targets owned by the terminal section (1): their Tab rows (if any) must not
// also render as content chips — the controller renders them richly. The bare
// `shell` surface is the terminal section's too.
const TERMINAL_TARGET_TYPES = new Set(['shell', 'agentic_process']);

/** Split a Tab.pointer (== DockPointer.tabHash, `viewType|sub`) into parts. */
function splitTabPointer(pointer: string): { viewType: string; sub: string } {
  const i = pointer.indexOf('|');
  return i >= 0
    ? { viewType: pointer.slice(0, i), sub: pointer.slice(i + 1) }
    : { viewType: pointer, sub: '' };
}

/** The DockPointer a content Tab navigates to (URL-first reconstruction). */
function dockPointerForTab(pointer: string): DockPointer | null {
  return DockPointer.fromTabHash(pointer);
}

/** Chip descriptor for a content Tab — entity-backed Tabs resolve their icon
 *  and name from the live target entity (per-type icon via the backend
 *  TypeInfo registry, CLAUDE.md rule); target-less surfaces use the viewType
 *  registry. ``Tab.name`` (a user rename) always wins. */
function contentTabItem(tab: Tab): TabStripItem {
  const { viewType } = splitTabPointer(tab.pointer ?? '');
  const meta = VIEWER_REGISTRY[viewType as ViewType];
  const key = tab.pointer ?? tab.id;
  const testId = `tab-content-${key}`;
  if (tab.target_type && tab.target_id) {
    const Icon = iconForType(tab.target_type);
    let entityName: string | null = null;
    try {
      const cached = dataManager.getByTypeIdFromCache(new TypeId(tab.target_type, tab.target_id)) as
        | { name?: string | null }
        | null;
      entityName = cached?.name ?? null;
    } catch {
      /* unresolved target — fall back below */
    }
    return {
      key,
      title: tab.name ?? entityName ?? meta?.title ?? viewType,
      icon: <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={`${tab.target_type} tab`} />,
      renameable: true,
      testId,
      dataAttributes: { 'data-tab-kind': tab.target_type },
    };
  }
  const Icon = (meta?.iconName && lucideByName(meta.iconName)) || FileText;
  return {
    key,
    title: tab.name ?? meta?.title ?? viewType,
    icon: <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
    renameable: false,
    testId,
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

  // The single content-tab source: every visible Tab whose surface isn't owned
  // by the terminal section. Live + cross-client via the entity query.
  const visibleTabsQuery = useMemo(
    () =>
      new QueryRequest({
        type: Tab.type,
        scope: [],
        name: 'unifiedStrip:visibleTabs',
        query: new QueryFilter({ match: { visible: true } }),
      }),
    [],
  );
  const { data: visibleTabs } = useEntitiesQuery<Tab>(visibleTabsQuery);

  const contentTabs = useMemo(
    () =>
      (visibleTabs ?? []).filter((t) => {
        if (TERMINAL_TARGET_TYPES.has(t.target_type ?? '')) return false;
        // The terminal section owns the bare `shell` surface too.
        return splitTabPointer(t.pointer ?? '').viewType !== ViewType.SHELL;
      }),
    [visibleTabs],
  );

  // Project / global partition (Part 3 §6): project_id == null → global section.
  const projectId = controller.tabsProjectId;
  const { projectContentTabs, globalContentTabs } = useMemo(() => {
    const project: Tab[] = [];
    const global: Tab[] = [];
    for (const t of contentTabs) {
      if ((t.project_id ?? null) === null) global.push(t);
      else if (projectId == null || t.project_id === projectId) project.push(t);
    }
    return { projectContentTabs: project, globalContentTabs: global };
  }, [contentTabs, projectId]);

  const contentByKey = useMemo(() => {
    const m = new Map<string, Tab>();
    for (const t of contentTabs) m.set(t.pointer ?? t.id, t);
    return m;
  }, [contentTabs]);

  const terminalKeySet = useMemo(
    () => new Set(controller.stripItems.map((i) => i.key)),
    [controller.stripItems],
  );

  const items: TabStripItem[] = useMemo(
    () => [...controller.stripItems, ...projectContentTabs.map(contentTabItem)],
    [controller.stripItems, projectContentTabs],
  );
  const globalItems = useMemo(() => globalContentTabs.map(contentTabItem), [globalContentTabs]);

  // Active highlight derives ONLY from the URL (see active-strip-key): terminal
  // docks resolve via the controller; every content dock is active by its own
  // tabHash and never inherits the controller's MRU terminal key.
  const dockHash = currentDock?.tabHash ?? '';
  const activeKey = activeStripKey(currentDock, controller.activeTargetKey);

  // Navigate to a content Tab (the strip's only job for content keys); returns
  // false when the key isn't a content Tab so the caller can fall back to the
  // terminal controller.
  const openContent = useCallback(
    (key: string, inWindow: boolean): boolean => {
      const content = contentByKey.get(key);
      if (!content) return false;
      const pointer = dockPointerForTab(content.pointer ?? '');
      if (pointer) {
        if (inWindow) navigation.openDockInWindow(pointer);
        else navigation.openDock(pointer);
      }
      return true;
    },
    [contentByKey, navigation],
  );

  const handleSelect = useCallback(
    (key: string) => {
      if (!openContent(key, false)) controller.handleSelect(key);
    },
    [openContent, controller],
  );

  const handleClose = useCallback(
    (key: string) => {
      const content = contentByKey.get(key);
      if (content) {
        if (key === dockHash) navigation.closeDock();
        void content.closeTab();
        return;
      }
      // Terminal close: delegate to the controller (PTY/worker teardown + MRU).
      controller.handleCloseTab(key);
    },
    [contentByKey, dockHash, navigation, controller],
  );

  const handleCloseMany = useCallback(
    (keys: string[]) => {
      const terminalKeys: string[] = [];
      for (const k of keys) {
        const content = contentByKey.get(k);
        if (content) {
          if (k === dockHash) navigation.closeDock();
          void content.closeTab();
        } else {
          terminalKeys.push(k);
        }
      }
      if (terminalKeys.length > 0) controller.handleCloseMany(terminalKeys);
    },
    [contentByKey, dockHash, navigation, controller],
  );

  const handlePopout = useCallback(
    (key: string) => {
      if (openContent(key, true)) return;
      if (terminalKeySet.has(key)) controller.handleOpenExternalTab(key);
    },
    [openContent, terminalKeySet, controller],
  );

  const handleRename = useCallback(
    (key: string, newName: string) => {
      const content = contentByKey.get(key);
      if (content) {
        // Tab.name is the generic source of truth (backend reflects to target).
        void content.rename(newName);
        return;
      }
      // Terminal rename: the controller owns shell/AP name + PTY /rename.
      controller.handleRenameCommit(key, newName);
    },
    [contentByKey, controller],
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
