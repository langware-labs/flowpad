import {
  AgenticProcess,
  ComputeNode,
  FlowElementTypes,
  isBusy,
  isWorkerRunning,
  ProcessKind,
  type StatusBearingProcess,
  TypeId,
  type FlowData,
  WorkerStatus,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { AutoScrollContainer, AutoScrollContainerHandle } from '@src/components/AutoScrollContainer';
import { ProcessStatusIndicator, getStatusLabel } from '@src/components/agentic-progress/shared/status-indicator';
import ExecutionMessage from './execution-message/execution-message';
import { useProject } from '@src/hooks/useProject';
import { cn } from '@src/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { History, MessageSquarePlus, Settings, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExecutionSettingsPopover } from './ExecutionSettingsPopover';
import { CompactExecutionInput } from './CompactExecutionInput';
import { groupTurnEvents } from '@src/components/floating-chat/groupTurnEvents';
import { TurnGroupsList } from './TurnGroupsList';
import {
  buildHistorySubline,
  pickHistoryTitle,
  timeAgo as historyTimeAgo,
  WorkerIcon as HistoryWorkerIcon,
} from './history-row';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useDerivedWorkerStatus } from './hooks/useDerivedWorkerStatus';
import { useProcessesForTarget } from './hooks/useProcessesForTarget';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';

interface EntityExecutionPanelProps {
  /**
   * VFS path the session is keyed to, stored as-is in
   * `AgenticProcess.target_typeid_str`. Either an entity TypeId string
   * (`"agent-<uuid>"`, `"plan-<uuid>"`, …) or a `<typeid>/<sub_path>` form
   * (`"compute_node-<id>/Users/.../foo.md"` for a per-document session). Null
   * disables the panel (send is guarded on non-empty target).
   */
  target: string | null;
  /**
   * Discriminator for the AgenticProcess this panel owns. Threaded into both
   * the `useProcessesForTarget` filter (so chat & execution panels for the
   * same target don't see each other's history) and the lazy `createProcess`
   * call (so newly-spawned processes get tagged correctly).
   */
  processType: ProcessKind;
  className?: string;
  /**
   * Invoked once, right after the backing `AgenticProcess` is created and before
   * the first `prompt()`. Use to pre-configure the process (e.g. for agent files,
   * `(proc) => proc.loadEmbeddedAgent(path)`). Not called when an existing process
   * is picked up from `useProcessesForTarget`.
   */
  onProcessCreated?: (process: AgenticProcess) => Promise<void> | void;
  /**
   * Caret line (1-indexed, on-disk) from the host editor. Rendered as a left-side
   * "line N" badge in the panel header. Null/undefined hides the badge.
   */
  cursorLine?: number | null;
  /** Tooltip for the settings button. Defaults to "Settings". */
  settingsLabel?: string;
  /** Tooltip for the new-session button. Defaults to "New execution". */
  newSessionLabel?: string;
  /** Tooltip for the history button. Defaults to "Execution history". */
  historyLabel?: string;
  /** Header label inside the history dropdown. Defaults to "Past executions". */
  pastSessionsLabel?: string;
  /** Empty-state text shown inside the history dropdown. Defaults to "No past executions". */
  noPastSessionsLabel?: string;
  /** Empty-state body shown when no process exists yet. */
  emptyStateText?: string;
  /** Optional header label rendered above the panel (e.g. "Agent execution"). Hidden when omitted. */
  headerLabel?: string;
  /** Placeholder for the composer textbox. Defaults to "Ask about this doc…". */
  placeholder?: string;
  /**
   * Render TOOL_CALL/TOOL_RESULT/REASONING/STATUS/ERROR events as compact
   * "dense" rows between text messages, with an expand toggle that reveals
   * the full payload. Default false — the asset-editor surfaces (Skill,
   * Agent, Trigger, …) intentionally stay text-only. The floating Flowpad
   * Assistant chat opts in.
   */
  dense?: boolean;
  /**
   * Override the project that newly-spawned processes are tagged with and
   * the workdir they run in. Defaults to the user's currently-active project
   * (`useProject()`). The floating Flowpad Assistant chat passes the
   * Flowpad-Assistant project here so its workdir, project_id, and the
   * settings popover's asset-manager all scope to the assistant project,
   * not whatever the user happens to be looking at.
   */
  defaultProjectId?: string | null;
  defaultWorkdir?: string | null;
  /**
   * EXPERIMENT: chat transport. Selects how the process is created; both call
   * the same `prompt()`, which the backend routes by the process's `visible`
   * flag.
   * - 'print' (default): headless print-mode process (visible=false); FlowData
   *   streamed from the worker's stream-json stdout.
   * - 'pty-poll': PTY-interactive worker (visible=true); FlowData derived
   *   server-side by polling the session transcript for new entries; the
   *   stream closes on transcript inactivity.
   */
  transport?: 'print' | 'pty-poll';
  /**
   * Imperative prompt injection from the host surface (e.g. the transcript
   * toolbar's Run/Rerun/Refresh-analysis buttons). When `nonce` changes the
   * panel sends `text` exactly as if the user typed it. `newSession: true`
   * bypasses the current process so the send lazy-creates a fresh one — one
   * process per run, so each run is its own history entry.
   */
  autoPrompt?: { text: string; nonce: number; newSession?: boolean } | null;
}

