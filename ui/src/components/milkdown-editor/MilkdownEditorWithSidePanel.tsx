import type { Editor } from '@milkdown/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { AgenticProcess } from '@sdk';
import type { MutableRefObject, ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { TabbedSideDrawer, type TabDescriptor } from '@src/components/ui/side-drawer';
import { MilkdownEditor, type MilkdownEditorMode } from './MilkdownEditor';
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

interface MilkdownEditorWithSidePanelProps {
  content: string;
  onChange?: (content: string) => void;
  editorMode?: MilkdownEditorMode;
  plugins?: MilkdownPlugin[];
  onLinkClick?: (href: string) => void;
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
   * Drop the Chat tab from the side drawer entirely. Use when the host renders
   * its own chat surface elsewhere (e.g. the agent editor's bottom-of-doc chat),
   * to avoid two `EntityChatPanel`s racing on the same `target` for lazy
   * process creation.
   */
  disableChat?: boolean;
  /** Outer ref to the underlying Milkdown Editor for imperative actions (e.g. toolbar inserts). */
  editorRef?: MutableRefObject<Editor | null>;
  /** Right-aligned slot rendered inside Milkdown's static toolbar. Hidden in view/review modes. */
  toolbarRight?: ReactNode;
}

/**
 * Wraps `MilkdownEditor` with a fixed-width tabbed side window (Chat, Backlinks).
 * The side panel is always on; Chat is the default tab. Callers must supply a
 * real entity TypeId as `chatTarget`; files without a backing entity cannot
 * host chat.
 */
export function MilkdownEditorWithSidePanel({
  content,
  onChange,
  editorMode,
  plugins,
  onLinkClick,
  chatTarget,
  extraTabs,
  activeTab: activeTabProp,
  onActiveTabChange,
  chatOnProcessCreated,
  disableChat,
  editorRef,
  toolbarRight,
}: MilkdownEditorWithSidePanelProps) {
  const defaultTab: string = disableChat ? 'backlinks' : MD_SIDE_TABS_DEFAULT;
  const [internalTab, setInternalTab] = useState<string>(defaultTab);
  // When chat is disabled, force activeTab off 'chat' even if a stale prop or
  // stored state pointed there.
  const rawActiveTab = activeTabProp ?? internalTab;
  const activeTab = disableChat && rawActiveTab === 'chat' ? defaultTab : rawActiveTab;

  const setActiveTab = useCallback(
    (id: string) => {
      if (activeTabProp === undefined) setInternalTab(id);
      onActiveTabChange?.(id);
    },
    [activeTabProp, onActiveTabChange],
  );

  const tabs = useMemo<TabDescriptor[]>(() => {
    const order = disableChat
      ? MD_SIDE_TABS_ORDER.filter((id) => id !== 'chat')
      : MD_SIDE_TABS_ORDER;
    const base = order.map((id) => MD_SIDE_TABS[id] as TabDescriptor);
    const extras: TabDescriptor[] = (extraTabs ?? []).map(({ id, label, icon, description }) => ({
      id,
      label,
      icon,
      description,
    }));
    return [...base, ...extras];
  }, [extraTabs, disableChat]);

  const panels = useMemo<Record<string, ReactNode>>(() => {
    const base: Record<string, ReactNode> = {
      backlinks: <BacklinksTab target={chatTarget} />,
    };
    if (!disableChat) {
      base.chat = <ChatTab target={chatTarget} onProcessCreated={chatOnProcessCreated} />;
    }
    for (const t of extraTabs ?? []) base[t.id] = t.panel;
    return base;
  }, [chatTarget, extraTabs, chatOnProcessCreated, disableChat]);

  return (
    <div className="flex h-full w-full" data-testid="md-editor-with-side-panel">
      <div className="min-w-0 flex-1">
        <MilkdownEditor
          content={content}
          onChange={onChange}
          editorMode={editorMode}
          plugins={plugins}
          onLinkClick={onLinkClick}
          editorRef={editorRef}
          toolbarRight={toolbarRight}
        />
      </div>
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
