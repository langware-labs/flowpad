import type { AgenticProcess } from '@sdk';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { TabbedSideDrawer, type TabDescriptor } from '@src/components/ui/side-drawer';
import { CollapsedSideRail, SideRailButton } from '@src/components/ui/collapsed-side-rail';
import { useSideWindows } from '@src/navigation/useSideWindows';
import {
  BacklinksTab,
  ChatTab,
  MD_SIDE_TABS,
  MD_SIDE_TABS_DEFAULT,
  MD_SIDE_TABS_ORDER,
  type MdSideTabId,
} from './side-windows';

/**
 * Extra tab a caller can inject alongside Chat + Backlinks. The `panel` is the
 * ReactNode rendered when the tab is active. Used by asset types (workflow
 * Runs, revisions, …) to append a window without forking this component.
 */
export interface ExtraSideTab {
  id: string;
  label: string;
  icon: TabDescriptor['icon'];
  description?: string;
  panel: ReactNode;
}

interface EditorWithSidePanelProps {
  /** The active editor surface (Milkdown or Monaco). Swapped by the caller — the side panel stays mounted. */
  children: ReactNode;
  /**
   * Serialized TypeId of the first-class entity this file belongs to (e.g.
   * `"plan-<uuid>"`, `"agent-<uuid>"`). Chat + Backlinks are keyed by this.
   * Null disables those tabs' persistence (chat cannot open, history empty).
   */
  chatTarget: string | null;
  /** Appended after Chat + Backlinks. Use for asset-type-specific tabs (e.g. workflow Runs). */
  extraTabs?: ExtraSideTab[];
  /** Forwarded to the Chat tab — runs once after its backing chat process is created. */
  onChatProcessCreated?: (process: AgenticProcess) => Promise<void> | void;
  /**
   * Current caret line (1-indexed, on-disk) emitted by whichever editor is mounted.
   * Rendered as "line N" in the chat header. Null hides the badge.
   */
  cursorLine?: number | null;
}

/**
 * Editor-agnostic shell: any markdown editor as `children`, plus a tabbed side
 * window (Chat, Backlinks, extras). The side window is URL-first dock state —
 * the open set + active id live on the DockPointer (`?sideWindows=…`) and are
 * driven through the shared `useSideWindows` hook, identical to the interactive
 * terminal. Only opened windows show, each is closeable, and an empty set
 * collapses to a rail of openable buttons (one per registered window).
 *
 * To open a window programmatically (e.g. a header pill, or a run-start), a
 * caller calls `useSideWindows().open(id)` directly — there is no controlled
 * active-tab prop, because the URL is the single source of truth.
 */
export function EditorWithSidePanel({
  children,
  chatTarget,
  extraTabs,
  onChatProcessCreated,
  cursorLine,
}: EditorWithSidePanelProps) {
  const { windows, active, open, close, closeAll, select } = useSideWindows();

  // Full registry of openable windows (Chat + Backlinks + caller extras), in
  // display order. Drives both the open-tab descriptors and the collapsed rail.
  const registry = useMemo<TabDescriptor[]>(() => {
    const base = MD_SIDE_TABS_ORDER.map((id) => MD_SIDE_TABS[id] as TabDescriptor);
    const extras: TabDescriptor[] = (extraTabs ?? []).map(({ id, label, icon, description }) => ({
      id,
      label,
      icon,
      description,
    }));
    return [...base, ...extras];
  }, [extraTabs]);

  const panels = useMemo<Record<string, ReactNode>>(() => {
    const map: Record<string, ReactNode> = {
      chat: (
        <ChatTab
          target={chatTarget}
          onChatProcessCreated={onChatProcessCreated}
          cursorLine={cursorLine}
        />
      ),
      backlinks: <BacklinksTab target={chatTarget} />,
    };
    for (const t of extraTabs ?? []) map[t.id] = t.panel;
    return map;
  }, [chatTarget, extraTabs, onChatProcessCreated, cursorLine]);

  // Open windows, in open order, narrowed to known registry ids (drops any
  // stale/foreign id) and marked closeable.
  const openTabs = useMemo<TabDescriptor[]>(
    () =>
      windows
        .map((id) => registry.find((r) => r.id === id))
        .filter((d): d is TabDescriptor => !!d)
        .map((d) => ({ ...d, closable: true })),
    [windows, registry],
  );

  return (
    <div className="flex h-full w-full" data-testid="md-editor-with-side-panel">
      <div className="min-w-0 flex-1">{children}</div>
      {openTabs.length > 0 && (
        <TabbedSideDrawer<string>
          open
          onOpenChange={closeAll}
          closeIcon={PanelRightClose}
          closeLabel="Collapse side window"
          width="w-80"
          data-testid="md-side-window"
          tabTestIdPrefix="md-side-tab"
          tabs={openTabs}
          activeTab={active ?? openTabs[openTabs.length - 1].id}
          onActiveTabChange={select}
          onCloseTab={close}
          truncateLabels
          scrollableTabs
        >
          {panels}
        </TabbedSideDrawer>
      )}
      {/* The rail is always present (like the terminal's ribbon): every
          registered window can be opened — or re-activated, when already open —
          at any time, whether the drawer is collapsed or showing other windows. */}
      <CollapsedSideRail data-testid="md-side-window-collapsed">
        {openTabs.length === 0 && (
          <SideRailButton
            icon={PanelRightOpen}
            label="Expand side window"
            onClick={() => open(registry[0]?.id ?? MD_SIDE_TABS_DEFAULT)}
            testId="md-side-window-expand"
          />
        )}
        {registry.map((tab) => (
          <SideRailButton
            key={tab.id}
            icon={tab.icon}
            label={tab.label}
            active={windows.includes(tab.id)}
            onClick={() => open(tab.id)}
            testId={`md-side-tab-collapsed-${tab.id}`}
          />
        ))}
      </CollapsedSideRail>
    </div>
  );
}

// Re-export MdSideTabId for convenience for callers that pin the default tab.
export type { MdSideTabId };
