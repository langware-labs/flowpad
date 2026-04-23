import type { MilkdownPlugin } from '@milkdown/ctx';
import type { AgenticProcess } from '@sdk';
import type { ReactNode } from 'react';
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
  /** File path used to derive the chat target TypeId. Chat persistence is keyed by this. */
  sourcePath: string;
  /** Appended after Chat + Backlinks. Use for asset-type-specific tabs (e.g. workflow Runs). */
  extraTabs?: ExtraSideTab[];
  /** Controlled active tab id. If omitted, drawer manages its own state. */
  activeTab?: string;
  /** Emitted whenever the active tab changes (including programmatic + internal). */
  onActiveTabChange?: (id: string) => void;
  /** Forwarded to the Chat tab — runs once after its backing process is created. */
  chatOnProcessCreated?: (process: AgenticProcess) => Promise<void> | void;
}

/**
 * Wraps `MilkdownEditor` with a fixed-width tabbed side window (Chat, Backlinks).
 * The side panel is always on; Chat is the default tab.
 *
 * Target TypeId convention: `markdown_file-<sourcePath>`. The path is stable for a
 * file's lifetime; rename breaks continuity (tracked as a known limitation).
 */
export function MilkdownEditorWithSidePanel({
  content,
  onChange,
  editorMode,
  plugins,
  onLinkClick,
  sourcePath,
  extraTabs,
  activeTab: activeTabProp,
  onActiveTabChange,
  chatOnProcessCreated,
}: MilkdownEditorWithSidePanelProps) {
  const [internalTab, setInternalTab] = useState<string>(MD_SIDE_TABS_DEFAULT);
  const activeTab = activeTabProp ?? internalTab;

  const setActiveTab = useCallback(
    (id: string) => {
      if (activeTabProp === undefined) setInternalTab(id);
      onActiveTabChange?.(id);
    },
    [activeTabProp, onActiveTabChange],
  );

  const target = useMemo<string | null>(
    () => (sourcePath ? `markdown_file-${sourcePath}` : null),
    [sourcePath],
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
      chat: <ChatTab target={target} onProcessCreated={chatOnProcessCreated} />,
      backlinks: <BacklinksTab target={target} />,
    };
    for (const t of extraTabs ?? []) base[t.id] = t.panel;
    return base;
  }, [target, extraTabs, chatOnProcessCreated]);

  return (
    <div className="flex h-full w-full" data-testid="md-editor-with-side-panel">
      <div className="min-w-0 flex-1">
        <MilkdownEditor
          content={content}
          onChange={onChange}
          editorMode={editorMode}
          plugins={plugins}
          onLinkClick={onLinkClick}
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
