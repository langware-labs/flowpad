import type { AgenticProcess } from '@sdk';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { TabbedSideDrawer, type TabDescriptor } from '@src/components/ui/side-drawer';
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
 * ReactNode rendered when the tab is active. Used by workflow assets to append
 * a "Runs" tab without forking this component.
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
  /** Controlled active tab id. If omitted, drawer manages its own state. */
  activeTab?: string;
  /** Emitted whenever the active tab changes (including programmatic + internal). */
  onActiveTabChange?: (id: string) => void;
  /** Forwarded to the Chat tab — runs once after its backing process is created. */
  chatOnProcessCreated?: (process: AgenticProcess) => Promise<void> | void;
  /**
   * Current caret line (1-indexed, on-disk) emitted by whichever editor is mounted.
   * Rendered as "line N" in the chat header. Null hides the badge.
   */
  cursorLine?: number | null;
}

/**
 * Editor-agnostic shell: any markdown editor as `children`, plus a fixed-width
 * tabbed side window (Chat, Backlinks, extras). The side panel is always on
 * and stays mounted across editor swaps so its tab state, scroll position,
 * and chat history persist when the parent toggles between editor backends.
 *
 * Callers must supply a real entity TypeId as `chatTarget`; files without a
 * backing entity cannot host chat.
 */
export function EditorWithSidePanel({
  children,
  chatTarget,
  extraTabs,
  activeTab: activeTabProp,
  onActiveTabChange,
  chatOnProcessCreated,
  cursorLine,
}: EditorWithSidePanelProps) {
  const [internalTab, setInternalTab] = useState<string>(MD_SIDE_TABS_DEFAULT);
  const activeTab = activeTabProp ?? internalTab;

  const setActiveTab = useCallback(
    (id: string) => {
      if (activeTabProp === undefined) setInternalTab(id);
      onActiveTabChange?.(id);
    },
    [activeTabProp, onActiveTabChange],
  );

  const tabs = useMemo<TabDescriptor[]>(() => {
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
    const base: Record<string, ReactNode> = {
      chat: (
        <ChatTab
          target={chatTarget}
          onProcessCreated={chatOnProcessCreated}
          cursorLine={cursorLine}
        />
      ),
      backlinks: <BacklinksTab target={chatTarget} />,
    };
    for (const t of extraTabs ?? []) base[t.id] = t.panel;
    return base;
  }, [chatTarget, extraTabs, chatOnProcessCreated, cursorLine]);

  return (
    <div className="flex h-full w-full" data-testid="md-editor-with-side-panel">
      <div className="min-w-0 flex-1">{children}</div>
      <TabbedSideDrawer<string>
        open
        width="w-80"
        data-testid="md-side-window"
        tabTestIdPrefix="md-side-tab"
        tabs={tabs}
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
      >
        {panels}
      </TabbedSideDrawer>
    </div>
  );
}

// Re-export MdSideTabId for convenience for callers that pin the default tab.
export type { MdSideTabId };
