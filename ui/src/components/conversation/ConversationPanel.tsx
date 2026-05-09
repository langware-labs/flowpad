import { useMemo, useState } from 'react';
import { Conversation, FlowMessage, type Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { History, Layers } from 'lucide-react';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { TabbedSideDrawer } from '@src/components/ui/side-drawer';
import { useRunsForTarget } from '@src/components/runs-drawer/useRunsForTarget';
import { RunsListPanel } from '@src/components/runs-drawer/RunsListPanel';
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
 *   │  ConversationView (bubbles + comp.) │  Runs|Cntxt  │
 *   ├─────────────────────────────────────┴──────────────┤
 *   │  Bottom ribbon (toggle Runs / Context)             │
 *   └────────────────────────────────────────────────────┘
 *
 * The drawer is **always visible** (no X close — that would strand the user
 * with no way back). The ribbon at the bottom switches between Runs (every
 * Approve & Execute / headless run on this task) and Context (entity chips,
 * attachments, transcript, "Open in Claude" — all scoped to the selected
 * message). Clicking the active tab on the ribbon is a no-op; the drawer
 * stays open.
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

  // Drawer + ribbon state. Drawer is permanently open (no X close). The
  // ribbon switches between tabs.
  const [activeSideTab, setActiveSideTab] = useState<ConversationSideTab>('context');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [mostRecentMessageId, setMostRecentMessageId] = useState<string | null>(null);

  const showRuns = !!task;

  // Runs tab data — task-scoped Run entities (one row per Approve & Execute).
  // Mirrors what the legacy task-bar TaskRunsDrawer used to render.
  const targetStr = task?.typeId ? task.typeId.toString() : '';
  const { runs } = useRunsForTarget(targetStr, { enabled: !!targetStr });

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
      ? [{ id: 'runs' as const, label: runs.length > 0 ? `Runs ${runs.length}` : 'Runs', icon: History }]
      : []),
    { id: 'context' as const, label: 'Context', icon: Layers },
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
    drawerChildren.runs = <RunsListPanel runs={runs} />;
  }

  const toggleSideTab = (tab: ConversationSideTab) => {
    setActiveSideTab(tab);
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

        <TabbedSideDrawer<ConversationSideTab>
          open={true}
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
        activeSideTab={activeSideTab}
        onToggleSideTab={toggleSideTab}
        showRuns={showRuns}
        runsBadge={runs.length}
      />

      <OpenProjectComponent {...mappingDialogProps} />
    </div>
  );
}