/**
 * Compact execution panel attached to an arbitrary host entity (markdown file,
 * trigger, …); drives a single AgenticProcess keyed by `target`.
 *
 * Process lifecycle:
 *   - Queries AgenticProcess by `target_typeid_str === target`.
 *   - If a process already exists, reuse it (session persistence survives reloads).
 *   - If none, create one lazily on the first send via `computeNode.createProcess({
 *       targetVfsPath, outputFormat: "stream-json" })`. Print-mode processes
 *     don't spawn a PTY, so no `start({headless})` needed.
 *   - Every send invokes `process.prompt(text)` which POSTs to the streaming
 *     `prompt` action on AgenticProcess; FlowData flows into `process.flowDataStream`
 *     and renders via `useProcessStream`.
 */
export function EntityExecutionPanel({
  target,
  processType,
  className,
  onProcessCreated,
  cursorLine,
  settingsLabel = 'Settings',
  newSessionLabel = 'New execution',
  historyLabel = 'Execution history',
  pastSessionsLabel = 'Past executions',
  noPastSessionsLabel = 'No past executions',
  emptyStateText = 'Ask about this document. The conversation will persist.',
  headerLabel,
  placeholder,
  dense = false,
  defaultProjectId,
  defaultWorkdir,
  transport = 'print',
  autoPrompt,
}: EntityExecutionPanelProps) {
  const targetStr = target ?? '';

  // 1. Pull all processes attached to this target; sort newest-first for picker + auto-select.
  const { processes, isLoading: listLoading } = useProcessesForTarget(targetStr, { processType });
  const sortedProcesses = useMemo(() => {
    return [...processes].sort((a, b) => {
      const ta = new Date(a.updated_date || a.created_date || 0).getTime();
      const tb = new Date(b.updated_date || b.created_date || 0).getTime();
      return tb - ta;
    });
  }, [processes]);

  // Worker-history join — same backend action that powers the terminal's
  // full HistoryModal. The dropdown rows merge each AgenticProcess with its
  // matching entry to display the rich info (subject, project, branch, msg
  // count, worker icon) instead of bare ids and timestamps.
  const { entries: workerHistoryEntries } = useWorkerHistory(30);
  const workerHistoryByProcessId = useMemo(() => {
    const map = new Map<string, WorkerHistoryEntry>();
    for (const entry of workerHistoryEntries) {
      if (entry.agentic_process_id) map.set(entry.agentic_process_id, entry);
    }
    return map;
  }, [workerHistoryEntries]);

  // 2. User-selected process overrides the default "latest-wins" pick. `null` means auto-latest
  //    or, when combined with startNewSession(), a fresh one on the next send.
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [forceNew, setForceNew] = useState(false);

  // When target changes (navigating between files), reset picker state.
  useEffect(() => {
    setSelectedProcessId(null);
    setForceNew(false);
  }, [targetStr]);

  const pickedProcess: AgenticProcess | null = useMemo(() => {
    if (forceNew) return null;
    if (selectedProcessId) return sortedProcesses.find((p) => p.id === selectedProcessId) ?? null;
    return sortedProcesses[0] ?? null;
  }, [forceNew, selectedProcessId, sortedProcesses]);

  // 3. Resolve the full AgenticProcess entity (watched; query result may be partial).
  const processTypeId = useMemo(
    () => (pickedProcess?.id ? new TypeId(AgenticProcess.type, pickedProcess.id) : null),
    [pickedProcess?.id],
  );
  const { data: resolvedProcess } = useEntity<AgenticProcess>(processTypeId, {
    watch: true,
    enabled: !!processTypeId,
  });

  // 4. Creation guard — a locally-spawned process survives until the query picks it up.
  //    Rather than setState'ing selectedProcessId/forceNew from an effect once the
  //    query catches up (which cascades into a re-render chain), derive both
  //    effective values directly. localProcess is reset only by the user-driven
  //    callbacks below (startNewSession / selectSession) — no effect-driven cleanup,
  //    which previously fired a setState during another EntityExecutionPanel render
  //    and tripped React's "cannot update while rendering" warning.
  const createInFlightRef = useRef(false);
  const [localProcess, setLocalProcess] = useState<AgenticProcess | null>(null);
  const resolvedMatchesLocal = !!(
    localProcess && resolvedProcess?.id === localProcess.id
  );

  const activeProcess: AgenticProcess | null = forceNew && !resolvedMatchesLocal
    ? localProcess
    : ((resolvedProcess as AgenticProcess | null | undefined) ?? localProcess);

  // Hydrate history on first resolution. Per AgenticProcess.loadHistory, safe to
  // call repeatedly — internally guarded by `_historyLoaded`.
  useEffect(() => {
    if (!activeProcess) return;
    void activeProcess.loadHistory().catch((err) => {
      console.error('[EntityExecutionPanel] loadHistory failed', err);
    });
  }, [activeProcess?.id]);

  // Stream ingestion — FlowStreamProcessor (inside AgenticProcess.prompt) appends
  // to flowDataStream; our local hook subscribes to its 'data' event.
  const items = useAgenticProcessStream(activeProcess);
  const messages = useMemo(() => {
    return items.filter((d) => {
      const t: string = d.elementType;
      return (
        t === FlowElementTypes.USER_MESSAGE ||
        t === FlowElementTypes.CHAT ||
        t === FlowElementTypes.TEXT
      );
    });
  }, [items]);
  // Dense layout: keep the same filtered messages but interleave them with
  // grouped non-text events (tool calls, reasoning, status, errors) rendered
  // as expandable summary rows. See `groupTurnEvents` for the partitioning
  // rules.
  const turnGroups = useMemo(() => (dense ? groupTurnEvents(items) : []), [dense, items]);

  // 4. Project workdir + id (lazy-create inputs). Caller-supplied defaults
  // take precedence so surfaces like the floating Flowpad Assistant chat can
  // pin the process to a specific project (Flowpad Assistant) instead of
  // following the user's active project (e.g. `local`).
  const { project: activeProject } = useProject();
  const effectiveProjectId =
    defaultProjectId !== undefined ? defaultProjectId : (activeProject?.id ?? null);
  const effectiveWorkdir =
    defaultWorkdir !== undefined ? defaultWorkdir : (activeProject?.fs_storage_mount_path ?? undefined);

  // 5. In-flight tracking for the send button gate.
  const [sending, setSending] = useState(false);

  // Pre-first-send settings — applied at lazy-create time.
  const [pendingAttachedRefs, setPendingAttachedRefs] = useState<string[]>([]);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  const startNewSession = useCallback(() => {
    setSelectedProcessId(null);
    setLocalProcess(null);
    setForceNew(true);
    setPendingAttachedRefs([]);
    setPendingProjectId(null);
  }, []);

  const selectSession = useCallback((processId: string) => {
    setSelectedProcessId(processId);
    setLocalProcess(null);
    setForceNew(false);
  }, []);

  const liveAttachedRefs = useMemo(
    () => (activeProcess?.embedded_asset_refs ?? []).map((r) => r.toString()),
    [activeProcess?.embedded_asset_refs],
  );
  const effectiveAttachedRefs = activeProcess ? liveAttachedRefs : pendingAttachedRefs;

  const handleAttach = useCallback(async (ref: string) => {
    if (activeProcess) {
      await activeProcess.embeddedAssets.attach(ref);
    } else {
      setPendingAttachedRefs((prev) => (prev.includes(ref) ? prev : [...prev, ref]));
    }
  }, [activeProcess]);

  const handleDetach = useCallback(async (ref: string) => {
    if (activeProcess) {
      await activeProcess.embeddedAssets.detach(ref);
    } else {
      setPendingAttachedRefs((prev) => prev.filter((r) => r !== ref));
    }
  }, [activeProcess]);

  const handleSend = useCallback(async (text: string, opts?: { forceNewProcess?: boolean }) => {
    if (!targetStr || sending) return;
    setSending(true);
    try {
      let proc = opts?.forceNewProcess ? null : activeProcess;
      const isPtyPoll = transport === 'pty-poll';

      // Lazy-create on first send.
      if (!proc) {
        if (createInFlightRef.current) return;
        createInFlightRef.current = true;
        try {
          const computeNode = await ComputeNode.getById('@local');
          if (!computeNode) throw new Error('No local compute node');
          const newProcess = await computeNode.createProcess(
            {
              workdir: effectiveWorkdir ?? undefined,
              projectId: pendingProjectId ?? effectiveProjectId ?? undefined,
              targetVfsPath: targetStr,
              processType,
              // pty-poll: interactive PTY worker, no stream-json print mode.
              ...(isPtyPoll ? {} : { outputFormat: 'stream-json' }),
            },
            // pty-poll: spawn the interactive PTY right away (visible=true
            // auto-start) so the first prompt() lands on a live worker.
            isPtyPoll ? { visible: true } : undefined,
          );
          if (onProcessCreated) await onProcessCreated(newProcess);
          for (const ref of pendingAttachedRefs) {
            try { await newProcess.embeddedAssets.attach(ref); }
            catch (err) { console.error('[EntityExecutionPanel] attach on create failed', ref, err); }
          }
          setLocalProcess(newProcess);
          proc = newProcess;
        } finally {
          createInFlightRef.current = false;
        }
      }

      if (!proc) throw new Error('process creation failed');

      // One method, both transports: the backend's prompt action routes by the
      // process's `visible` flag (PTY-transcript poll vs print-mode stream).
      await proc.prompt(text);
    } catch (err) {
      console.error('[EntityExecutionPanel] prompt failed', err);
    } finally {
      setSending(false);
    }
  }, [activeProcess, sending, targetStr, effectiveProjectId, effectiveWorkdir, onProcessCreated, pendingProjectId, pendingAttachedRefs, processType, transport]);

  // Host-injected prompt (Run/Rerun/Refresh analysis). Nonce-gated so the
  // same object can sit in props without re-firing on unrelated renders.
  const lastAutoNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!autoPrompt || autoPrompt.nonce === lastAutoNonceRef.current) return;
    lastAutoNonceRef.current = autoPrompt.nonce;
    if (autoPrompt.newSession) startNewSession();
    void handleSend(autoPrompt.text, { forceNewProcess: autoPrompt.newSession });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrompt?.nonce]);

  const scrollRef = useRef<AutoScrollContainerHandle>(null);
  useEffect(() => {
    scrollRef.current?.scrollToBottom();
  }, [messages.length]);

  const showEmptyState = !activeProcess && !listLoading && !sending;

  // ── Past-chats deletion ────────────────────────────────────────────────────
  // Two flows share a single ConfirmDialog: per-row trash (kind='one') and the
  // top-of-list "Clear all" (kind='all'). The dialog stages the action; on
  // confirm we call AgenticProcess.delete() which fires DELETE on the entity
  // and the data-manager's WS handler removes it from `useEntitiesQuery`
  // results — the dropdown rerenders without the deleted rows automatically.
  // If the deleted process is the active session, we also clear `selectedProcessId`
  // and `localProcess` so the panel falls back to the latest remaining one.
  const [pendingDelete, setPendingDelete] = useState<
    | null
    | { kind: 'one'; id: string; title: string }
    | { kind: 'all'; count: number }
  >(null);

  const handleDeleteOne = useCallback((id: string, title: string) => {
    setPendingDelete({ kind: 'one', id, title });
  }, []);

  const handleClearAll = useCallback(() => {
    setPendingDelete({ kind: 'all', count: sortedProcesses.length });
  }, [sortedProcesses.length]);

  const performDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const idsToDelete =
      pendingDelete.kind === 'one'
        ? [pendingDelete.id]
        : sortedProcesses.map((p) => p.id).filter((id): id is string => !!id);

    // Clear active picks that point at to-be-deleted ids so the panel doesn't
    // try to render a process that no longer exists between the WS deletion
    // event and the next query refresh.
    if (idsToDelete.includes(selectedProcessId ?? '')) setSelectedProcessId(null);
    if (idsToDelete.includes(localProcess?.id ?? '')) setLocalProcess(null);
    if (pendingDelete.kind === 'all') setForceNew(false);

    for (const id of idsToDelete) {
      const proc = sortedProcesses.find((p) => p.id === id);
      if (!proc) continue;
      try {
        await proc.delete();
      } catch (err) {
        console.error('[EntityExecutionPanel] delete failed for', id, err);
      }
    }
  }, [pendingDelete, sortedProcesses, selectedProcessId, localProcess?.id]);

  // CLI-mode processes don't get entity patches mid-turn, so fall back to a
  // derivation over flowDataStream events. See useDerivedWorkerStatus.
  const derivedWorkerStatus = useDerivedWorkerStatus(activeProcess);
  const indicatorProcess: StatusBearingProcess | null = activeProcess
    ? {
        status: activeProcess.status,
        workerStatus: derivedWorkerStatus ?? activeProcess.workerStatus,
        session_id: activeProcess.session_id,
      }
    : null;

  // EXPERIMENT(pty-poll): a PTY chat session must stay sendable when its
  // worker is dead (backend restart, worker exit) — the prompt turn relaunches
  // it with --resume. `isBusy` would lock the composer forever (it requires
  // status=RUNNING), so the pty arm skips the status gate and blocks only on
  // the gold mid-turn predicate — mirroring the backend prompt action's own
  // admission, which rejects only STOPPING/FAILED.
  // PENDING_USER: the turn finished cleanly and the worker is waiting at its
  // prompt for the next message — exactly when the user should be able to type.
  // `isBusy` returns true for PENDING_USER (it isn't in READY_WORKER_STATUSES,
  // mirroring Python's `is_ready_for_input`) but the drain-local superset and
  // the prompt action both admit it. Carve it out so the textarea stays enabled.
  const indicatorWorkerStatus = indicatorProcess?.workerStatus as WorkerStatus | undefined;
  const busy = !!indicatorProcess && (
    transport === 'pty-poll'
      ? isWorkerRunning(indicatorWorkerStatus as WorkerStatus)
      : isBusy(indicatorProcess) && indicatorWorkerStatus !== WorkerStatus.PENDING_USER
  );
  const sendDisabled = !targetStr || sending || busy;

  const statusSlot = indicatorProcess ? (
    <span
      title={getStatusLabel(indicatorProcess)}
      className="flex items-center"
      data-testid="entity-execution-status"
    >
      <ProcessStatusIndicator
        process={indicatorProcess}
        showLabel
        size="sm"
        className="px-1 text-muted-foreground"
      />
    </span>
  ) : null;

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
      data-testid="entity-execution-panel"
    >
      {headerLabel && (
        <div
          className="flex-shrink-0 border-b px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
          data-testid="entity-execution-header-label"
        >
          {headerLabel}
        </div>
      )}
      <ExecutionHistoryHeader
        processes={sortedProcesses}
        workerHistoryByProcessId={workerHistoryByProcessId}
        activeId={activeProcess?.id ?? null}
        onNewSession={startNewSession}
        onPickSession={selectSession}
        onDeleteSession={handleDeleteOne}
        onClearAll={handleClearAll}
        cursorLine={cursorLine ?? null}
        newSessionLabel={newSessionLabel}
        historyLabel={historyLabel}
        pastSessionsLabel={pastSessionsLabel}
        noPastSessionsLabel={noPastSessionsLabel}
        settingsSlot={
          <ExecutionSettingsPopover
            attachedRefs={effectiveAttachedRefs}
            onAttach={handleAttach}
            onDetach={handleDetach}
            activeProcess={activeProcess}
            projectId={activeProcess ? (activeProcess.project_id ?? null) : (pendingProjectId ?? effectiveProjectId ?? null)}
            onProjectChange={setPendingProjectId}
            trigger={
              <button
                type="button"
                title={settingsLabel}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                data-testid="entity-execution-settings"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            }
          />
        }
      />
      <AutoScrollContainer ref={scrollRef} className="flex-1 overflow-y-auto">
        {showEmptyState && (
          <div className="p-3 text-[11px] text-muted-foreground">
            {emptyStateText}
          </div>
        )}
        {dense
          ? <TurnGroupsList groups={turnGroups} />
          : messages.map((m) => (
              <ExecutionMessage
                key={m.id ?? m.timestamp}
                flowData={m}
                isUser={
                  m.elementType === FlowElementTypes.USER_MESSAGE ||
                  (m.attributes && m.attributes.role === 'user')
                }
              />
            ))}
      </AutoScrollContainer>
      <CompactExecutionInput onSend={handleSend} disabled={sendDisabled} statusSlot={statusSlot} placeholder={placeholder} />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
        variant="destructive"
        title={
          pendingDelete?.kind === 'all'
            ? `Clear all past chats?`
            : `Delete this chat?`
        }
        description={
          pendingDelete?.kind === 'all'
            ? `This will permanently delete ${pendingDelete.count} chat session${pendingDelete.count === 1 ? '' : 's'} for this surface. The conversation transcripts saved on disk are kept; only the process records are removed. This cannot be undone.`
            : pendingDelete?.kind === 'one'
              ? `This will permanently delete "${pendingDelete.title}". The conversation transcript saved on disk is kept; only the process record is removed. This cannot be undone.`
              : ''
        }
        confirmLabel={pendingDelete?.kind === 'all' ? 'Delete all' : 'Delete'}
        onConfirm={() => { void performDelete(); }}
      />
    </div>
  );
}

