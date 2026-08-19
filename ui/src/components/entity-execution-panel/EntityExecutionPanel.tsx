import {
  AgenticProcess,
  ComputeNode,
  FlowElementTypes,
  isBusy,
  ProcessKind,
  type StatusBearingProcess,
  TypeId,
  type FlowData,
} from '@sdk';
import { annotateImageFiles } from '@src/components/image-annotator/annotate-files';
import { appendUploadedFileRefs, uploadFilesToProcessInputDir } from '@src/utils/upload-to-input-dir';
import { useEntity } from '@sdk/react/hooks';
import { AutoScrollContainer, AutoScrollContainerHandle } from '@src/components/AutoScrollContainer';
import { ProcessStatusIndicator, getStatusLabel } from '@src/components/agentic-progress/shared/status-indicator';
import ExecutionMessage from './execution-message/execution-message';
import { useProject } from '@src/hooks/useProject';
import { cn } from '@src/lib/utils';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { History, MessageSquarePlus, Settings, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExecutionSettingsPopover } from './ExecutionSettingsPopover';
import { ProcessNameBar } from './ProcessNameBar';
import { notify } from '@src/notifications/notify';
import { CompactExecutionInput } from './CompactExecutionInput';
import { QueueChip } from './QueueChip';
import { useInputHistory } from '@src/hooks/use-input-history';
import { splitLiveGroup, useTurnGroups, type TurnGroup } from '@src/components/floating-chat/groupTurnEvents';
import { TurnGroupsList } from './TurnGroupsList';
import { ChatActivityLine } from './ChatActivityLine';
import { TurnEventChip } from '@src/components/floating-chat/TurnEventChip';
import { useObservedTurn } from './hooks/useObservedTurn';
import { useTurnActivity } from './hooks/useTurnActivity';
import {
  buildHistorySubline,
  pickHistoryTitle,
  timeAgo as historyTimeAgo,
  WorkerIcon as HistoryWorkerIcon,
} from './history-row';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useProcessesForTarget } from './hooks/useProcessesForTarget';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { AssetManagerButton } from '@src/components/asset-manager';
import { useLaunchingAgent } from '@src/hooks/use-launching-agent';
import { normalizeWorkerType, type WorkerType } from '@src/components/workers/worker-types';
import { useDefaultWorkerType } from '@src/contexts/HarnessCapabilitiesContext';

const EMPTY_TURN_GROUPS: TurnGroup[] = [];

