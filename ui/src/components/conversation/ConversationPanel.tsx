import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Conversation, type Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { History, Layers, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { TabbedSideDrawer } from '@src/components/ui/side-drawer';
import { CollapsedSideRail, SideRailButton } from '@src/components/ui/collapsed-side-rail';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { ProcessRunsPanel } from '@src/components/process-runs/ProcessRunsPanel';
import type { ProcessEntry } from '@src/components/process-runs/process-run-store';
import { ConversationView } from './ConversationView';
import { useProjectMappingGate } from './useProjectMappingGate';
import { ChipsExcludeProvider } from './chips/ChipsExcludeContext';
import { taskChipKeys } from './chips/keys';
import { ConversationBottomRibbon, type ConversationSideTab } from './ConversationBottomRibbon';
import { ConversationContextPanel } from './ConversationContextPanel';
import { MembersAvatarStack } from './MembersAvatarStack';
import { ProjectChip } from '@src/components/project/ProjectChip';

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
  className?: string;
  /**
   * URL-derived selected message id (the `/message/<id>` pointer segment).
   * When it changes, the panel syncs its selection to that single bubble —
   * highlight + scroll-into-view follow. Hosts without a message-deep-link
   * URL shape simply omit it and selection stays panel-local.
   */
  selectedMessageId?: string | null;
  /**
   * URL-first bubble clicks: when provided, clicking a message navigates
   * (the host builds the `/message/<id>` dock pointer) instead of writing
   * local selection state — the URL change flows back via
   * `selectedMessageId`. Omitted → local-state selection (embedded hosts).
   */
  onMessageNavigate?: (messageId: string) => void;
  /** URL-carried thread filter (`?thread=<id>`); null = show every thread. */
  threadId?: string | null;
  /** Open a thread (id) or return to the packed list (null). */
  onThreadNavigate?: (threadId: string | null) => void;
  /** Agent mailbox scope preserved from the URL. */
  agentId?: string | null;
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
/**
 * Click-to-rename for the conversation title. Click the text → inline input;
 * Enter/blur commits, Escape cancels. Commit is just ``conv.title = next;
 * conv.save()`` — the backend's save→data_op broadcast updates every other
 * client viewing this conversation (e.g. a second tab) via ``useEntity``.
 */
export function EditableConversationTitle({
  conv,
  fallback,
  className = 'text-xs font-medium',
}: {
  conv: Conversation | null;
  fallback: string;
  /** Text styling (size/weight/truncation) applied to both the static span and the edit input. */
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!conv)
    return (
      <span className={className} title={fallback}>
        {fallback}
      </span>
    );

  const display = (conv.title ?? '').trim() || fallback;

  const commit = async () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === (conv.title ?? '')) return;
    conv.title = next;
    try {
      await conv.save();
      conv.markEdit();
    } catch {
      // best-effort; the optimistic title stays until the next sync
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        data-testid="conversation-title-input"
        className={cn('min-w-0 flex-1 border-b border-border bg-transparent text-foreground outline-none', className)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <span
      data-testid="conversation-title"
      className={cn('cursor-text rounded px-0.5 hover:bg-muted', className)}
      title={display}
      onClick={() => {
        setDraft(conv.title ?? '');
        setEditing(true);
      }}
    >
      {display}
    </span>
  );
}

export function ConversationPanel({
  task,
  conversationId,
  senderName,
  headerLabel = 'Conversation',
  variant = 'default',
  className,
  selectedMessageId,
  onMessageNavigate,
  threadId,
  onThreadNavigate,
  agentId,
}: ConversationPanelProps) {
  // One gate, two subject shapes. Remote provenance always lives on the
  // conversation; the gate stamps the task when present (task owns project_root
  // for cwd) or the conversation itself otherwise. Both shapes feed the same
  // `OpenProjectComponent` dialog and the same per-machine remote→local
  // mapping table.
  const { data: convEntity } = useEntity<Conversation>(new TypeId(Conversation.type, conversationId));
  const mappingGate = useProjectMappingGate(task ?? undefined, convEntity ?? undefined);
  const ensureMapped = mappingGate.ensureMapped;
  const mappingDialogProps = mappingGate.dialogProps;

  // Seed the chip-exclude scope used by per-message chip rows so they skip
  // entities the toolbar/drawer already shows.
  const taskKeys = useMemo(() => taskChipKeys(task ?? null), [task]);

  // Drawer + ribbon state. Drawer is collapsible — toggled via the ribbon.
  // Starts minimized: executing a prompt surfaces the run inline via the
  // per-message run-status one-liner (near the Execute button), so the drawer
  // opens only on demand (ribbon toggle or clicking a run-status one-liner).
  const [sideOpen, setSideOpen] = useState<boolean>(false);
  const [activeSideTab, setActiveSideTab] = useState<ConversationSideTab>('context');
  // The run a message's one-liner asked to open — highlighted in the Runs tab.
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  // Selection drives the bubble highlight + per-row highlight in the
  // aggregated Context panel. It's a list rather than a single id so that
  // clicking a context entity can light up *every* message the entity was
  // contributed by — and so clicking any one of those messages keeps lighting
  // the same entity row.
  //   - Clicking a bubble  → [thatId] (size 1), no entity selected.
  //   - Clicking an entity → that entity's full origin list + the entity's
  //     own row-key so we can light *only* that entity (not every other
  //     entity that happens to share those bubbles).
  // The asymmetry matters: a bubble lighting up doesn't imply every entity
  // attached to it should also light. Entity-mode is the more precise
  // selection — it pins exactly one row to the highlight, plus the bubbles
  // that contributed it.
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [selectedEntityKey, setSelectedEntityKey] = useState<string | null>(null);
  // URL → selection sync (mirrors the transcript viewer's entry-id sync):
  // when the host passes a `/message/<id>` deep-link segment, the panel's
  // selection derives from it. Entity-mode multi-selection stays panel-local
  // (clicking a context entity doesn't change the URL), but any URL change
  // wholesale-replaces it with the single linked bubble.
  useEffect(() => {
    if (!selectedMessageId) return;
    setSelectedMessageIds([selectedMessageId]);
    setSelectedEntityKey(null);
  }, [selectedMessageId]);
  const selectOneMessage = useCallback(
    (id: string) => {
      // URL-first when the host supports it: navigating re-enters via the
      // `selectedMessageId` effect above. No optimistic local write.
      if (onMessageNavigate) {
        onMessageNavigate(id);
        return;
      }
      setSelectedMessageIds([id]);
      setSelectedEntityKey(null);
    },
    [onMessageNavigate],
  );
  const selectEntity = useCallback((entityKey: string, messageIds: string[]) => {
    setSelectedMessageIds(messageIds);
    setSelectedEntityKey(entityKey);
  }, []);

  // Runs tab target — always the conversation typeid. Approve & Execute
  // stamps every spawned AP with ``target_vfs_path = <conversation typeid>``,
  // so sibling conversations under the same task get independent Runs lists.
  // (Legacy task-scoped APs from before this refactor — Scenarios A/B/C —
  // still exist in the DB stamped with task typeid; they no longer surface
  // here and need to be cleaned up out of band if visibility is desired.)
  const targetStr = convEntity?.typeId ? convEntity.typeId.toString() : '';
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
    return [...runProcesses].sort((a, b) => toMs(b.created_date) - toMs(a.created_date)).map((p) => ({ process: p }));
  }, [runProcesses]);

  const headerWrapper =
    variant === 'compact'
      ? 'flex items-center gap-1.5 text-xs font-medium text-muted-foreground'
      : 'flex h-9 flex-shrink-0 items-center gap-2 border-y border-border px-4 text-xs font-medium text-muted-foreground';
  const bodyWrapper = variant === 'compact' ? 'mt-1' : 'px-4 pt-3';

  // Context first, Runs second. Runs is hidden entirely when there's no
  // anchor to query (covered by `showRuns`).
  const tabs = [
    { id: 'context' as const, label: t`Context`, icon: Layers },
    ...(showRuns
      ? [{ id: 'runs' as const, label: runEntries.length > 0 ? `Runs ${runEntries.length}` : 'Runs', icon: History }]
      : []),
  ];

  const drawerChildren: Partial<Record<ConversationSideTab, React.ReactNode>> = {
    context: (
      <ConversationContextPanel
        task={task ?? null}
        conversation={convEntity ?? null}
        conversationId={conversationId}
        ensureMapped={ensureMapped}
        selectedMessageIds={selectedMessageIds}
        selectedEntityKey={selectedEntityKey}
        onSelectEntity={selectEntity}
      />
    ),
  };
  if (showRuns) {
    drawerChildren.runs = (
      <ProcessRunsPanel
        entries={runEntries}
        currentEntry={runEntries.find((e) => e.process.id === focusedRunId) ?? null}
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

  // Clicking a message's run-status one-liner opens that run in the Runs tab,
  // focused on it. Execution itself no longer pops the drawer — the user opens
  // it here on demand. No-op when the conversation has no Runs target.
  const openRun = useCallback(
    (processId: string) => {
      if (!showRuns) return;
      setFocusedRunId(processId);
      setActiveSideTab('runs');
      setSideOpen(true);
    },
    [showRuns],
  );

  return (
    <div className={`flex h-full min-h-0 flex-1 flex-col ${className ?? ''}`}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {headerLabel !== null && (
            <div className={headerWrapper}>
              <EditableConversationTitle conv={convEntity ?? null} fallback={headerLabel} />
              <ProjectChip projectId={convEntity?.project_id ?? null} className="me-auto" />
              <MembersAvatarStack typeId={new TypeId(Conversation.type, conversationId)} />
            </div>
          )}
          <div className={`${bodyWrapper} relative min-h-0 flex-1 overflow-y-auto`}>
            <ChipsExcludeProvider add={taskKeys}>
              <ConversationView
                // Keyed so switching conversations RESETS the view's local
                // state. Without it the instance is reused and an in-flight
                // "composing…" line follows you into the next conversation.
                key={conversationId}
                conversationId={conversationId}
                task={task}
                senderName={senderName}
                ensureMapped={ensureMapped}
                selectedMessageIds={selectedMessageIds}
                onSelectMessage={selectOneMessage}
                onOpenRun={openRun}
                threadId={threadId}
                onThreadNavigate={onThreadNavigate}
                agentId={agentId}
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
          <CollapsedSideRail data-testid="conversation-side-drawer-collapsed">
            <SideRailButton icon={PanelRightOpen} label={t`Expand drawer`} onClick={() => setSideOpen(true)} />
          </CollapsedSideRail>
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
