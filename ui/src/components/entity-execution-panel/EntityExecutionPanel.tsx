import {
  AgenticProcess,
  ComputeNode,
  FlowElementTypes,
  isBusy,
  ProcessType,
  type StatusBearingProcess,
  TypeId,
  type FlowData,
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
import { History, MessageSquarePlus, Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExecutionSettingsPopover } from './ExecutionSettingsPopover';
import { CompactExecutionInput } from './CompactExecutionInput';
import { useDerivedWorkerStatus } from './hooks/useDerivedWorkerStatus';
import { useProcessesForTarget } from './hooks/useProcessesForTarget';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';

interface EntityExecutionPanelProps {
  /**
   * VFS path the session is keyed to, stored as-is in
   * `AgenticProcess.target_vfs_path`. Either an entity TypeId string
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
  processType: ProcessType;
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
}

/**
 * Compact execution panel attached to an arbitrary host entity (markdown file,
 * trigger, …); drives a single AgenticProcess keyed by `target`.
 *
 * Process lifecycle:
 *   - Queries AgenticProcess by `target_vfs_path === target`.
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

  // 4. Project workdir + id (lazy-create inputs).
  const { project } = useProject();

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

  const handleSend = useCallback(async (text: string) => {
    if (!targetStr || sending) return;
    setSending(true);
    try {
      let proc = activeProcess;

      // Lazy-create on first send.
      if (!proc) {
        if (createInFlightRef.current) return;
        createInFlightRef.current = true;
        try {
          const computeNode = await ComputeNode.getById('@local');
          if (!computeNode) throw new Error('No local compute node');
          const newProcess = await computeNode.createProcess({
            workdir: project?.fs_storage_mount_path ?? undefined,
            projectId: pendingProjectId ?? project?.id,
            targetVfsPath: targetStr,
            processType,
            outputFormat: 'stream-json',
          });
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

      await proc.prompt(text);
    } catch (err) {
      console.error('[EntityExecutionPanel] prompt failed', err);
    } finally {
      setSending(false);
    }
  }, [activeProcess, sending, targetStr, project, onProcessCreated, pendingProjectId, pendingAttachedRefs, processType]);

  const scrollRef = useRef<AutoScrollContainerHandle>(null);
  useEffect(() => {
    scrollRef.current?.scrollToBottom();
  }, [messages.length]);

  const showEmptyState = !activeProcess && !listLoading && !sending;

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

  const busy = !!indicatorProcess && isBusy(indicatorProcess);
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
        activeId={activeProcess?.id ?? null}
        onNewSession={startNewSession}
        onPickSession={selectSession}
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
            projectId={activeProcess ? (activeProcess.project_id ?? null) : (pendingProjectId ?? project?.id ?? null)}
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
        {messages.map((m) => (
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
    </div>
  );
}

// Re-export so outer callers can thread SDK types without a second import.
export type { AgenticProcess, FlowData, TypeId };

function ExecutionHistoryHeader({
  processes,
  activeId,
  onNewSession,
  onPickSession,
  cursorLine,
  settingsSlot,
  newSessionLabel,
  historyLabel,
  pastSessionsLabel,
  noPastSessionsLabel,
}: {
  processes: AgenticProcess[];
  activeId: string | null;
  onNewSession: () => void;
  onPickSession: (id: string) => void;
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
          <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
            {pastSessionsLabel}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {processes.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{noPastSessionsLabel}</div>
          ) : (
            processes.map((p) => {
              const when = p.updated_date || p.created_date;
              const ts = when ? new Date(when) : null;
              return (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => p.id && onPickSession(p.id)}
                  data-active={p.id === activeId ? 'true' : 'false'}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="text-xs">
                    {ts ? ts.toLocaleString() : 'Unknown time'}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {p.displayName}
                    {p.id === activeId ? ' · current' : ''}
                  </span>
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