// Re-export so outer callers can thread SDK types without a second import.
export type { AgenticProcess, FlowData, TypeId };

function ExecutionHistoryHeader({
  processes,
  workerHistoryByProcessId,
  activeId,
  onNewSession,
  onPickSession,
  onDeleteSession,
  onClearAll,
  cursorLine,
  settingsSlot,
  newSessionLabel,
  historyLabel,
  pastSessionsLabel,
  noPastSessionsLabel,
}: {
  processes: AgenticProcess[];
  workerHistoryByProcessId: Map<string, WorkerHistoryEntry>;
  activeId: string | null;
  onNewSession: () => void;
  onPickSession: (id: string) => void;
  onDeleteSession: (id: string, title: string) => void;
  onClearAll: () => void;
  cursorLine: number | null;
  settingsSlot?: React.ReactNode;
  newSessionLabel: string;
  historyLabel: string;
  pastSessionsLabel: string;
  noPastSessionsLabel: string;
}) {
  const iconBtn =
    'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div
      className="flex flex-shrink-0 items-center gap-0.5 border-b px-2 py-1"
      data-testid="entity-execution-header"
    >
      {cursorLine != null && (
        <span
          className="text-[11px] tabular-nums text-muted-foreground"
          data-testid="entity-execution-line-badge"
        >
          line {cursorLine}
        </span>
      )}
      <div className="flex-1" />
      <button
        type="button"
        onClick={onNewSession}
        title={newSessionLabel}
        className={iconBtn}
        data-testid="entity-execution-new"
      >
        <MessageSquarePlus className="h-3.5 w-3.5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={historyLabel}
            disabled={processes.length === 0}
            className={iconBtn}
            data-testid="entity-execution-history"
          >
            <History className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72" data-testid="entity-execution-history-menu">
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {pastSessionsLabel}
            </span>
            {processes.length > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  // Stop the click from bubbling into the dropdown (which would
                  // try to treat it as an item-select and close the menu before
                  // the confirm dialog can mount).
                  e.preventDefault();
                  e.stopPropagation();
                  onClearAll();
                }}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title="Clear all past chats"
                data-testid="entity-execution-history-clear-all"
              >
                <Trash2 className="h-3 w-3" />
                Clear all
              </button>
            )}
          </div>
          <DropdownMenuSeparator />
          {processes.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{noPastSessionsLabel}</div>
          ) : (
            processes.map((p) => {
              const entry = p.id ? workerHistoryByProcessId.get(p.id) : undefined;
              const title = pickHistoryTitle(p, entry);
              const subline = buildHistorySubline(entry);
              // `updated_date` / `created_date` can come through as either an
              // ISO string or a Date depending on how the entity was hydrated;
              // normalize to ISO so `timeAgo` can parse uniformly.
              const lastActiveRaw = entry?.last_active_time ?? p.updated_date ?? p.created_date ?? null;
              const lastActive: string | null =
                lastActiveRaw == null
                  ? null
                  : typeof lastActiveRaw === 'string'
                    ? lastActiveRaw
                    : lastActiveRaw instanceof Date
                      ? lastActiveRaw.toISOString()
                      : String(lastActiveRaw);
              const isActive = p.id === activeId;
              return (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => p.id && onPickSession(p.id)}
                  data-active={isActive ? 'true' : 'false'}
                  className="group flex flex-col items-start gap-0.5 pr-1"
                >
                  <div className="flex w-full items-center gap-1.5">
                    <HistoryWorkerIcon
                      workerType={entry?.worker_type ?? p.worker_type ?? null}
                      className="h-3 w-3 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {title}
                    </span>
                    <span className="flex-shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {historyTimeAgo(lastActive)}
                    </span>
                    {p.id && (
                      <button
                        type="button"
                        onClick={(e) => {
                          // Block the row's onSelect — clicking the trash
                          // should NOT also load the session into the panel.
                          e.preventDefault();
                          e.stopPropagation();
                          onDeleteSession(p.id!, title);
                        }}
                        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-data-[active=true]:opacity-60"
                        title="Delete this chat"
                        data-testid={`entity-execution-history-delete-${p.id}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {(subline || isActive) && (
                    <span className="text-[10px] text-muted-foreground">
                      {subline}
                      {isActive ? `${subline ? ' · ' : ''}current` : ''}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {settingsSlot}
    </div>
  );
}
