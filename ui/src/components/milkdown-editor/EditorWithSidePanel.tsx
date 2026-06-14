import type { AgenticProcess } from '@sdk';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@src/components/ui/tooltip';
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
 * Side window collapse state is persisted across reloads and shared by every
 * markdown editor (skill, agent, plan, …). Default collapsed — the editor
 * gets maximum width until the user explicitly opens the drawer.
 */
const SIDE_OPEN_STORAGE_KEY = 'mdSideWindow.open';

function readStoredOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDE_OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStoredOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDE_OPEN_STORAGE_KEY, open ? 'true' : 'false');
  } catch {
    /* ignore quota / disabled storage */
  }
}

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
  /** Forwarded to the Chat tab — runs once after its backing chat process is created. */
  onChatProcessCreated?: (process: AgenticProcess) => Promise<void> | void;
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
 * and chat process history persist when the parent toggles between editor backends.
 *
 * Callers must supply a real entity TypeId as `chatTarget`; files without a
 * backing entity cannot host a chat process.
 */
export function EditorWithSidePanel({
  children,
  chatTarget,
  extraTabs,
  activeTab: activeTabProp,
  onActiveTabChange,
  onChatProcessCreated,
  cursorLine,
}: EditorWithSidePanelProps) {
  const [internalTab, setInternalTab] = useState<string>(MD_SIDE_TABS_DEFAULT);
  const activeTab = activeTabProp ?? internalTab;

  // Collapse state is persisted (default collapsed) so the editor stays wide
  // until the user opens the drawer; the choice is remembered across reloads.
  const [open, setOpen] = useState<boolean>(readStoredOpen);
  const setOpenPersisted = useCallback((next: boolean) => {
    setOpen(next);
    writeStoredOpen(next);
  }, []);

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
          onChatProcessCreated={onChatProcessCreated}
          cursorLine={cursorLine}
        />
      ),
      backlinks: <BacklinksTab target={chatTarget} />,
    };
    for (const t of extraTabs ?? []) base[t.id] = t.panel;
    return base;
  }, [chatTarget, extraTabs, onChatProcessCreated, cursorLine]);

  return (
    <div className="flex h-full w-full" data-testid="md-editor-with-side-panel">
      <div className="min-w-0 flex-1">{children}</div>
      {open ? (
        <TabbedSideDrawer<string>
          open
          onOpenChange={setOpenPersisted}
          closeIcon={PanelRightClose}
          closeLabel="Collapse side window"
          width="w-80"
          data-testid="md-side-window"
          tabTestIdPrefix="md-side-tab"
          tabs={tabs}
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
        >
          {panels}
        </TabbedSideDrawer>
      ) : (
        <CollapsedSideRail
          tabs={tabs}
          onOpenTab={(id) => {
            setActiveTab(id);
            setOpenPersisted(true);
          }}
        />
      )}
    </div>
  );
}

/** One icon button + left-tooltip in the collapsed rail. */
function SideRailButton({
  icon: Icon,
  label,
  onClick,
  testId,
}: {
  icon: TabDescriptor['icon'];
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          data-testid={testId}
          aria-label={label}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Thin vertical rail shown when the side window is collapsed. Clicking the
 * expand button (or any tab icon) reopens the drawer — to that tab.
 */
function CollapsedSideRail({
  tabs,
  onOpenTab,
}: {
  tabs: TabDescriptor[];
  onOpenTab: (id: string) => void;
}) {
  return (
    <div
      className="flex w-9 shrink-0 flex-col items-center gap-0.5 border-l bg-background py-1"
      data-testid="md-side-window-collapsed"
    >
      <TooltipProvider delayDuration={400}>
        <SideRailButton
          icon={PanelRightOpen}
          label="Expand side window"
          onClick={() => onOpenTab(tabs[0]?.id ?? MD_SIDE_TABS_DEFAULT)}
          testId="md-side-window-expand"
        />
        {tabs.map((tab) => (
          <SideRailButton
            key={tab.id}
            icon={tab.icon}
            label={tab.label}
            onClick={() => onOpenTab(tab.id)}
            testId={`md-side-tab-collapsed-${tab.id}`}
          />
        ))}
      </TooltipProvider>
    </div>
  );
}

// Re-export MdSideTabId for convenience for callers that pin the default tab.
export type { MdSideTabId };
