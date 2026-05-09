import { useMemo, useState } from 'react';
import { Conversation, FlowMessage, type Task, TypeId } from '@sdk';
import { isProcessRunning } from '@sdk/process/agentic-types';
import { useEntity } from '@sdk/react/hooks';
import { History, Layers } from 'lucide-react';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { TabbedSideDrawer } from '@src/components/ui/side-drawer';
import { useProcessesForTarget } from '@src/components/entity-chat-panel/hooks/useProcessesForTarget';
import { WorkflowRunsPanel } from '@src/components/workflows-view/WorkflowRunsPanel';
import type { ProcessEntry } from '@src/components/workflows-view/workflow-run-store';
import { ConversationChips } from './chips/ConversationChips';
import { ConversationEntityChips } from './chips/ConversationEntityChips';
import { ConversationToolbar } from './ConversationToolbar';
import { ConversationView } from './ConversationView';
import { ConversationMode } from './conversation-mode';
import { useProjectMappingGate } from './useProjectMappingGate';
import { ChipsExcludeProvider } from './chips/ChipsExcludeContext';
import { ChipKey, taskChipKeys } from './chips/keys';
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
   * label entirely (the toolbar still renders). Default: "Conversation".
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
 *   ┌─────────────────────────────────────────────────────┬──────────────┐
 *   │  Header (label + toolbar chips)                     │              │
 *   │  ConversationView (bubbles + composer)              │  Side drawer │
 *   │                                                     │  Runs |Cntxt │
 *   ├─────────────────────────────────────────────────────┴──────────────┤
 *   │  Bottom ribbon (toggle Runs / Context)                             │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * The drawer mirrors the workflow editor's side drawer pattern. The Runs tab
 * lists `AgenticProcess` entries scoped to this task (omitted on hub-direct
 * conversations). The Context tab reflects the message the user has clicked
 * — entity chips, attachments, transcript, and the "Open in Claude"
 * affordance for the parent task.
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

  // Seed the chip-exclude scope with what TaskChips will render so deeper
  // chip rows (MessageChips) skip duplicates automatically.
  const taskKeys = useMemo(() => taskChipKeys(task ?? null), [task]);
  // The conversation we are SHOWING is the page subject — never render a
  // chip for ourselves. Add it to the exclude scope at the toolbar level so
  // the data-driven TaskChips iteration over ``task.contextEntities`` skips
  // the matching conversation entry.
  const selfPageKeys = useMemo(
    () => new Set([ChipKey.forTypeId(new TypeId(Conversation.type, conversationId))]),
    [conversationId],
  );

  // Drawer + ribbon state.
  const [sideOpen, setSideOpen] = useState(false);
  const [activeSideTab, setActiveSideTab] = useState<ConversationSideTab>('context');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [mostRecentMessageId, setMostRecentMessageId] = useState<string | null>(null);

  const showRuns = !!task;
  const toggleSideTab = (tab: ConversationSideTab) => {
    if (sideOpen && activeSideTab === tab) {
      setSideOpen(false);
      return;
    }
    setActiveSideTab(tab);
    setSideOpen(true);
  };

  // Runs tab data — task-scoped AgenticProcess entries, newest first.
  const targetStr = task?.typeId ? task.typeId.toString() : '';
  const { processes: pastRunProcesses } = useProcessesForTarget(targetStr, {
    enabled: !!targetStr,
  });
  const runHistory = useMemo<ProcessEntry[]>(() => {
    const toMs = (d: unknown): number => {
      if (d instanceof Date) return d.getTime();
      if (typeof d === 'string') return new Date(d).getTime() || 0;
      return 0;
    };
    return [...pastRunProcesses]
      .sort((a, b) => toMs(b.created_date) - toMs(a.created_date))
      .map((p) => ({ process: p }));
  }, [pastRunProcesses]);
  const currentRunEntry = useMemo<ProcessEntry | null>(() => {
    return runHistory.find((e) => e.process.status && isProcessRunning(e.process.status)) ?? null;
  }, [runHistory]);

  // Context tab — fetch the selected (or most recent) FlowMessage so the
  // panel can render its chips/attachments/transcript.
  const contextMessageId = selectedMessageId ?? mostRecentMessageId;
  const { data: contextMessage } = useEntity<FlowMessage>(
    contextMessageId ? new TypeId(FlowMessage.type, contextMessageId) : null,
  );

  const headerWrapper =
    variant === 'compact'
      ? 'flex items-center gap-1.5 text-xs font-medium text-muted-foreground'
      : 'flex h-9 flex-shrink-0 items-center gap-2 border-y border-border px-4 text-xs font-medium text-muted-foreground';
  const bodyWrapper = variant === 'compact' ? 'mt-1' : 'px-4 pt-3';

  const tabs = [
    ...(showRuns
      ? [{ id: 'runs' as const, label: runHistory.length > 0 ? `Runs ${runHistory.length}` : 'Runs', icon: History }]
      : []),
    { id: 'context' as const, label: 'Context', icon: Layers },
  ];

  const drawerChildren: Partial<Record<ConversationSideTab, React.ReactNode>> = {
    context: (
      <ConversationContextPanel
        flowMessage={contextMessage ?? null}
        task={task ?? null}
        conversationId={conversationId}
        ensureMapped={ensureMapped}
      />
    ),
  };
  if (showRuns) {
    drawerChildren.runs = (
      <WorkflowRunsPanel
        entries={runHistory}
        currentEntry={currentRunEntry}
        computeNodeId={targetStr || undefined}
      />
    );
  }

  return (
    <div className={`flex h-full flex-col ${className ?? ''}`}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {(headerLabel !== null || task || convEntity) && (
            <div className={headerWrapper}>
              {headerLabel !== null && <span>{headerLabel}</span>}
              {task ? (
                <ChipsExcludeProvider add={selfPageKeys}>
                  <ConversationToolbar
                    task={task}
                    conversationId={conversationId}
                    ensureMapped={ensureMapped}
                  />
                </ChipsExcludeProvider>
              ) : convEntity ? (
                // Task-less conversations (project-scoped chats, hub-direct
                // convs) get the same chip strip — driven by
                // `conversation.contextEntities` (project_id projection + any
                // explicit context entries) plus the shared transcript/terminal
                // chips.
                <ChipsExcludeProvider add={selfPageKeys}>
                  <div className="flex items-center gap-1">
                    <ConversationEntityChips conversation={convEntity} />
                    <ConversationChips conversationId={conversationId} />
                  </div>
                </ChipsExcludeProvider>
              ) : null}
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

        <TabbedSideDrawer<ConversationSideTab>
          open={sideOpen}
          onOpenChange={setSideOpen}
          activeTab={activeSideTab}
          onActiveTabChange={setActiveSideTab}
          tabs={tabs}
          width="w-72"
          data-testid="conversation-side-drawer"
        >
          {drawerChildren}
        </TabbedSideDrawer>
      </div>

      <ConversationBottomRibbon
        activeSideTab={sideOpen ? activeSideTab : null}
        onToggleSideTab={toggleSideTab}
        showRuns={showRuns}
        runsBadge={runHistory.length}
      />

      <OpenProjectComponent {...mappingDialogProps} />
    </div>
  );
}
