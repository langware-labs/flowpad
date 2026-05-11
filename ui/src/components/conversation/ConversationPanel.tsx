import { useMemo, useState } from 'react';
import { Conversation, FlowMessage, type Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { History, Layers, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { TabbedSideDrawer } from '@src/components/ui/side-drawer';
import { useProcessesForTarget } from '@src/components/entity-chat-panel/hooks/useProcessesForTarget';
import { WorkflowRunsPanel } from '@src/components/workflows-view/WorkflowRunsPanel';
import type { ProcessEntry } from '@src/components/workflows-view/workflow-run-store';
import { ConversationView } from './ConversationView';
import { ConversationMode } from './conversation-mode';
import { useProjectMappingGate } from './useProjectMappingGate';
import { ChipsExcludeProvider } from './chips/ChipsExcludeContext';
import { taskChipKeys } from './chips/keys';
import { ConversationBottomRibbon, type ConversationSideTab } from './ConversationBottomRibbon';
import { ConversationContextPanel } from './ConversationContextPanel';

interface ConversationPanelProps {
  /** Optional. Project-scoped conversations have no task. */
  task?: Task | null;
  conversationId: string;
  /** Optional sender label for messages whose `sender_name` field is missing. */
  senderName?: string;
  /**
   * Override the "Conversation" header label. Pass `null` to suppress the
   * label entirely. Default: "Conversation".
   */
  headerLabel?: string | null;
  /**
   * Visual density. `compact` matches the inline TaskDetailPanel layout;
   * `default` matches the SharedTaskView layout.
   */
  variant?: 'default' | 'compact';
  /** Approve & Execute backend; forwarded to ConversationView. */
  mode?: ConversationMode;
  className?: string;
}

/**
 * Single source of truth for how a conversation looks anywhere in the app.
 *
 * Layout:
 *   ┌─────────────────────────────────────┬──────────────┐
 *   │  Header (label only — toolbar empty)│              │
 *   │                                     │  Side drawer │
 *   │  ConversationView (bubbles + comp.) │  Cntxt|Runs  │
 *   ├─────────────────────────────────────┴──────────────┤
 *   │  Bottom ribbon (toggle Context / Runs)             │
 *   └────────────────────────────────────────────────────┘
 *
 * The drawer folds to the right when closed: instead of disappearing, it
 * collapses to a thin vertical strip with a `PanelRightOpen` icon — click
 * the icon to expand it back. The bottom ribbon is the secondary affordance
 * — clicking the active tab there also folds the drawer; clicking either
 * tab when folded re-opens the drawer to that tab.
 *
 * Tabs (left → right) match the ribbon order: Context, Runs.
 *   - **Context** is per-message — switching the selected message
 *     wholesale-replaces the panel.
 *   - **Runs** is per-conversation — one row per AgenticProcess (Claude
 *     session) used to service this conversation, regardless of which
 *     message the user is currently looking at.
 *
 * The conversation toolbar deliberately renders no chips. Project / spec /
 * shared-terminal affordances all live in the Context tab now, scoped to
 * whichever message the user has selected.
 */
export function ConversationPanel({
  task,
  conversationId,
  senderName,
  headerLabel = 'Conversation',
  variant = 'default',
  mode,
  className,
}: ConversationPanelProps) {
  // One gate, two subject shapes. Remote provenance always lives on the
  // conversation; the gate stamps the task when present (task owns project_root
  // for cwd) or the conversation itself otherwise. Both shapes feed the same
  // `OpenProjectComponent` dialog and the same per-machine remote→local
  // mapping table.
  const { data: convEntity } = useEntity<Conversation>(
    new TypeId(Conversation.type, conversationId),
  );
  const mappingGate = useProjectMappingGate(task ?? undefined, convEntity ?? undefined);
  const ensureMapped = mappingGate.ensureMapped;
  const mappingDialogProps = mappingGate.dialogProps;

  // Seed the chip-exclude scope used by per-message chip rows so they skip
  // entities the toolbar/drawer already shows.
  const taskKeys = useMemo(() => taskChipKeys(task ?? null), [task]);

  // Drawer + ribbon state. Drawer is collapsible — toggled via the ribbon.
  const [sideOpen, setSideOpen] = useState<boolean>(true);
  const [activeSideTab, setActiveSideTab] = useState<ConversationSideTab>('context');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [mostRecentMessageId, setMostRecentMessageId] = useState<string | null>(null);

  // Context is per-message; falls back to the most recent message so the
  // panel always shows something useful.
  const contextMessageId = selectedMessageId ?? mostRecentMessageId;

  // Runs tab target — backend stamps `target_vfs_path` on the AgenticProcess
  // as either task.typeid (task-scoped scenarios A/B/C) or conversation.typeid
  // (hub-direct). When this surface mounts us without a `task` prop but the
  // underlying conversation IS task-bound (e.g. inbox view of a Scenario B
  // help-task), fall back to the task linked from `conversation.context_entities`
  // so the query still matches the backend-stamped target. Last fallback is
  // the conversation's own typeid for genuinely task-less hub-direct convs.
  const fallbackTaskTypeId = convEntity?.firstContextOfType?.('task') ?? null;
  const targetStr = task?.typeId
    ? task.typeId.toString()
    : fallbackTaskTypeId
      ? fallbackTaskTypeId.toString()
      : convEntity?.typeId
        ? convEntity.typeId.toString()
        : '';
  const showRuns = !!targetStr;
  const { processes: runProcesses } = useProcessesForTarget(targetStr, {
    enabled: !!targetStr,
  });
  const runEntries = useMemo<ProcessEntry[]>(() => {
    const toMs = (d: unknown): number => {
      if (d instanceof Date) return d.getTime();
      if (typeof d === 'string') return new Date(d).getTime() || 0;
      return 0;
    };
    return [...runProcesses]
      .sort((a, b) => toMs(b.created_date) - toMs(a.created_date))
      .map((p) => ({ process: p }));
  }, [runProcesses]);

  // Context tab — fetch the selected message so the panel can render its
  // chips / attachments / transcript.
  const { data: contextMessage } = useEntity<FlowMessage>(
    contextMessageId ? new TypeId(FlowMessage.type, contextMessageId) : null,
  );

  const headerWrapper =
    variant === 'compact'
      ? 'flex items-center gap-1.5 text-xs font-medium text-muted-foreground'
      : 'flex h-9 flex-shrink-0 items-center gap-2 border-y border-border px-4 text-xs font-medium text-muted-foreground';
  const bodyWrapper = variant === 'compact' ? 'mt-1' : 'px-4 pt-3';

  // Context first, Runs second. Runs is hidden entirely when there's no
  // anchor to query (covered by `showRuns`).
  const tabs = [
    { id: 'context' as const, label: 'Context', icon: Layers },
    ...(showRuns
      ? [{ id: 'runs' as const, label: runEntries.length > 0 ? `Runs ${runEntries.length}` : 'Runs', icon: History }]
      : []),
  ];

  const drawerChildren: Partial<Record<ConversationSideTab, React.ReactNode>> = {
    context: (
      <ConversationContextPanel
        flowMessage={contextMessage ?? null}
        task={task ?? null}
        conversation={convEntity ?? null}
        conversationId={conversationId}
        ensureMapped={ensureMapped}
      />
    ),
  };
  if (showRuns) {
    drawerChildren.runs = (
      <WorkflowRunsPanel
        entries={runEntries}
        currentEntry={null}
        computeNodeId={targetStr || undefined}
      />
    );
  }

  const toggleSideTab = (tab: ConversationSideTab) => {
    if (sideOpen && activeSideTab === tab) {
      // Active tab clicked while drawer is open → collapse the drawer.
      setSideOpen(false);
      return;
    }
    setActiveSideTab(tab);
    setSideOpen(true);
  };

  return (
    <div className={`flex h-full min-h-0 flex-1 flex-col ${className ?? ''}`}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {headerLabel !== null && (
            <div className={headerWrapper}>
              <span>{headerLabel}</span>
            </div>
          )}
          <div className={`${bodyWrapper} min-h-0 flex-1 overflow-y-auto`}>
            <ChipsExcludeProvider add={taskKeys}>
              <ConversationView
                conversationId={conversationId}
                task={task}
                senderName={senderName}
                ensureMapped={ensureMapped}
                mode={mode}
                selectedMessageId={selectedMessageId}
                onSelectMessage={setSelectedMessageId}
                onMostRecentMessageChange={setMostRecentMessageId}
              />
            </ChipsExcludeProvider>
          </div>
        </div>

        {sideOpen ? (
          <TabbedSideDrawer<ConversationSideTab>
            open={sideOpen}
            onOpenChange={setSideOpen}
            closeIcon={PanelRightClose}
            closeLabel="Fold drawer"
            activeTab={activeSideTab}
            onActiveTabChange={setActiveSideTab}
            tabs={tabs}
            width="w-72"
            data-testid="conversation-side-drawer"
          >
            {drawerChildren}
          </TabbedSideDrawer>
        ) : (
          // Collapsed strip — clicking the drawer icon folds it back open.
          <div
            className="flex w-9 shrink-0 flex-col items-center border-l bg-background py-1.5"
            data-testid="conversation-side-drawer-collapsed"
          >
            <button
              type="button"
              onClick={() => setSideOpen(true)}
              title="Expand drawer"
              aria-label="Expand drawer"
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <ConversationBottomRibbon
        activeSideTab={sideOpen ? activeSideTab : null}
        onToggleSideTab={toggleSideTab}
        showRuns={showRuns}
        runsBadge={runEntries.length}
      />

      <OpenProjectComponent {...mappingDialogProps} />
    </div>
  );
}