const isUserMessage = (m: FlowData) =>
  m.elementType === FlowElementTypes.USER_MESSAGE || (m.attributes && m.attributes.role === 'user');

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
   * the first `prompt()`. Use to pre-configure the process (e.g. for sub-agent files,
   * `(proc) => proc.loadEmbeddedSubagent(path)`). Not called when an existing process
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
  /**
   * When set, the history trigger renders as a labeled pill (History icon +
   * this text, e.g. "Recent") instead of the bare icon button. Vibe uses this
   * to surface a first-class "Recent" affordance next to its "New" pill.
   */
  historyTriggerLabel?: string;
  /**
   * Place the history trigger on the LEFT of the header row (right after the
   * leadingSlot) instead of its default right-side slot. Vibe groups "New" +
   * "Recent" together on the left.
   */
  historyOnLeft?: boolean;
  /** Optional content rendered immediately after the (left-placed) history
   *  trigger — e.g. Vibe's "Collaborate" button next to the "Recent" pill. */
  afterHistorySlot?: React.ReactNode;
  /** Show an editable one-liner with the active process's name directly below
   *  the header (Vibe). Off by default so other consumers are unchanged. */
  showProcessNameBar?: boolean;
  /** Header label inside the history dropdown. Defaults to "Past executions". */
  pastSessionsLabel?: string;
  /** Empty-state text shown inside the history dropdown. Defaults to "No past executions". */
  noPastSessionsLabel?: string;
  /** Empty-state body shown when no process exists yet. */
  emptyStateText?: string;
  /** Optional header label rendered above the panel (e.g. "SubAgent execution"). Hidden when omitted. */
  headerLabel?: string;
  /**
   * Optional content rendered on the LEFT of the header action row. The
   * function form receives the panel's session actions so the slot can host
   * the new-session control itself (Vibe's "+ New" pill); when a function is
   * passed the built-in new-session icon button is hidden — one affordance,
   * not two.
   */
  leadingSlot?: React.ReactNode | ((actions: { startNewSession: () => void }) => React.ReactNode);
  /** Placeholder for the composer textbox. Defaults to "Ask about this doc…". */
  placeholder?: string;
  /**
   * Opt-in composer file attachments (a "+" picker, drag-and-drop, chips).
   * Picked files upload into the process input dir at send time and ride
   * along on the prompt as path-reference lines — the same convention as
   * image paste. Off by default so other panel surfaces are unchanged.
   */
  allowAttachments?: boolean;
  /**
   * Render TOOL_CALL/TOOL_RESULT/REASONING/STATUS/ERROR events as compact
   * "dense" rows between text messages, with an expand toggle that reveals
   * the full payload. Default false — the asset-editor surfaces (Skill,
   * SubAgent, Trigger, …) intentionally stay text-only. The floating Flowpad
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
  /** Default model/tier for newly-created processes. Existing processes read
   * their model from `cli_config.model`. */
  defaultModel?: string | null;
  /** Default worker/vendor for newly-created processes. */
  defaultWorkerType?: WorkerType | null;
  /** Optional model control for surfaces that expose model selection. */
  modelSelectSlot?: (args: {
    value: string | null;
    disabled: boolean;
    onChange: (value: string) => void | Promise<void>;
    activeProcess: AgenticProcess | null;
  }) => React.ReactNode;
  /** Optional worker control for surfaces that expose worker selection. */
  workerSelectSlot?: (args: {
    value: WorkerType | null;
    disabled: boolean;
    onChange: (value: WorkerType) => void | Promise<void>;
    activeProcess: AgenticProcess | null;
  }) => React.ReactNode;
  /** Active worker changes require host-specific behavior, e.g. Vibe starts a
   * fresh chat instead of mutating the current worker. */
  onActiveWorkerChange?: (args: {
    workerType: WorkerType;
    activeProcess: AgenticProcess;
    model: string | null;
    projectId: string | null;
    workdir: string | null | undefined;
  }) => void | Promise<void>;
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
  /**
   * Extra context prepended to the NEXT user prompt (e.g. an element the user
   * selected on a previewed web app). Rendered as a dismissible chip above the
   * composer; `text` is prepended to whatever the user types, then
   * `onPromptContextConsumed` fires so the host can clear it. Null = none.
   */
  promptContext?: { label: string; text: string } | null;
  onPromptContextConsumed?: () => void;
  /** Called when the history picker chooses a concrete process. Hosts whose
   * process identity is URL-bound use this to navigate/rebind the workspace. */
  onProcessSelected?: (processId: string) => void;
  /**
   * Seed the picker to a SPECIFIC process instead of the "latest-wins" default.
   * Used when the panel must stay bound to one session across target-URL changes
   * (the vibe workspace: the side chat keeps the parent process while the user
   * navigates its child tabs). The picker stays fully functional afterward.
   */
  initialProcessId?: string | null;
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
  historyTriggerLabel,
  historyOnLeft = false,
  afterHistorySlot,
  showProcessNameBar = false,
  pastSessionsLabel = 'Past executions',
  noPastSessionsLabel = 'No past executions',
  emptyStateText = 'Ask about this document. The conversation will persist.',
  headerLabel,
  leadingSlot,
  placeholder,
  allowAttachments = false,
  dense = false,
  defaultProjectId,
  defaultWorkdir,
  defaultModel,
  defaultWorkerType,
  modelSelectSlot,
  workerSelectSlot,
  onActiveWorkerChange,
  transport = 'print',
  autoPrompt,
  promptContext,
  onPromptContextConsumed,
  onProcessSelected,
  initialProcessId,
}: EntityExecutionPanelProps) {
  const { t } = useLingui();
  const capabilityDefaultWorkerType = useDefaultWorkerType();
  const resolvedDefaultWorkerType = defaultWorkerType ?? capabilityDefaultWorkerType;
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
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(initialProcessId ?? null);
  const [forceNew, setForceNew] = useState(false);
  // `setForceNew(true)` is intentionally rendered state, but a user can click
  // New and submit in the same browser task before React commits that render.
  // Keep the creation intent in a ref as well so the send handler observes it
  // synchronously and never reuses the session the user just left.
  const forceNewRef = useRef(false);

  // When target changes (navigating between files), reset picker state — but
  // seed back to `initialProcessId` when the host pins a session (vibe keeps the
  // parent process bound while the user browses its child tabs).
  useEffect(() => {
    setSelectedProcessId(initialProcessId ?? null);
    setForceNew(false);
    forceNewRef.current = false;
  }, [targetStr, initialProcessId]);

  const pickedProcess: AgenticProcess | null = useMemo(() => {
    if (forceNew) return null;
    if (selectedProcessId) return sortedProcesses.find((p) => p.id === selectedProcessId) ?? null;
    return sortedProcesses[0] ?? null;
  }, [forceNew, selectedProcessId, sortedProcesses]);

  // 3. Resolve the full AgenticProcess entity (watched; query result may be partial).
  const effectiveProcessId = selectedProcessId ?? pickedProcess?.id ?? null;
  const processTypeId = useMemo(
    () => (effectiveProcessId ? new TypeId(AgenticProcess.type, effectiveProcessId) : null),
    [effectiveProcessId],
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
  const resolvedMatchesLocal = !!(localProcess && resolvedProcess?.id === localProcess.id);

  const activeProcess: AgenticProcess | null =
    forceNew && !resolvedMatchesLocal ? localProcess : (resolvedProcess ?? localProcess);
  // The Agent this process runs AS — signs its assistant turns. Cache-first,
  // live (a rename / new avatar repaints); null for a plain session.
  const launchingAgent = useLaunchingAgent(activeProcess?.deployment_id);

  // Hydrate history on first resolution. Per AgenticProcess.loadHistory, safe to
  // call repeatedly — internally guarded by `_historyLoaded`.
  useEffect(() => {
    if (!activeProcess) return;
    void activeProcess.loadHistory().catch((err) => {
      console.error('[EntityExecutionPanel] loadHistory failed', err);
    });
  }, [activeProcess]);

  // Stream ingestion — FlowStreamProcessor (inside AgenticProcess.prompt) appends
  // to flowDataStream; our local hook subscribes to its 'data' event.
  const items = useAgenticProcessStream(activeProcess);

  // Image paste — upload pasted screenshots to the process's input dir and return
  // one reference line per file (inserted at the caret, ridden along on the next
  // send). Same behaviour as the interactive terminal's chat composer. The input
  // dir is resolved lazily on paste (not on mount) so this shared chat surface
  // doesn't fire a per-mount GET for a rarely-used feature.
  const handlePasteImages = useCallback(
    async (incoming: File[]): Promise<string[]> => {
      const procId = activeProcess?.id;
      if (!procId || !incoming.length) return [];
      const files = await annotateImageFiles(incoming);
      if (!files.length) return [];
      return uploadFilesToProcessInputDir(procId, files);
    },
    [activeProcess],
  );
  const messages = useMemo(() => {
    return items.filter((d) => {
      const t: string = d.elementType;
      return t === FlowElementTypes.USER_MESSAGE || t === FlowElementTypes.CHAT || t === FlowElementTypes.TEXT;
    });
  }, [items]);
  // Dense layout: keep the same filtered messages but interleave them with
  // grouped non-text events (tool calls, reasoning, status, errors) rendered
  // as expandable summary rows. See `groupTurnEvents` for the partitioning
  // rules.
  // `useTurnGroups` is incremental and identity-stable across live appends
  // (QA D10); hooks can't be conditional, so it always runs and the non-dense
  // layout just ignores the (cheap, O(delta)) result.
  const groupedItems = useTurnGroups(items);
  const turnGroups = dense ? groupedItems : EMPTY_TURN_GROUPS;

  // Dense (chat) mode: a live "agent is working" footer — the SAME dots +
  // elapsed-clock line the interactive chat pane shows (ChatActivityLine),
  // plus a live event-counter chip. While a turn is in flight the CURRENT
  // turn's dense events are surfaced in that chip (its number climbs on each
  // new flow-data event; click opens the per-event list) instead of inline, so
  // the chat stays message-clean. Past turns keep their own inline collapsed
  // ToolEntryRow lists.
  const activity = useTurnActivity(dense ? activeProcess : null);
  // Render a turn this panel did not start (a worker-driven turn, or one
  // already running when the workspace opened). No-op unless such a turn is
  // live — see useObservedTurn.
  useObservedTurn(activeProcess);
  const { inlineGroups, liveEvents } = useMemo(
    () => splitLiveGroup(turnGroups, dense && activity.active),
    [dense, activity.active, turnGroups],
  );

  // 4. Project workdir + id (lazy-create inputs). Caller-supplied defaults
  // take precedence so surfaces like the floating Flowpad Assistant chat can
  // pin the process to a specific project (Flowpad Assistant) instead of
  // following the user's active project (e.g. `local`).
  const { project: activeProject } = useProject();
  const effectiveProjectId = defaultProjectId !== undefined ? defaultProjectId : (activeProject?.id ?? null);
  const effectiveWorkdir =
    defaultWorkdir !== undefined ? defaultWorkdir : (activeProject?.fs_storage_mount_path ?? undefined);

  // 5. In-flight tracking for the send button gate.
  const [sending, setSending] = useState(false);

  // Prompt history (ArrowUp/Down browsing in the composer). Seeded from the
  // loaded transcript's user messages so "1 up = last prompt" survives
  // reloads, then extended live by every send/enqueue. Keyed on the USER-
  // message count (not `messages` identity, which churns on every streamed
  // chunk) so the strip/dedup work only runs when a prompt is actually added.
  const inputHistory = useInputHistory();
  const userMessageCount = useMemo(() => messages.reduce((n, m) => n + (isUserMessage(m) ? 1 : 0), 0), [messages]);
  useEffect(() => {
    inputHistory.seed(
      messages
        .filter(isUserMessage)
        .map((m) => String(m.content ?? '').trim())
        // Strip vendor-synthetic interrupt records (claude's "[Request
        // interrupted by user…]" tool_result rows render as user messages —
        // sometimes merged onto the next typed prompt) so history holds only
        // what the user actually typed.
        .map((text) => text.replace(/^(\[Request interrupted[^\]]*\]\s*)+/, '').trim())
        .filter(Boolean),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputHistory, userMessageCount, activeProcess?.id]);

  // Pre-first-send settings — applied at lazy-create time.
  const [pendingAttachedRefs, setPendingAttachedRefs] = useState<string[]>([]);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(defaultModel ?? null);
  const [pendingWorkerType, setPendingWorkerType] = useState<WorkerType | null>(null);
  const [modelSavePending, setModelSavePending] = useState(false);

  const activeModelValue = (activeProcess?.cli_config as Record<string, unknown> | undefined)?.model;
  const activeModel = typeof activeModelValue === 'string' && activeModelValue ? activeModelValue : null;
  const effectiveModel = activeProcess ? (activeModel ?? defaultModel ?? null) : (pendingModel ?? defaultModel ?? null);
  const effectiveWorkerType = activeProcess
    ? normalizeWorkerType(activeProcess.worker_type)
    : (pendingWorkerType ?? resolvedDefaultWorkerType);

  const handleModelChange = useCallback(
    async (model: string) => {
      if (activeProcess && modelSavePending) return;
      setPendingModel(model);
      if (!activeProcess) return;

      const previous = activeProcess.cli_config ?? {};
      const previousModel = typeof previous.model === 'string' && previous.model ? previous.model : null;
      activeProcess.cli_config = { ...previous, model };
      setModelSavePending(true);
      try {
        await activeProcess.save();
      } catch (err) {
        activeProcess.cli_config = previous;
        setPendingModel(previousModel ?? defaultModel ?? null);
        console.error('[EntityExecutionPanel] model save failed', err);
        notify.error({ title: t`Model not saved`, message: err instanceof Error ? err.message : String(err) });
      } finally {
        setModelSavePending(false);
      }
    },
    [activeProcess, defaultModel, modelSavePending, t],
  );

  const handleWorkerChange = useCallback(
    async (workerType: WorkerType) => {
      if (activeProcess) {
        const currentWorker = normalizeWorkerType(activeProcess.worker_type);
        if (workerType === currentWorker) return;
        await onActiveWorkerChange?.({
          workerType,
          activeProcess,
          model: effectiveModel,
          projectId: activeProcess.project_id ?? effectiveProjectId,
          workdir: effectiveWorkdir,
        });
        return;
      }
      setPendingWorkerType(workerType);
    },
    [activeProcess, effectiveModel, effectiveProjectId, effectiveWorkdir, onActiveWorkerChange],
  );

  const startNewSession = useCallback(() => {
    forceNewRef.current = true;
    setSelectedProcessId(null);
    setLocalProcess(null);
    setForceNew(true);
    setPendingAttachedRefs([]);
    setPendingProjectId(null);
    setPendingModel(effectiveModel);
    setPendingWorkerType(effectiveWorkerType ?? resolvedDefaultWorkerType);
  }, [effectiveModel, effectiveWorkerType, resolvedDefaultWorkerType]);

  const selectSession = useCallback(
    (processId: string) => {
      forceNewRef.current = false;
      setSelectedProcessId(processId);
      setLocalProcess(null);
      setForceNew(false);
      onProcessSelected?.(processId);
    },
    [onProcessSelected],
  );

  // `pendingAttachedRefs` is still consumed when the process is created (it is
  // attached ref-by-ref in `handleSend`); what went away is the UI that used to
  // fill it — the asset manager is a read-only board now, not a picker.

  const handleSend = useCallback(
    async (text: string, opts?: { forceNewProcess?: boolean; files?: File[] }) => {
      if (!targetStr) return;
      if (text) inputHistory.addToHistory(text);
      const mustCreateNew = opts?.forceNewProcess === true || forceNewRef.current;

      // The full prompt for this turn: host-supplied context first (consumed
      // after the send so it doesn't leak into later prompts), then the typed
      // text, then one path-reference line per composer attachment — uploaded
      // here because it needs a live process id (i.e. AFTER lazy-create). An
      // upload failure throws and aborts the send: silently dropping the files
      // the user attached would be worse than a retriable error.
      const compose = (procId: string): Promise<string> =>
        appendUploadedFileRefs(procId, promptContext ? `${promptContext.text}\n\n${text}` : text, opts?.files);

      // Mid-turn sends ENQUEUE instead of racing a second turn: the backend
      // owns the queue and auto-drains it as the worker frees up (the composer
      // stays usable while busy; the queue chip shows the pending count).
      const turnBusy = !!activeProcess && isBusy(activeProcess);
      if (!mustCreateNew && activeProcess && (turnBusy || sending)) {
        try {
          await activeProcess.enqueue(await compose(activeProcess.id));
          if (promptContext) onPromptContextConsumed?.();
        } catch (err) {
          console.error('[EntityExecutionPanel] enqueue failed', err);
          notify.error({ title: t`Message not queued`, message: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (sending) return;
      setSending(true);
      try {
        let proc = mustCreateNew ? null : activeProcess;
        const isPtyPoll = transport === 'pty-poll';

        // Lazy-create on first send.
        if (!proc) {
          if (selectedProcessId && !mustCreateNew) {
            // The URL selects a process that hasn't bound yet. Creating a second
            // process would orphan the selected one, but a silent return loses
            // the send with no feedback — tell the user to retry once bound.
            notify.error({
              title: t`Message not sent`,
              message: t`The session is still connecting — try again in a moment.`,
            });
            return;
          }
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
                ...(effectiveModel ? { model: effectiveModel } : {}),
                ...(effectiveWorkerType ? { workerType: effectiveWorkerType } : {}),
                // pty-poll: interactive PTY worker, no stream-json print mode.
                ...(isPtyPoll ? {} : { outputFormat: 'stream-json' }),
              },
              // pty-poll: spawn the interactive PTY right away (visible=true
              // auto-start) so the first prompt() lands on a live worker.
              // print: declare the headless transport (pty_mode=false) — the
              // backend defaults pty_mode to true when omitted, which would put
              // the print-mode chat on a PTY worker.
              isPtyPoll ? { visible: true } : { pty_mode: false },
            );
            if (onProcessCreated) await onProcessCreated(newProcess);
            for (const ref of pendingAttachedRefs) {
              try {
                await newProcess.embeddedAssets.attach(ref);
              } catch (err) {
                console.error('[EntityExecutionPanel] attach on create failed', ref, err);
              }
            }
            setLocalProcess(newProcess);
            forceNewRef.current = false;
            proc = newProcess;
          } finally {
            createInFlightRef.current = false;
          }
        }

        if (!proc) throw new Error('process creation failed');

        // One method, both transports: the backend's prompt action routes by the
        // process's `visible` flag (PTY-transcript poll vs print-mode stream).
        await proc.prompt(await compose(proc.id));
        if (promptContext) onPromptContextConsumed?.();
      } catch (err) {
        console.error('[EntityExecutionPanel] prompt failed', err);
        notify.error({ title: t`Message not sent`, message: err instanceof Error ? err.message : String(err) });
      } finally {
        setSending(false);
      }
    },
    [
      activeProcess,
      sending,
      targetStr,
      effectiveProjectId,
      effectiveWorkdir,
      effectiveModel,
      effectiveWorkerType,
      onProcessCreated,
      pendingProjectId,
      pendingAttachedRefs,
      processType,
      transport,
      promptContext,
      onPromptContextConsumed,
      selectedProcessId,
      inputHistory,
      t,
    ],
  );

  // Stable adapter between the composer's (text, files) shape and handleSend's
  // options bag — an inline arrow here would invalidate the composer's
  // callbacks on every streamed-item render.
  const handleComposerSend = useCallback(
    (text: string, files?: File[]) => handleSend(text, files?.length ? { files } : undefined),
    [handleSend],
  );

  const handleStop = useCallback(async () => {
    if (!activeProcess) return;
    try {
      await activeProcess.interruptTurn();
    } catch (err) {
      console.error('[EntityExecutionPanel] interrupt failed', err);
      notify.error({ title: t`Could not stop`, message: err instanceof Error ? err.message : String(err) });
    }
  }, [activeProcess, t]);

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
    // In dense mode new tool events (and the appearing activity footer) don't
    // bump messages.length — track the group count + active edge too.
  }, [messages.length, turnGroups.length, activity.active]);

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
    null | { kind: 'one'; id: string; title: string } | { kind: 'all'; count: number }
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

  // Headless AND PTY turns now broadcast their worker-status transitions
  // mid-turn (the backend removed the INITIALIZING pin), so the reactive
  // `activeProcess` entity carries live status — no flowDataStream derivation
  // needed. `activeProcess` is a `StatusBearingProcess` (status + workerStatus).
  const indicatorProcess: StatusBearingProcess | null = activeProcess;

  // The backend's turn-in-flight `busy` boolean (serialized alongside
  // `status`; read via `isBusy`) drives the Stop button and routes mid-turn
  // sends to the queue. The composer itself stays USABLE while busy — typing
  // + Enter enqueues (handleSend's turn-busy branch) instead of being locked
  // out, so the only hard gate is having a target at all.
  const busy = !!indicatorProcess && isBusy(indicatorProcess);
  const sendDisabled = !targetStr;
  const modelSettingsNode = modelSelectSlot?.({
    value: effectiveModel,
    disabled: !targetStr || sending || busy || modelSavePending,
    onChange: handleModelChange,
    activeProcess,
  });
  const workerSettingsNode = workerSelectSlot?.({
    value: effectiveWorkerType,
    disabled: !targetStr || sending || busy,
    onChange: handleWorkerChange,
    activeProcess,
  });

  // While the dense chat's live activity footer is showing (dots + phase label
  // + elapsed clock), it already carries the "working" signal — suppress the
  // composer's duplicate status indicator so a turn isn't announced twice (the
  // "two dots" look). The composer slot still shows resting states (Complete /
  // Idle / asked-you-a-question) once the footer disappears.
  const statusSlot =
    indicatorProcess && !(dense && activity.active) ? (
      <span
        title={getStatusLabel(indicatorProcess)}
        className="flex items-center"
        data-testid="entity-execution-status"
      >
        <ProcessStatusIndicator process={indicatorProcess} showLabel size="sm" className="px-1 text-muted-foreground" />
      </span>
    ) : null;

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-background', className)} data-testid="entity-execution-panel">
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
        onNewSession={typeof leadingSlot === 'function' ? null : startNewSession}
        onPickSession={selectSession}
        onDeleteSession={handleDeleteOne}
        onClearAll={handleClearAll}
        cursorLine={cursorLine ?? null}
        leadingSlot={typeof leadingSlot === 'function' ? leadingSlot({ startNewSession }) : leadingSlot}
        newSessionLabel={newSessionLabel}
        historyLabel={historyLabel}
        historyTriggerLabel={historyTriggerLabel}
        historyOnLeft={historyOnLeft}
        afterHistorySlot={afterHistorySlot}
        pastSessionsLabel={pastSessionsLabel}
        noPastSessionsLabel={noPastSessionsLabel}
        settingsSlot={
          <>
            <AssetManagerButton process={activeProcess} />
            <ExecutionSettingsPopover
              activeProcess={activeProcess}
              projectId={
                activeProcess ? (activeProcess.project_id ?? null) : (pendingProjectId ?? effectiveProjectId ?? null)
              }
              onProjectChange={setPendingProjectId}
              modelControl={modelSettingsNode}
              workerControl={workerSettingsNode}
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
          </>
        }
      />
      {showProcessNameBar && activeProcess && <ProcessNameBar process={activeProcess} />}
      <AutoScrollContainer ref={scrollRef} className="flex-1 overflow-y-auto">
        {showEmptyState && <div className="p-3 text-sm text-muted-foreground">{emptyStateText}</div>}
        {dense ? (
          <>
            <TurnGroupsList
              groups={inlineGroups}
              worker={activeProcess?.worker_type ?? undefined}
              agent={launchingAgent}
              onWorkerChange={handleWorkerChange}
            />
            {activeProcess && (
              <ChatActivityLine process={activeProcess} trailing={<TurnEventChip events={liveEvents} />} />
            )}
          </>
        ) : (
          messages.map((m) => (
            <ExecutionMessage
              key={m.id ?? m.timestamp}
              flowData={m}
              worker={activeProcess?.worker_type ?? undefined}
              agent={launchingAgent}
              isUser={m.elementType === FlowElementTypes.USER_MESSAGE || (m.attributes && m.attributes.role === 'user')}
            />
          ))
        )}
      </AutoScrollContainer>
      {promptContext && (
        <div className="flex flex-shrink-0 items-center gap-2 px-3 pt-2" data-testid="prompt-context-chip">
          <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary">
            <span className="truncate">{promptContext.label}</span>
            <button
              type="button"
              aria-label={t`Clear selection`}
              className="shrink-0 rounded-full px-0.5 hover:bg-primary/20"
              onClick={() => onPromptContextConsumed?.()}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}
      <CompactExecutionInput
        onSend={handleComposerSend}
        disabled={sendDisabled}
        running={busy}
        onStop={handleStop}
        statusSlot={statusSlot}
        placeholder={placeholder}
        onPasteImages={handlePasteImages}
        allowAttachments={allowAttachments}
        leadingSlot={<QueueChip process={activeProcess} />}
        history={inputHistory}
        animateEnqueue
      />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        variant="destructive"
        title={pendingDelete?.kind === 'all' ? t`Clear all past chats?` : t`Delete this chat?`}
        description={
          pendingDelete?.kind === 'all'
            ? `This will permanently delete ${pendingDelete.count} chat session${pendingDelete.count === 1 ? '' : 's'} for this surface. The conversation transcripts saved on disk are kept; only the process records are removed. This cannot be undone.`
            : pendingDelete?.kind === 'one'
              ? `This will permanently delete "${pendingDelete.title}". The conversation transcript saved on disk is kept; only the process record is removed. This cannot be undone.`
              : ''
        }
        confirmLabel={pendingDelete?.kind === 'all' ? t`Delete all` : t`Delete`}
        onConfirm={() => {
          void performDelete();
        }}
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
  leadingSlot,
  newSessionLabel,
  historyLabel,
  historyTriggerLabel,
  historyOnLeft,
  afterHistorySlot,
  pastSessionsLabel,
  noPastSessionsLabel,
}: {
  processes: AgenticProcess[];
  workerHistoryByProcessId: Map<string, WorkerHistoryEntry>;
  activeId: string | null;
  /** Null hides the built-in new-session icon (the leadingSlot hosts it instead). */
  onNewSession: (() => void) | null;
  onPickSession: (id: string) => void;
  onDeleteSession: (id: string, title: string) => void;
  onClearAll: () => void;
  cursorLine: number | null;
  settingsSlot?: React.ReactNode;
  /** Optional node rendered on the LEFT of the header row (e.g. a title / home button). */
  leadingSlot?: React.ReactNode;
  newSessionLabel: string;
  historyLabel: string;
  /** When set, the history trigger is a labeled pill ("Recent") instead of an icon. */
  historyTriggerLabel?: string;
  /** Render the history trigger on the left (next to leadingSlot). */
  historyOnLeft?: boolean;
  /** Optional node rendered right after the left-placed history pill. */
  afterHistorySlot?: React.ReactNode;
  pastSessionsLabel: string;
  noPastSessionsLabel: string;
}) {
  const { t } = useLingui();
  const iconBtn =
    'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';
  const pillBtn =
    'inline-flex h-7 flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

  const historyDropdown = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={historyLabel}
          disabled={processes.length === 0}
          className={historyTriggerLabel ? pillBtn : iconBtn}
          data-testid="entity-execution-history"
        >
          <History className="h-3.5 w-3.5" />
          {historyTriggerLabel && <span>{historyTriggerLabel}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={historyOnLeft ? 'start' : 'end'}
        className="w-72"
        data-testid="entity-execution-history-menu"
      >
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">{pastSessionsLabel}</span>
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
              title={t`Clear all past chats`}
              data-testid="entity-execution-history-clear-all"
            >
              <Trash2 className="h-3 w-3" />
              <Trans>Clear all</Trans>
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
                className="group flex flex-col items-start gap-0.5 pe-1"
              >
                <div className="flex w-full items-center gap-1.5">
                  <HistoryWorkerIcon
                    workerType={entry?.worker_type ?? p.worker_type ?? null}
                    className="h-3 w-3 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
                  <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground">
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
                        onDeleteSession(p.id, title);
                      }}
                      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-data-[active=true]:opacity-60"
                      title={t`Delete this chat`}
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
  );

  return (
    <div
      className={cn(
        'flex flex-shrink-0 items-center gap-0.5 border-b px-2',
        // A leadingSlot (e.g. Vibe's "New" button) gets a fixed 36px header so it
        // aligns with the display pane's toolbar and gives the pill vertical room;
        // every other consumer keeps the content-sized header.
        leadingSlot ? 'h-9' : 'py-1',
      )}
      data-testid="entity-execution-header"
    >
      {leadingSlot}
      {historyOnLeft && historyDropdown}
      {historyOnLeft && afterHistorySlot}
      {cursorLine != null && (
        <span className="text-[11px] tabular-nums text-muted-foreground" data-testid="entity-execution-line-badge">
          <Trans>line {cursorLine}</Trans>
        </span>
      )}
      <div className="flex-1" />
      {onNewSession && (
        <button
          type="button"
          onClick={onNewSession}
          title={newSessionLabel}
          className={iconBtn}
          data-testid="entity-execution-new"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </button>
      )}
      {!historyOnLeft && historyDropdown}
      {settingsSlot}
    </div>
  );
}
