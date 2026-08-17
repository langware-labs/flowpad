/**
 * AgenticProcess Entity - Represents a running instruction execution
 *
 * Extends APIEntity to receive entity notifications from the backend.
 * Provides:
 * - state: Current processor state
 * - output(): AsyncGenerator for streaming FlowData
 * - stackFrame: Access to execution variables
 */

import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { isApiError } from '../ApiResponse';
import { IEntity } from '../IEntity';
import { FSRef, type FSRefJson } from '../fs/FSRef';
import { ClaudeAgentOptions, factory as cliOptionsFactory } from '../cli_workers';
import { dataContext } from '../FlowSync/context';
import { FlowDataFactory } from '../flow_processing/flow-data-factory';
import { Artifact, type IArtifact } from '../entities/artifact/artifact';
import { Shell, ShellStatus } from '../entities/shell';
import { FlowData, FlowDataAttribute, FlowDataSource } from '../flow_processing';
import { FlowElementTypes } from '../flow_processing/flow-element-types';
import { ActionInfo } from '../models/ActionInfo';
import type { FlowEvent } from '../tags/EventBus';
import { toplog } from '../services/toplog';

/** Elapsed ms since `t0` formatted for `process_load` trace lines. */
const msSince = (t0: number): string => (performance.now() - t0).toFixed(1);
import type { AssetDescriptor } from './asset-descriptor';
import { DockPointerData } from '../models/DockPointer';
import { TypeId } from '../models/TypeId';
import { ViewType } from '../utils/ui/view-types';
import { VFSPath } from '../utils/vfs-path';
import { AgenticContext, IAgenticProcessOptions, ISpawnWorkerOptions, PermissionMode } from './agentic-context';
import { PROCESS_STATUS_KIND, ProcessStatusReport, parseStatusReport } from './process-status-report';
import type { ProcessKind } from './process-types';
import {
  ProcessIconKey,
  ProcessStatus,
  WorkerMode,
  WorkerStatus,
  isProcessRunning,
  isReadyForInput,
  isWorkerRunning,
  isWorkerTerminal,
  type WorkerType,
} from './agentic-types';
import type {
  TranscriptFormat as TranscriptFormatType,
  TranscriptSource as TranscriptSourceType,
} from '../transcript-analyzer';

// Connection membership and PTY recovery are now fully backend-owned:
//   - membership: PtyRegistry.on_ws_connect/on_ws_disconnect (park/resume) wired
//     to the WS lifecycle (server/routes/websocket.py).
//   - mid-session dead-worker respawn: the periodic backend watchdog
//     (server/pty_recovery.py start_recovery_task).
// The frontend no longer probes os-status, polls, or re-attaches on reconnect.

/**
 * Result returned by AgenticProcess.spawn().
 */
/**
 * Resolved `flow show` display target — the payload of the `on_show` entity
 * event, produced by the backend's `resolve_display_target`
 * (flow_sdk/core/display_target.py). Discriminated by `kind`.
 */
export interface ShowTarget {
  /** Mirrors python `DisplayTargetKind` (flow_sdk/core/display_target.py). */
  kind?: 'entity' | 'vfs' | 'webapp' | 'app' | 'shell' | string;
  /** entity: canonical `<type>-<id>` string. */
  typeid?: string;
  type?: string;
  id?: string;
  /** entity (when shown by path) | vfs: the resolved absolute path. */
  path?: string;
  /** webapp: the dev-server port. */
  port?: number | string;
  /** dock: a SCREEN — the frontend's own dock-address fields, so the client
   *  builds its DockPointer without re-parsing a URL. */
  view_type?: string;
  pointer?: string | null;
  options?: Record<string, string> | null;
  page?: string;
}

/**
 * One entry in a process's display history — `context_data.display_stack`. The
 * backend flattens the `flow show` target and stamps it with `shown_at`, so an
 * entry IS a {@link ShowTarget} plus its server timestamp. Newest last.
 */
export interface DisplayEntry extends ShowTarget {
  /** ISO 8601 server timestamp — when the agent showed this target. */
  shown_at?: string;
}

export interface SpawnResult {
  process: AgenticProcess;
  /** Set in PTY mode */
  shell?: Shell;
  /** Set in both modes */
  workerSessionId?: string | null;
}

/**
 * ProcessState — minimal status wrapper for a process instance.
 */
export interface ProcessState {
  status: WorkerStatus;
}

/**
 * Response from get-history action
 */
interface HistoryResponse {
  history: Array<{
    flow_value: unknown;
    attributes: Record<string, string>;
    index?: number;
    part?: number;
    created_time?: string;
    focus?: string;
    process_entry?: Record<string, unknown> | null;
  }>;
  count: number;
  session_id: string | null;
  use_worker_history: boolean;
}

interface HistoryMatchCandidate {
  item: FlowData;
  matched: boolean;
}

/**
 * Stable per-row identity for history⇄live reconciliation: the transcript
 * entry id (from the typed `process_entry` payload, falling back to the
 * `transcript-entry-id` attribute for rows that only carry it as an attr).
 * Returns null for rows with no transcript id — those reconcile via
 * `historyFallbackKey` instead.
 */
function historyIdentityKey(item: FlowData): string | null {
  const processEntry = item.processEntry as { transcript_entry?: { id?: unknown; kind?: unknown } } | null;
  const transcriptEntry = processEntry?.transcript_entry;
  const id = transcriptEntry?.id ?? item.attributes['transcript-entry-id'];
  if (id === undefined || id === null || id === '') return null;
  const kind = transcriptEntry?.kind ?? item.attributes.subtype ?? '';
  return `${item.elementType}|${String(kind)}|${String(id)}`;
}

function historyFallbackKey(item: FlowData): string {
  const role = item.attributes.role ?? '';
  return `${item.elementType}|${role}|${item.timestamp}|${item.content ?? ''}`;
}

/**
 * Drop the history rows that were already observed live, one-for-one.
 *
 * Matching is two-tier: transcript-entry identity first (exact), then the
 * fallback key `elementType|role|timestamp|content` with a one-for-one
 * `take()` — every existing item can absorb AT MOST ONE history row, so N
 * identical rows in history always survive as N total rows (the pre-fix
 * Set-based content dedup collapsed them to 1).
 *
 * INVARIANT (id-less collisions): for rows with no transcript id, K existing
 * live rows and M history rows sharing all four fallback fields reconcile to
 * `max(K, M)` total rows — never fewer. Collapsing below that requires two
 * genuinely distinct transcript entries with identical elementType, role,
 * content AND the same wire timestamp while ALSO lacking transcript ids;
 * transcript-shaped rows carry `process_entry.transcript_entry.id`, so the
 * timestamp component bounds the residual risk to non-transcript rows minted
 * in the same instant with identical content — an acceptable dedup.
 */
function reconcileHistoryOverlap(history: FlowData[], existing: readonly FlowData[]): FlowData[] {
  const candidates: HistoryMatchCandidate[] = existing.map((item) => ({ item, matched: false }));
  const byIdentity = new Map<string, HistoryMatchCandidate[]>();
  const byFallback = new Map<string, HistoryMatchCandidate[]>();

  const add = (index: Map<string, HistoryMatchCandidate[]>, key: string, candidate: HistoryMatchCandidate) => {
    const bucket = index.get(key);
    if (bucket) bucket.push(candidate);
    else index.set(key, [candidate]);
  };
  for (const candidate of candidates) {
    const identity = historyIdentityKey(candidate.item);
    if (identity) add(byIdentity, identity, candidate);
    add(byFallback, historyFallbackKey(candidate.item), candidate);
  }

  const take = (index: Map<string, HistoryMatchCandidate[]>, key: string): boolean => {
    const bucket = index.get(key);
    while (bucket?.length) {
      const candidate = bucket.shift()!;
      if (candidate.matched) continue;
      candidate.matched = true;
      return true;
    }
    return false;
  };

  return history.filter((item) => {
    const identity = historyIdentityKey(item);
    if (identity && take(byIdentity, identity)) return false;
    return !take(byFallback, historyFallbackKey(item));
  });
}

/**
 * The artifact an `artifact.*` event is about.
 *
 * `data.artifact_id` is the adapter's identity field; the colon-form `target`
 * (`artifact:<id>`) is the normative fallback, because the bus grammar
 * guarantees it even when a future emitter trims `data` further.
 */
function artifactIdOf(event: FlowEvent): string {
  const fromData = event.data?.artifact_id;
  if (typeof fromData === 'string' && fromData) return fromData;
  const [type, id] = String(event.target ?? '').split(':');
  return type === Artifact.type && id ? id : '';
}

/**
 * Artifact fields carried by an event. The lane is deliberately LEAN — identity
 * and pointers, never the row body — so anything absent is left to whatever the
 * row already had (or to the next snapshot). `created_date` falls back to the
 * envelope timestamp so a freshly created row can win `latestArtifact` before
 * any REST read confirms it.
 */
function artifactFieldsOf(event: FlowEvent, id: string): Partial<IArtifact> {
  const data = event.data ?? {};
  const str = (key: string): string | undefined => {
    const value = data[key];
    return typeof value === 'string' && value ? value : undefined;
  };
  const fields: Record<string, unknown> = { id, type: Artifact.type };
  for (const key of ['name', 'kind', 'asset_ref', 'target_type_id', 'generated_by', 'project_id', 'description']) {
    const value = str(key);
    if (value !== undefined) fields[key] = value;
  }
  if (event.tag === 'artifact.created' && event.timestamp) fields.created_date = event.timestamp;
  return fields as Partial<IArtifact>;
}

export enum AgenticProcessEventName {
  FirstPrompt = 'first_prompt',
}

export interface AgenticProcessReportEventResult {
  accepted: boolean;
  scheduled: boolean;
  process_id: string;
  worker_type?: string | null;
  session_id: string | null;
  event_name: AgenticProcessEventName;
  event_data: Record<string, unknown>;
  request_id?: string | null;
  task_name?: string;
}

/**
 * One pending prompt in the backend file-backed PromptQueue. Flat shape —
 * mirrors `flow_sdk/builtin/agentic_process/prompt_queue/prompt_queue.py`.
 */
export interface QueueEntry {
  id: string;
  prompt: string;
  source: string;
  created_at: string;
}

/**
 * Reflected state of a process's prompt queue. Read-only on the frontend:
 * the backend owns the file + the drain; the UI mutates only via the
 * `enqueue` / `dequeue` / `clear-queue` / `set-queue-enabled` actions.
 */
export interface QueueState {
  enabled: boolean;
  entries: QueueEntry[];
}

/** A user-facing markdown doc authored by an AgenticProcess (docs chip). */
export interface MarkdownDoc {
  /** Absolute path to the .md file. */
  path: string;
  /** Basename of `path`, shown as the chip/row label. */
  name: string;
  /** `create` (written via Write) or `update` (written via Edit / re-write). */
  change: 'create' | 'update';
}

/**
 * Interface for AgenticProcess entity data
 */
export interface IAgenticProcess extends IEntity {
  instruction_content?: string;
  asset_ref?: string;
  workdir?: string | null;
  context_data?: Record<string, unknown>;
  // ``shared_context_entities`` is inherited from IEntity (wire shape).
  // ``privateContextEntities`` is exposed by the APIEntity getter — no
  // field is declared here for it (local-only, never on the wire).
  favorite_index?: number | null;
  readonly status?: ProcessStatus;
  /** Turn-in-flight boolean (``is_turn_busy``) — orthogonal to ``status``. */
  readonly busy?: boolean;
  /** Null on the wire when the backend has no transcript to derive one from. */
  readonly worker_status?: WorkerStatus | null;
  session_id?: string | null;
  /**
   * USD cost of this process's session transcript so far. Computed
   * server-side from the session jsonl via
   * flow_sdk.transcript_analyzer.pricing.total_cost_usd; not persisted on
   * the entity. Null when no session_id exists yet.
   */
  total_cost_usd?: number | null;
  use_worker_history?: boolean;
  /** False=direct PTY spawn (default), True=legacy zsh intermediary */
  shell_mode?: boolean;
  /** CLI worker vendor (e.g. 'claude', 'codex'). Drives icon selection. */
  worker_type?: string | null;
  /** Discriminates how this process is being used (chat vs execution). */
  process_type?: ProcessKind | null;
  /** Shell entity ID linked to this process */
  shell_id?: string | null;
  /** DEPRECATED one-release alias of base-Entity `tabbed` (kept in lock-step server-side). */
  visible?: boolean;
  /** Transport intent and the routing key: true → interactive PTY (default,
   *  today's behaviour); false → headless JSON-stream (no PTY/xterm). Seeds
   *  `visible` at launch and is kept durable across reload by the loader. All
   *  routing keys on `pty_mode`, never `visible` (a hidden live PTY is
   *  visible=false + pty_mode=true). */
  pty_mode?: boolean;
  /** Backend-computed driver capability: this worker supports CLI plan mode
   *  (`--permission-mode plan`). Drives the headless-chat plan toggle. */
  supports_plan_mode?: boolean;
  /** tabbed / tab_order / last_active_at come from IEntity (base-Entity fields). */
  /** Sidecar plain shell PTY session ID */
  sidecar_shell_id?: string | null;
  /** WebSocket connection ID of the browser tab that opened this process (runtime field, not persisted) */
  connection_id?: string | null;
  /** True when PTY OSC title escapes may update `name`. Cleared the first time the user manually renames this tab. */
  auto_rename?: boolean;
  /**
   * Derived: true when the worker is ready for a new user prompt.
   * Computed server-side via ``is_ready_for_input``. Read-only on the wire.
   */
  ready_for_input?: boolean;
  /** @internal — use AgenticProcess.cliOptions getter/setter instead */
  cli_config?: Record<string, any>;
  /** Extra directories passed to Claude via --add-dir */
  additional_dirs?: string[];
  /** Per-process override for mounting the Flowpad Assistant project
   *  (--add-dir → its .claude/skills + agents become discoverable). When
   *  null/undefined it inherits the global ServiceConfig.load_flowpad_assistant.
   *  Set via {@link enableAssistant}. */
  load_flowpad_assistant?: boolean | null;
  /** TypeIds of entities materialized under the process's assets dir. */
  embedded_asset_refs?: TypeId[];
  /** Owning project ID */
  project_id?: string | null;
  /** CollaborationRoom this process was spawned in, if any */
  collaboration_room_id?: string | null;
  /** VFS path the process is keyed to. Either an entity TypeId ("type-id") for entity-scoped processes, or "<typeid>/<sub_path>" for surface-scoped processes (e.g. a per-doc process keyed on the file path). */
  target_typeid_str?: string | null;
  /**
   * True when a worker-relevant field changed since the last successful start()
   * while status==RUNNING. Backend sets this automatically via the save-hook;
   * external callers may write it directly to signal an out-of-band change.
   * Cleared only by start() on its success path.
   */
  restart_required?: boolean;
  /**
   * Reason the last worker launch failed to start (the worker exited within
   * the backend's instant-exit window). Non-null LATCHES the process out of
   * auto-recovery: the os-status sweep skips it and plain `open` calls are
   * refused server-side, so a worker that dies on arrival isn't relaunched
   * every 5s forever. Cleared only by an explicit user retry
   * (`start({ retry: true })`) or a launch that survives the window.
   */
  start_failure?: string | null;
  /**
   * MD5 of the worker-relevant snapshot captured at the last successful start().
   * Compared against the current snapshot on every save() to detect drift.
   */
  last_started_hash?: string | null;
  /** Root of the per-process execution folder — `<record_dir>/execution/`. */
  exe_folder?: FSRefJson | null;
  /** `<exe_folder>/input/` — instruction/queue inputs. */
  input_folder?: FSRefJson | null;
  /** `<exe_folder>/output/` — artifacts the agent writes back. */
  output_folder?: FSRefJson | null;
  /** `<exe_folder>/assets/` — materialised embedded agents / skills. */
  assets_folder?: FSRefJson | null;
  /**
   * Absolute path to the latest plan markdown produced by this process,
   * or null if the process has not produced a plan yet.
   *
   * Populated either by the line-trigger pipeline (when the path appears
   * in PTY output) or by the server-side ``get-plan`` action when it
   * resolves the path from the transcript JSONL. Persists across reloads
   * so the "Open Plan" UI affordance survives a refresh without needing
   * the trigger to re-fire.
   */
  plan_path?: string | null;
  /**
   * User-facing markdown docs this process authored, oldest-first (tail =
   * latest). Drives the ribbon's "Open Doc" chip. Plan files / agent-internal
   * docs are excluded server-side. Persists across reloads.
   */
  markdown_docs?: MarkdownDoc[];
  /**
   * Latest ProcessStatusReport snapshot (counters + focused asset + statuses),
   * backend-computed and persisted. Mirrored on reload and refreshed live via
   * the `progress_report` flow_data envelope. Wire shape is a plain object.
   */
  status_report?: Record<string, unknown> | null;
  /**
   * Reflected prompt-queue state. Computed server-side from the on-disk
   * `prompt_queue.json` and pushed via `data_op`; never persisted on the
   * entity and never written from the frontend (mutate via the queue actions).
   */
  queue?: QueueState | null;
}

/**
 * AgenticProcess Entity - A running instruction execution process
 *
 * Created by AgenticProcess.spawn(), this entity tracks execution state
 * and provides streaming access to FlowData outputs.
 *
 * @example
 * ```typescript
 * const process = await AgenticProcess.spawn({ workdir }, { instruction: 'Run the task' });
 *
 * // Stream outputs as they arrive
 * for await (const flowData of process.output()) {
 *   console.log('Received:', flowData);
 * }
 *
 * // Access final state
 * console.log('Final variables:', process.state.variables);
 * console.log('Stack frame:', process.stackFrame);
 * ```
 */
@registerEntity
export class AgenticProcess extends APIEntity<AgenticProcess> implements IAgenticProcess {
  /** Entity type for AgenticProcess */
  static type: string = 'agentic_process';

  /** Backend redirect URL for the process's live web-app port. */
  getWebAppHostUrl(port: string): string {
    const action = new ActionInfo('get-host', AgenticProcess.type, this.id);
    action.queryParameters = { port };
    return action.fullActionUrl;
  }

  /**
   * Spawn a visible AgenticProcess tab and (optionally) send an initial
   * prompt. Mirrors the `Start Claude` / `Start Codex` openers in
   * TabbedTerminal — use this from any UI surface outside the tab strip
   * (e.g. an editor "discuss this doc" button) that needs to launch a
   * harness tab pre-filled with a user prompt.
   *
   * @param workerType - see {@link WorkerType}
   * @param prompt - Optional initial user prompt. Placed on the process's
   *   prompt queue (not injected directly): the backend drains the queue head
   *   as the worker's launch instruction when the dock starts it, so the
   *   first prompt boots the worker deterministically (no post-spawn stdin
   *   race).
   * @param project - Optional project to run the tab in. Defaults to the active
   *   `dataContext.project`. Pass an explicit project when the prompt relies on
   *   project-scoped assets (e.g. a `.claude/skills` skill that only lives in a
   *   specific system project) so the spawned worker's cwd can discover them.
   * @returns The spawned AgenticProcess (already navigated to).
   */
  static async openTab(
    workerType: WorkerType,
    prompt?: string,
    project?: { id?: string; fs_storage_mount_path?: string | null } | null,
    opts?: { ptyMode?: boolean },
  ): Promise<AgenticProcess> {
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('[AgenticProcess.openTab] No local compute node');
    const proj = project ?? dataContext.project;
    // Transport intent: default PTY (today's behaviour). `ptyMode:false` →
    // headless launch: `visible:false` so the backend skips the PTY auto-start;
    // the seeded first prompt drains headlessly server-side.
    const ptyMode = opts?.ptyMode !== false;
    // Seed the prompt onto the queue via createProcess (`launchPrompt`), which
    // enqueues it server-side BEFORE the visible auto-start. The worker then
    // boots with the queued head as its launch instruction — deterministic,
    // no post-spawn stdin race (the original "lost first prompt" bug). A
    // separate enqueue after createProcess would land too late (the worker has
    // already started).
    const process = await computeNode.createProcess(
      {
        workdir: proj?.fs_storage_mount_path ?? undefined,
        ...(proj?.id ? { projectId: proj.id } : {}),
        workerType,
      },
      { visible: ptyMode, pty_mode: ptyMode, watchProcess: false, ...(prompt ? { launchPrompt: prompt } : {}) },
    );
    process.openTerminalDock();
    return process;
  }

  /**
   * Launch a visible agentic worker in an explicit project workdir — the
   * single seam for "start a session for *this* thing in *its* project".
   *
   * Unlike {@link openTab} (which falls back to the global `dataContext.project`
   * and never touches the assistant flag), `launch` runs in the caller's
   * `workdir` and can mount the Flowpad Assistant skills via the per-process
   * `load_flowpad_assistant` flag — so a conversation session runs in the
   * conversation's OWN project while still discovering the assistant, instead of
   * switching the cwd to the `@flowpad_assistant` system project.
   *
   * The first prompt rides the prompt queue (`launchPrompt`), enqueued
   * server-side BEFORE the auto-start: the fresh spawn pops the head as its
   * launch instruction (deterministic, no post-spawn stdin race). The assistant
   * flag and provenance links are applied on the same createProcess round-trip,
   * before the worker boots, so the driver's `--add-dir` set is correct on the
   * first launch.
   *
   * @returns The launched AgenticProcess (terminal dock already opened).
   */
  static async launch(opts: {
    workerType?: WorkerType;
    workdir: string;
    projectId?: string | null;
    /** First prompt — placed on the queue, popped as the launch instruction. */
    launchPrompt?: string;
    /** Mount the Flowpad Assistant skills/agents for this worker. */
    enableAssistant?: boolean;
    /** String TypeIds stamped onto the process's `shared_context_entities`. */
    sharedContextEntities?: string[];
    /** Discriminator stamped on the new process (e.g. ProcessKind.Conversation). */
    processType?: ProcessKind;
    /** Attachment key stamped onto `target_typeid_str` — entity-scoped
     *  (`TypeId#toString()`) or surface-scoped (`<typeid>/<sub_path>`). Lets
     *  `useProcessesForTarget` find this process later (e.g. the analyzer for a
     *  received transcript, keyed `claude_session/<sessionId>`). */
    target?: string;
    /** Transport intent: true → interactive PTY (default), false → headless
     *  JSON-stream (no PTY/xterm). */
    ptyMode?: boolean;
  }): Promise<AgenticProcess> {
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('[AgenticProcess.launch] No local compute node');
    const ptyMode = opts.ptyMode !== false;
    const process = await computeNode.createProcess(
      {
        workdir: opts.workdir,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.workerType ? { workerType: opts.workerType } : {}),
        ...(opts.enableAssistant ? { loadFlowpadAssistant: true } : {}),
        ...(opts.sharedContextEntities?.length ? { sharedContextEntities: opts.sharedContextEntities } : {}),
        ...(opts.processType ? { processType: opts.processType } : {}),
        ...(opts.target ? { targetVfsPath: opts.target } : {}),
      },
      {
        visible: ptyMode,
        pty_mode: ptyMode,
        watchProcess: false,
        ...(opts.launchPrompt ? { launchPrompt: opts.launchPrompt } : {}),
      },
    );
    process.openTerminalDock();
    return process;
  }

  /**
   * Create and activate an AgenticProcess in one call.
   *
   * Replaces the manual `createProcess -> start/watch` pattern.
   * Use `headless: true` in workerOptions for background execution (no PTY).
   *
   * @example PTY shell
   * ```typescript
   * const { process, shellId } = await AgenticProcess.spawn(
   *   { permissionMode: 'bypassPermissions', workdir },
   *   { instruction: 'Do the thing' },
   * );
   * ```
   *
   * @example Headless
   * ```typescript
   * const { process } = await AgenticProcess.spawn(
   *   { permissionMode: 'bypassPermissions', resumeSessionId: id, forkSession: true },
   *   { headless: true },
   * );
   * await process.executeInstruction('...', { sync: false });
   * ```
   */
  static async spawn(options: IAgenticProcessOptions, workerOptions?: ISpawnWorkerOptions): Promise<SpawnResult> {
    const { ComputeNode } = await import('../entities/compute-node/compute-node');
    const computeNode = await ComputeNode.getLocal();
    if (!computeNode) throw new Error('[AgenticProcess.spawn] No local compute node');

    // `createProcess` is the one backend-owned construction seam. It resolves a
    // missing worker from the persisted harness capability and builds the
    // vendor-specific CLI config; an explicit `options.workerType` remains an
    // override. Keep creation non-visible so PTY activation still happens once,
    // below, after optional ancestry/shell-mode fields are saved.
    const process = await computeNode.createProcess(
      {
        ...options,
        // Preserve spawn()'s historical no-debug default. The generic
        // createProcess action defaults debug on for interactive openers.
        debug: options.debug ?? false,
      },
      {
        visible: false,
        pty_mode: !workerOptions?.headless,
        watchProcess: false,
        ...(workerOptions?.result ? { result: workerOptions.result } : {}),
      },
    );
    process.shell_mode = options.shellMode;
    await process.save(options.scope ?? []);

    if (workerOptions?.headless) {
      await process.watch();
      if (workerOptions.instruction) {
        await process.executeInstruction(workerOptions.instruction, {
          sync: workerOptions.sync ?? false,
          workerSessionId: workerOptions.workerSessionId,
        });
      }
      return { process, workerSessionId: workerOptions.workerSessionId };
    }

    await process.start({
      instruction: workerOptions?.instruction,
      visible: workerOptions?.visible,
      ptyTimeout: workerOptions?.ptyTimeout,
    });
    return { process, shell: await process.shell(), workerSessionId: process.session_id };
  }

  /**
   * Build (but do not save) a headless AgenticProcess — the single chokepoint
   * for the "print_mode + stream-json, no PTY" triplet used by background
   * runs (workflow runner, index rebuild, …). The caller supplies the
   * entity-specific fields (context_data, workdir, target_typeid_str,
   * process_type) and owns the `.save([typeId])` linkage.
   *
   * All routing/classification keys on `pty_mode`, never `visible` — so the
   * transport is pinned CLI (`pty_mode=false`) here, independent of `visible`.
   */
  static newHeadless(fields: Partial<IAgenticProcess> = {}): AgenticProcess {
    const cliOptions = new ClaudeAgentOptions({
      permission_mode: 'bypassPermissions',
      print_mode: true,
      output_format: 'stream-json',
      verbose: true,
    });
    return new AgenticProcess({
      cli_config: cliOptions.toJson(),
      visible: false,
      pty_mode: false,
      ...fields,
    });
  }

  /**
   * Get a process by ID with history auto-loaded.
   *
   * Unlike the base getById, this method automatically loads the process
   * history from the backend, making the process ready for inspection
   * or continuation.
   *
   * @param id - Process ID
   * @returns AgenticProcess with history loaded, or null if not found
   *
   * @example
   * ```typescript
   * const process = await AgenticProcess.getById(processId);
   * if (process) {
   *   console.log('History items:', process.flowDataStream.items.length);
   *   // Can continue execution
   *   await process.execute("Next instruction");
   * }
   * ```
   */
  static async getByIdWithHistory(id: string): Promise<AgenticProcess | null> {
    const typeId = new TypeId(AgenticProcess.type, id);
    const process = await dataManager.getByTypeId<AgenticProcess>(typeId);
    if (process) {
      await process.loadHistory();
    }
    return process;
  }

  /**
   * Open (or create) an AgenticProcess for a Record and ensure it has a live PTY.
   *
   * If an entity already exists for the given record ID it is reused;
   * otherwise a new AgenticProcess is created from the record's session_id.
   * start() is called to spawn or reuse a PTY (idempotent).
   *
   * @param record - Object with `id` and optional `session_id`
   * @returns AgenticProcess with an active shell session
   */
  static async openRecordInTerminal(record: { id: string; session_id?: string | null }): Promise<AgenticProcess> {
    let entity = await AgenticProcess.getById(record.id).catch(() => null);

    if (!entity && record.session_id) {
      entity = new AgenticProcess({ session_id: record.session_id });
      await entity.save();
    }

    if (!entity) {
      throw new Error('Cannot open terminal: no session_id on Record');
    }

    // start() is idempotent: no-op if PTY alive, restarts with claude --resume if stale.
    await entity.start();

    return entity;
  }

  /**
   * Resolve a worker/session/thread id to a ready-to-use AgenticProcess.
   *
   * Single round-trip: backend auto-discovers worker_type,
   * resolves cwd + project from the on-disk session record, upserts the
   * AgenticProcess (heals existing or creates+starts a new one), and returns
   * the full entity dict. We hydrate the dataManager cache directly — no
   * follow-up `getById` needed.
   *
   * @param workerId - Claude session id, Codex thread id, or any future worker id.
   * @param workerType - Optional resolver hint when the caller already knows the worker vendor.
   * @returns The AgenticProcess entity, or `null` if no on-disk session matches.
   */
  static async getByWorkerId(workerId: string, workerType?: string | null): Promise<AgenticProcess | null> {
    // Workflow runs (id `wf_<runId>`) are not worker sessions and never have a
    // backing AgenticProcess — short-circuit so callers (status indicators,
    // shell/worker deep-link recovery) don't fire a guaranteed 404.
    if (workerId.startsWith('wf_')) return null;
    const computeNode = dataContext.computeNode;
    if (!computeNode) throw new Error('[AgenticProcess.getByWorkerId] No compute node');

    const action = new ActionInfo('terminals', 'compute_node', computeNode.id, 'GET');
    action.subpath = `get_by_worker_id/${workerId}`;
    const normalizedWorkerType = workerType?.toLowerCase() ?? null;
    const hint = normalizedWorkerType === 'claude_code' ? 'claude' : normalizedWorkerType;
    // Omitting a vendor here does not fail loudly — the hint is silently dropped
    // and the backend falls back to scanning every vendor, so the bug shows up
    // only as a slower path or a wrong-vendor match. Keep in step with the
    // backend's own allowlist in `_scan_get_by_worker_id`.
    if (hint === 'claude' || hint === 'codex' || hint === 'copilot' || hint === 'opencode') {
      action.queryParameters = { worker_type: hint };
    }
    try {
      const data = await dataManager.callAction<void, IAgenticProcess | null>(action);
      if (!data) return null;
      return dataManager.castAndDeepAssign<AgenticProcess>(data) as AgenticProcess;
    } catch (e) {
      if (isApiError(e) && e.response?.status === 404) return null;
      throw e;
    }
  }

  /** POST /graph/agentic_process/<id>/rename {name} — user rename from OUTSIDE the
   *  tab strip (the footer process list). The backend pins `auto_rename=false` and
   *  mirrors onto any open tab, so it behaves exactly like a tab rename (updates
   *  both the process and its chip). Works for a headless worker with no open tab.
   *  The entity broadcast updates cache so name surfaces re-render. */
  static async renameById(id: string, name: string): Promise<void> {
    const info = new ActionInfo('rename', AgenticProcess.type, id, 'POST');
    info.bodyParameters = { name };
    await dataManager.callAction<{ name: string }, { id: string; name: string }>(info);
  }

  /**
   * Headless transport (`pty_mode === false`): the chat streams over
   * flowDataStream and the process legitimately has NO shell/xterm — a null
   * `shell_id` is its normal state, not a failure. The single place views
   * key "is a shell-less process renderable?" off, so the transport rule
   * can't drift between the panel gate, InteractiveTerminal, and the plan-
   * mode toggle.
   */
  get isHeadless(): boolean {
    return this.pty_mode === false;
  }

  /**
   * Live interactive terminal — `/dock/shell/agentic_process-<id>`.
   * Use this when the user wants to attach to (or launch) the running PTY.
   */
  get terminalDockPointer(): DockPointerData {
    return new DockPointerData(ViewType.SHELL, `${AgenticProcess.type}${TypeId.DELIMITER}${this.id}`);
  }

  openTerminalDock(extraOptions?: Record<string, string>): void {
    const nav = (window as any).navigation as
      | { openDock: (pointer: DockPointerData, extraOptions?: Record<string, string>) => void }
      | undefined;
    nav?.openDock(this.terminalDockPointer, extraOptions);
  }

  /**
   * Read-only transcript — `/dock/lens/<worker_type>/transcript/<session_id>`.
   *
   * Single-segment ref form. The server-side resolver
   * (``flow_sdk.transcript_analyzer.resolver``) globs the actual on-disk JSONL
   * from worker_type + session_id, so callers don't need to know any path
   * encoding. Falls back to the terminal pointer when no session is attached
   * yet (fresh process before first message).
   */
  /**
   * The lens CATEGORY this process's transcript lives under.
   *
   * Exposed because more than one surface opens that lens, and each one that
   * spelled the vendor itself spelled it as the literal `'claude'` — which
   * silently routed an opencode/codex/copilot session to claude's category and
   * resolved a different transcript. One derivation, read by all of them.
   */
  get transcriptLensCategory(): string {
    const wt = (this.worker_type ?? 'claude').toLowerCase();
    return wt === 'codex' || wt === 'copilot' || wt === 'opencode' ? wt : 'claude';
  }

  get transcriptDockPointer(): DockPointerData {
    if (!this.session_id) return this.terminalDockPointer;
    return new DockPointerData(
      ViewType.LENS,
      `${this.transcriptLensCategory}/transcript/${this.session_id}`,
    );
  }

  /**
   * Default dock pointer — the transcript for a FINISHED process, the live
   * terminal for anything still alive.
   *
   * Reading prior runs is the dominant gesture once a process has terminated,
   * but a live process has no finished transcript to read. Worse, `session_id`
   * is not proof one exists on disk: `AgenticProcess.fork` pre-allocates the
   * fork's id, and the CLI only writes `<session_id>.jsonl` on its FIRST turn —
   * so defaulting a running fork to the transcript lens sent it to a view that
   * 404s ("No claude transcript JSONL found"), while its live pane sat unopened.
   *
   * Surfaces that always mean "attach to terminal" should keep referencing
   * {@link terminalDockPointer} explicitly.
   */
  get dockPointer(): DockPointerData {
    const finished = this.status === ProcessStatus.STOPPED || this.status === ProcessStatus.FAILED;
    return finished ? this.transcriptDockPointer : this.terminalDockPointer;
  }

  /**
   * True when this process was created by resuming or forking a prior CLI
   * session (not a fresh start). Derived from the persisted ``cli_config``
   * so the answer is stable across reloads.
   *
   * The signal: ``cli_config.resume === true`` (passed when the user opened
   * an existing ``session_id``) or ``cli_config.fork_session_id`` (passed
   * when forking off a prior session). A bare ``session_id`` on the entity
   * by itself isn't enough — that field is also populated for fresh
   * processes once the CLI assigns one.
   */
  get wasRestoredFromSession(): boolean {
    const cfg = this.cli_config as { resume?: boolean; fork_session_id?: string | null } | undefined;
    if (!cfg) return false;
    return Boolean(cfg.resume === true || cfg.fork_session_id);
  }

  /**
   * Symbolic icon key for this process — the UI resolves it to a concrete
   * React component via the ``pickProcessIcon`` registry. Two axes drive
   * the choice:
   *
   * - **vendor**: ``worker_type`` ('claude' / 'codex' / 'copilot' / fallback)
   * - **state**: fresh-start vs ``wasRestoredFromSession``
   */
  get icon(): ProcessIconKey {
    const wt = (this.worker_type ?? '').toLowerCase();
    const restored = this.wasRestoredFromSession;
    if (wt === 'codex') return restored ? 'codex-restore' : 'codex';
    if (wt === 'copilot') return restored ? 'copilot-restore' : 'copilot';
    if (wt === 'opencode') return restored ? 'opencode-restore' : 'opencode';
    // Legacy rows may have no worker_type; keep their historical Claude icon.
    // New processes are stamped with the capability-resolved worker by the
    // backend createProcess action.
    if (wt === '' || wt === 'claude' || wt.startsWith('claude_') || wt.startsWith('claude-')) {
      return restored ? 'claude-restore' : 'claude';
    }
    return restored ? 'generic-restore' : 'generic';
  }

  /** @deprecated alias of {@link transcriptDockPointer} */
  get searchDockPointer(): DockPointerData {
    return this.transcriptDockPointer;
  }

  /** Instruction content being executed */
  instruction_content?: string;

  /** Source VFS path of the executed file */
  asset_ref?: string;

  /** Persisted context data for session restoration */
  context_data?: Record<string, unknown>;

  // TypeIds of entities this process is contextually about (task /
  // conversation / spec / project / …) now live on the base APIEntity as
  // ``sharedContextEntities`` (wire-bound) and ``privateContextEntities``
  // (local). The constructor populates them from the wire field
  // ``shared_context_entities``.

  /** Optional pinning index for tab ordering */
  favorite_index?: number | null;

  /** True when PTY OSC title escapes may update `name`. Cleared the first time the user manually renames this tab. */
  auto_rename: boolean = true;

  /** Backend-owned lifecycle status. */
  private _status: ProcessStatus = ProcessStatus.NEW;

  /** Backend-derived turn-in-flight boolean (``is_turn_busy``), orthogonal to status. */
  private _busy: boolean = false;

  /**
   * Granular transcript-derived worker status, `undefined` when the backend has
   * nothing to report — a worker spawned and idle at the prompt writes no
   * transcript until its first turn, so `worker_status` is null on the wire.
   * Never substitute a status here: INITIALIZING is the backend's to assert
   * (lifecycle STARTING), and inventing it strands a ready worker behind a
   * spinner nothing can clear.
   */
  private _workerStatus: WorkerStatus | undefined = undefined;

  /** Backend-owned lifecycle status. Read-only outside this class. */
  get status(): ProcessStatus {
    return this._status;
  }

  private set status(value: ProcessStatus) {
    this._status = value;
  }

  /** Turn-in-flight. Read-only outside this class. Read via ``isBusy(this)``. */
  get busy(): boolean {
    return this._busy;
  }

  private set busy(value: boolean) {
    this._busy = value;
  }

  /** Transcript-derived worker status, or undefined when the backend reports none. */
  get workerStatus(): WorkerStatus | undefined {
    return this._workerStatus;
  }

  private set workerStatus(value: WorkerStatus | undefined) {
    this._workerStatus = value;
  }

  /** Worker session ID for resume capability */
  session_id?: string | null;

  /** Whether worker manages its own history */
  use_worker_history?: boolean;

  /** False=direct PTY spawn (default), True=legacy zsh intermediary */
  shell_mode?: boolean;

  /** CLI worker vendor (e.g. 'claude', 'codex', 'copilot'). Drives icon selection. */
  worker_type?: string | null;

  /** Discriminates how this process is being used (chat vs execution). */
  process_type?: ProcessKind | null;

  /** Shell entity ID linked to this process */
  shell_id?: string | null;

  /** DEPRECATED one-release alias of base-Entity `tabbed` (kept in lock-step server-side). */
  visible?: boolean;

  /** Transport intent: true → interactive PTY (default); false → headless
   *  JSON-stream (no PTY/xterm). Durable across reload; seeds `visible` at launch. */
  pty_mode?: boolean;

  /** Backend-computed driver capability (claude only, for now). */
  supports_plan_mode?: boolean;

  /** Tab-strip membership (base-Entity field; see IEntity.tabbed). */
  tabbed?: boolean;

  /** Strip ordering among member tabs (base-Entity field; 0 = unassigned). */
  tab_order?: number;

  /** Epoch-ms of last tab activation (base-Entity field; legacy ISO tolerated). */
  last_active_at?: number | string | null;

  /** Sidecar plain shell PTY session ID */
  sidecar_shell_id?: string | null;

  /** WebSocket connection ID of the browser tab that opened this process (runtime field, not persisted) */
  connection_id?: string | null;

  /** Owning project ID */
  project_id?: string | null;

  /** CollaborationRoom this process was spawned in, if any */
  collaboration_room_id: string | null = null;

  /** VFS path the process is keyed to. Either an entity TypeId ("type-id") for entity-scoped processes, or "<typeid>/<sub_path>" for surface-scoped processes (e.g. a per-doc process keyed on the file path). */
  target_typeid_str: string | null = null;

  /**
   * True when a worker-relevant field changed since the last successful start()
   * while status==RUNNING. Maintained by the backend save-hook; UI surfaces
   * this as the "Restart" affordance on the process toolbar.
   */
  restart_required: boolean = false;

  /**
   * Reason the last worker launch failed to start (instant-exit latch).
   * Non-null excludes this process from auto-recovery; clear it via an
   * explicit user retry — `start({ retry: true })` — never automatically.
   */
  start_failure: string | null = null;

  /**
   * MD5 of the worker-relevant snapshot captured at the last successful start().
   * Compared against the current snapshot on every save() to detect drift.
   */
  last_started_hash: string | null = null;

  /** Execution folder — `<record_dir>/execution/`. Null until the process has a record on disk. */
  exe_folder: FSRef | null = null;

  /** `<exe_folder>/input/`. */
  input_folder: FSRef | null = null;

  /** `<exe_folder>/output/` — where the agent writes artifacts back. */
  output_folder: FSRef | null = null;

  /** `<exe_folder>/assets/` — materialised embedded agents / skills. */
  assets_folder: FSRef | null = null;

  /** Deserialize cli_config into a live worker-specific CLI options instance.
   *
   * Mirrors Python AgenticProcess.cli_options property exactly:
   * workdir and session_id are injected from entity fields (not stored in cli_config).
   */
  get cliOptions(): ClaudeAgentOptions {
    const workerType = (this.worker_type ?? this.cli_config?.worker_type ?? 'claude') as string;
    const cmd = cliOptionsFactory(this.cli_config ?? {}, workerType) as ClaudeAgentOptions;
    if (this.session_id) cmd.session_id = this.session_id;
    const wd = this.workdir;
    if (wd) {
      cmd.workdir = wd;
      if (cmd instanceof ClaudeAgentOptions) {
        cmd.envVars['CLAUDE_PROJECT_DIR'] ??= wd;
      }
    }
    if ('addDirs' in cmd) cmd.addDirs = this.additional_dirs ?? [];
    return cmd;
  }

  set cliOptions(cmd: ClaudeAgentOptions) {
    this.cli_config = cmd.toJson();
  }

  /** The launch bundle — prompt, model, skills, dirs, permissions. Preferred
   *  spelling; `cliOptions` stays as the alias the driver layer is named after. */
  get agentOptions(): ClaudeAgentOptions {
    return this.cliOptions;
  }

  set agentOptions(cmd: ClaudeAgentOptions) {
    this.cliOptions = cmd;
  }

  /** Enable the Flowpad Assistant mount for this process — its
   *  `.claude/skills` + agents become discoverable via `--add-dir`.
   *
   *  Sets the per-process `load_flowpad_assistant` flag, notifies local
   *  subscribers via an entity event, then persists. The backend driver reads
   *  the flag via `assistant_enabled` (falling back to the global default) when
   *  building the worker command; because the flag changes the resolved
   *  `--add-dir` set, the backend `save()` hook recomputes `restart_required`
   *  naturally and reflects both the flag and `restart_required` back to the
   *  frontend "as is" (no special-casing). */
  async enableAssistant(): Promise<this> {
    return this.setAssistantEnabled(true);
  }

  /** Set the per-process Flowpad Assistant mount flag explicitly (true/false)
   *  and persist. Backs the header toggle chip in the asset manager.
   *
   *  Like {@link enableAssistant}, this only flips `load_flowpad_assistant` and
   *  saves — because the flag changes the resolved `--add-dir` set, the backend
   *  `save()` hook recomputes `restart_required` on its own and reflects both
   *  the flag and the restart-required state back to the frontend as-is. */
  async setAssistantEnabled(enabled: boolean): Promise<this> {
    this.load_flowpad_assistant = enabled;
    // Optimistic local notify so subscribers can react before the round-trip.
    this.onEntityEvent(enabled ? 'assistant.enabled' : 'assistant.disabled', {
      load_flowpad_assistant: enabled,
    });
    await this.save();
    return this;
  }

  /** Append a directory to additional_dirs (passed to Claude via --add-dir). */
  async addDir(path: string): Promise<void> {
    const actionInfo = new ActionInfo('add-dir', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { path };
    await dataManager.callAction(actionInfo);
    if (!(this.additional_dirs ?? []).includes(path)) {
      this.additional_dirs = [...(this.additional_dirs ?? []), path];
    }
  }

  /**
   * Bind a captured `GraphContext` (by id) to this process BEFORE launch — the
   * backend `set-graph-context` action. Folds the context summary into the
   * worker's system prompt at launch (see contextProcess.md). Pre-launch only.
   */
  async setGraphContext(graphContextId: string): Promise<void> {
    const actionInfo = new ActionInfo('set-graph-context', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { graph_context_id: graphContextId };
    await dataManager.callAction(actionInfo);
  }

  /**
   * Declare a display-focus target for this process's watchers — the backend
   * `show` action (same channel as the worker-side `flow show` CLI). The
   * resolved payload comes back to subscribers via {@link onShow}.
   */
  async show(target: { typeid?: string; path?: string; port?: number; view?: string }): Promise<void> {
    const actionInfo = new ActionInfo('show', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = target;
    await dataManager.callAction(actionInfo);
  }

  /** Remove a directory from additional_dirs. No-op if not present. */
  async removeDir(path: string): Promise<void> {
    const actionInfo = new ActionInfo('remove-dir', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { path };
    await dataManager.callAction(actionInfo);
    this.additional_dirs = (this.additional_dirs ?? []).filter((d) => d !== path);
  }

  // ── Prompt queue (backend-owned; these are thin action wrappers) ───────────
  // The backend writes the queue file, runs the drain, and pushes the new
  // `queue` state back via `data_op`. These methods never mutate `this.queue`
  // locally — the reflection round-trip is the single source of truth.

  /** Append a prompt to the tail of the queue. */
  async enqueue(prompt: string, source: string = 'ui'): Promise<void> {
    const actionInfo = new ActionInfo('enqueue', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { prompt, source };
    await dataManager.callAction(actionInfo);
  }

  /** Remove a queued prompt by its id (string) or list index (number). */
  async dequeue(idOrIndex: string | number): Promise<void> {
    const actionInfo = new ActionInfo('dequeue', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = typeof idOrIndex === 'number' ? { index: idOrIndex } : { id: idOrIndex };
    await dataManager.callAction(actionInfo);
  }

  /** Drop every pending prompt. */
  async clearQueue(): Promise<void> {
    const actionInfo = new ActionInfo('clear-queue', AgenticProcess.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);
  }

  /** Enable/disable draining. Disabled keeps entries but stops injection. */
  async setQueueEnabled(enabled: boolean): Promise<void> {
    const actionInfo = new ActionInfo('set-queue-enabled', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { enabled };
    await dataManager.callAction(actionInfo);
  }

  // ── Pin-from-history (docs/prompt-library.md) ───────────────────────────────
  // Pin = create/reuse a library Prompt from a history item's text; the
  // backend mutually cross-links the Prompt and this process into each
  // other's PRIVATE context entities. Unpin = remove link + delete the
  // prompt from the library. Private context is backend-mutated only.

  /** Pin a history item's text into the prompt library. Idempotent by normalized text. */
  async pinPrompt(text: string, name?: string): Promise<{ promptId: string }> {
    const actionInfo = new ActionInfo('pin-prompt', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { text, ...(name ? { name } : {}) };
    const result = await dataManager.callAction<
      { text: string; name?: string },
      { prompt_id: string; pinned: boolean }
    >(actionInfo);
    return { promptId: result.prompt_id };
  }

  /** Unpin: remove the prompt↔process link and delete the prompt from the library. */
  async unpinPrompt(promptId: string): Promise<void> {
    const actionInfo = new ActionInfo('unpin-prompt', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { prompt_id: promptId };
    await dataManager.callAction(actionInfo);
  }

  /** Record that this process executed a library prompt: mutual private
   *  cross-link + usage bump (conversation Approve & Execute path). */
  async linkExecutedPrompt(promptId: string): Promise<void> {
    const actionInfo = new ActionInfo('link-executed-prompt', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { prompt_id: promptId };
    await dataManager.callAction(actionInfo);
  }

  async shell(): Promise<Shell | null> {
    if (!this.shell_id) return null;
    const w = (typeof window !== 'undefined' ? window : undefined) as { __shellNavT0?: number } | undefined;
    const t0 = w?.__shellNavT0;
    const stamp = (label: string, start: number) => {
      if (t0 === undefined) return;
      const now = performance.now();
      // eslint-disable-next-line no-console
      console.log(`[PERF] +${(now - t0).toFixed(0)}ms ${label} took ${(now - start).toFixed(1)}ms`);
    };
    const sGet = performance.now();
    const result = await Shell.getById<Shell>(this.shell_id);
    stamp('process.shell: Shell.getById', sGet);
    return result;
  }

  /** The PTY connection for this process — delegates to the linked Shell. */
  get ptyConnection(): import('../services/shell/ptyConnection').PtyConnection | undefined {
    if (!this.shell_id) return undefined;
    const entity = dataManager.getByTypeIdFromCache(new TypeId('shell', this.shell_id)) as any;
    return entity?.ptyConnection;
  }

  async printPty(): Promise<void> {
    const sh = await this.shell();
    sh?.printPty();
  }

  // ── Line / trigger event surface ──────────────────────────────────────────

  /** Track the bridges we've registered against the shell so we don't double-bridge. */
  private _shellLineBridgeUnsub?: () => void;
  private _activePlanTriggerUnsub?: () => void;

  /**
   * Bridge line events from the attached Shell into this process so callers
   * can use ``process.on('line', fn)`` interchangeably with ``shell.onLine(fn)``.
   * Idempotent — re-bridging cleans up the previous link.
   */
  private async _ensureShellLineBridge(): Promise<void> {
    const sh = await this.shell();
    if (!sh) return;
    this._shellLineBridgeUnsub?.();
    this._shellLineBridgeUnsub = sh.onLine((line) => {
      this.emit('line', line);
    });
  }

  /**
   * Subscribe to ANSI-stripped output rows (LF-delimited lines and bare-CR
   * terminal redraw rows). Wires up the shell bridge on first use so
   * ``process.on('line', ...)`` works even before the shell is fully attached.
   * Returns an unsubscribe function.
   */
  onLine(handler: (line: string) => void): () => void {
    void this._ensureShellLineBridge();
    return this.on('line', handler);
  }

  /**
   * Subscribe to plan-detection events.
   *
   * Refresh-driven via ``process.on('status', ...)`` plus a one-time check
   * at registration. Runs ``getPlan()`` server-side whenever the process
   * is in the ``RUNNING`` state — server scans the JSONL transcript for
   * ``ExitPlanMode.planFilePath`` and persists ``plan_path`` on the entity.
   *
   * - With ``validate: false`` (default), ``handler`` is called with the
   *   resolved ``plan_path`` string (or ``null``).
   * - With ``validate: true``, ``handler`` receives the resolved
   *   ``Markdown`` entity (or ``null`` if no plan exists yet).
   *
   * NOTE: ``process.status`` does not transition mid-session, so during a
   * live Claude session the handler only fires on initial registration
   * (and on any later status transitions, e.g. process restart). To pick
   * up plans created during a session, the consumer must re-mount /
   * re-subscribe (page refresh handles this naturally).
   *
   * Returns an unsubscribe function.
   */
  onPlan<T = string | null>(options: { validate?: boolean }, handler: (payload: T) => void): () => void {
    const validate = options.validate ?? false;

    const check = async (): Promise<void> => {
      if (!isProcessRunning(this.status)) return;
      const md = await this.getPlan();
      if (validate) {
        handler(md as unknown as T);
      } else {
        handler((this.plan_path ?? null) as unknown as T);
      }
    };

    const unsubStatus = this.on('status', () => {
      void check();
    });
    void check();

    return () => unsubStatus();
  }

  /**
   * Fetch the plan as a Markdown entity.
   *
   * Calls the ``transcript/plan`` sub-action — the server resolves the
   * plan file path (existence-gated), persists ``plan_path``, indexes the
   * file as a Markdown record, and returns it. Returns ``null`` if no
   * plan has been produced yet.
   */
  async getPlan(): Promise<import('../entities/markdown.js').Markdown | null> {
    const actionInfo = new ActionInfo('transcript', AgenticProcess.type, this.id, 'POST');
    actionInfo.subpath = 'plan';
    const response = await dataManager.callAction<
      unknown,
      { markdown?: Record<string, unknown> | null; plan_path?: string | null }
    >(actionInfo);
    if (response?.plan_path !== undefined) this.plan_path = response.plan_path ?? null;
    if (!response?.markdown) return null;
    return dataManager.updateEntityFromJson<import('../entities/markdown').Markdown>(
      response.markdown as Record<string, unknown>,
    );
  }

  /**
   * Fetch the canonical user-prompt list from the JSONL transcript.
   *
   * Calls ``transcript/prompts`` — the server walks the parsed transcript
   * and returns ``UserMessageEntry``-shaped dicts. Filters: drop sub-agent
   * (``is_sidechain``) lines, drop empty/whitespace text, drop the
   * ``[Request interrupted by user for tool use]`` synthetic. Hydrates
   * each entry via the analyzer's ``fromJson`` factory.
   */
  async getPrompts(): Promise<import('../transcript-analyzer').UserMessageEntry[]> {
    const { fromJson, UserMessageEntry } = await import('../transcript-analyzer');
    const actionInfo = new ActionInfo('transcript', AgenticProcess.type, this.id, 'POST');
    actionInfo.subpath = 'prompts';
    const response = await dataManager.callAction<unknown, { prompts?: Record<string, unknown>[] | null }>(actionInfo);
    const raw = response?.prompts ?? [];
    const out: import('../transcript-analyzer').UserMessageEntry[] = [];
    for (const r of raw) {
      const entry = fromJson(r);
      if (entry instanceof UserMessageEntry) out.push(entry);
    }
    return out;
  }

  /** Fetch deterministic extractive context for continuing with another worker. */
  async continuationPrompt(): Promise<string> {
    const actionInfo = new ActionInfo('continuation-prompt', AgenticProcess.type, this.id, 'GET');
    const response = await dataManager.callAction<unknown, { prompt: string }>(actionInfo);
    return response.prompt;
  }

  /**
   * Fetch the parsed worker transcript from the process-specific transcript source.
   */
  async getTranscript(): Promise<import('../transcript-analyzer').AgentTranscript> {
    const { AgentTranscript, TranscriptFormat, TranscriptSource, fromJson } = await import('../transcript-analyzer');
    const actionInfo = new ActionInfo('transcript', AgenticProcess.type, this.id, 'POST');
    actionInfo.subpath = 'full';
    const response = await dataManager.callAction<
      unknown,
      {
        worker_type?: string | null;
        session_id?: string | null;
        path?: string | null;
        transcript_path?: string | null;
        transcript_format?: string | null;
        transcript_source?: string | null;
        entries?: Record<string, unknown>[] | null;
      }
    >(actionInfo);
    const rawEntries = response?.entries ?? [];
    const entries = rawEntries.map((entry) => fromJson(entry));
    const format = Object.values(TranscriptFormat).includes(response?.transcript_format as never)
      ? (response?.transcript_format as TranscriptFormatType)
      : null;
    const source = Object.values(TranscriptSource).includes(response?.transcript_source as never)
      ? (response?.transcript_source as TranscriptSourceType)
      : null;
    const path = response?.path ?? response?.transcript_path ?? '';
    return new AgentTranscript(
      response?.worker_type ?? this.worker_type ?? '',
      entries,
      response?.session_id ?? this.session_id ?? '',
      {
        path,
        transcript_format: format,
        transcript_source: source,
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────

  /** Internal references (not serialized) */
  _context?: AgenticContext;

  /** Last error observed when ``workerStatus`` transitioned to a failure
   *  state. Set by ``_handleError``; never set autonomously by the SDK. */
  private _error: Error | null = null;

  /**
   * Client-side settlement of the current turn. ``pending`` masks a terminal
   * raw status left over from the previous turn until the backend-owned
   * ``busy`` edge closes the new one. ``complete`` / ``error`` also let a
   * headless crash settle consumers when the provider transcript never writes
   * a terminal record and therefore leaves ``workerStatus`` stale.
   */
  private _turnOutcome: 'pending' | 'complete' | 'error' | null = null;

  /** Per-turn terminal frame observed on the headless FlowData stream. */
  private _observedTurnEnd: 'complete' | 'error' | null = null;
  private _observedTurnError: Error | null = null;

  /**
   * True once this client has seen ANY FlowData frame for the current headless
   * turn — i.e. it is streaming the turn and its END frame is still expected.
   * Distinguishes a streaming client (wait for END; never settle a pending turn
   * from a possibly-stale raw worker_status) from a passive client that only
   * watches entity busy edges (no stream, so it must settle from worker_status
   * on busy:false or it hangs). Reset per turn by ``beginTurn``.
   */
  private _observedTurnFrame: boolean = false;

  /** History loading state */
  private _historyLoaded: boolean = false;
  private _historyLoading: Promise<void> | null = null;

  /** Artifact list state — see the `artifacts` getter / `loadArtifacts`. */
  private _artifacts: Artifact[] = [];
  private _artifactsLoaded: boolean = false;
  private _artifactsLoading: Promise<Artifact[]> | null = null;
  /** Ids deleted while an artifact snapshot is in flight, so that stale
   *  snapshot cannot resurrect the row. Cleared when that request settles. */
  private _deletedArtifactIds = new Set<string>();

  /**
   * True after the user explicitly stopped this process (``stop`` /
   * ``exit`` / ``close``) and before the next successful ``start``. Gates
   * the auto-recovery dispatcher so a deliberately stopped process is not
   * silently relaunched.
   */
  private _userInitiatedStop: boolean = false;

  /**
   * Desired-value latch for the transport/visibility fields the client sets
   * optimistically (`switchMode`/`setVisible`). The backend is the authoritative
   * writer of `pty_mode`/`visible`, but an in-flight entity broadcast can carry
   * the PRE-switch value and (via `deepAssign`) clobber the optimistic one — and
   * such a stale broadcast can arrive even AFTER an agreeing one. So once set,
   * `onEntityUpdate` HOLDS the latch (stripping any disagreeing wire value) until
   * the NEXT `switchMode`/`setVisible` overwrites it — these are the only ways
   * `pty_mode`/`visible` change, so a disagreeing wire value is always stale.
   * `undefined` (whole object or a member) = no switch yet on this client for
   * that field, trust the wire. ONE object, written ONLY through
   * {@link stageTransportIntent}, so an optimistic switch and its failure
   * rollback always move the durable fields and their latches together.
   */
  private _pendingTransport?: { pty_mode?: boolean; visible?: boolean };

  /**
   * Single writer for the optimistic transport intent: atomically sets the
   * durable fields (`pty_mode`/`visible`, only those present in `intent`) AND
   * their stale-wire latch, and returns a restore function that atomically
   * puts BOTH back to the pre-stage state. Callers whose backend action fails
   * invoke the restore so the entity never stays pinned to a transport that
   * was never started (and later authoritative broadcasts aren't discarded).
   */
  private stageTransportIntent(intent: { pty_mode?: boolean; visible?: boolean }): () => void {
    const priorLatch = this._pendingTransport;
    const priorPtyMode = this.pty_mode;
    const priorVisible = this.visible;
    this._pendingTransport = { ...priorLatch, ...intent };
    if (intent.pty_mode !== undefined) this.pty_mode = intent.pty_mode;
    if (intent.visible !== undefined) this.visible = intent.visible;
    return () => {
      this._pendingTransport = priorLatch;
      this.pty_mode = priorPtyMode;
      this.visible = priorVisible;
    };
  }

  /**
   * Count of in-flight streaming `prompt()` calls. A definitive, delivery-
   * agnostic "a turn is running" signal for the chat: it brackets the actual
   * request lifecycle, so it's reliable even when the transcript arrives in a
   * post-hoc WS batch (where deriving status from stream deltas would miss the
   * in-flight window). Emits `'prompting-change'` on every transition.
   */
  private _promptingCount = 0;

  /** True while at least one streaming `prompt()` is in flight (turn running). */
  get isPrompting(): boolean {
    return this._promptingCount > 0;
  }

  private _setPromptingDelta(delta: number): void {
    this._promptingCount = Math.max(0, this._promptingCount + delta);
    this.emit('prompting-change', this.isPrompting);
  }

  constructor(entity: Partial<IAgenticProcess> = {}) {
    super(entity);
    this.instruction_content = entity.instruction_content;
    this.asset_ref = entity.asset_ref;
    this.context = entity.context;
    this.context_data = entity.context_data;
    this.favorite_index = entity.favorite_index;
    this.status = (entity.status as ProcessStatus) ?? ProcessStatus.NEW;
    this.busy = entity.busy ?? false;
    this.workerStatus = entity.worker_status ?? undefined;
    this.session_id = entity.session_id;
    this.use_worker_history = entity.use_worker_history;
    this.shell_mode = entity.shell_mode;
    this.worker_type = entity.worker_type ?? null;
    this.process_type = entity.process_type ?? null;
    this.shell_id = entity.shell_id;
    this.visible = entity.visible;
    // Default true so an entity that predates the field (or any caller that
    // doesn't set it) behaves exactly as today (PTY). Only an explicit `false`
    // selects headless.
    this.pty_mode = entity.pty_mode ?? true;
    this.supports_plan_mode = entity.supports_plan_mode ?? false;
    this.tabbed = entity.tabbed ?? entity.visible ?? false;
    this.tab_order = entity.tab_order ?? 0;
    this.last_active_at = entity.last_active_at ?? null;
    this.sidecar_shell_id = entity.sidecar_shell_id;
    this.connection_id = entity.connection_id;
    this.auto_rename = entity.auto_rename ?? true;
    this.project_id = entity.project_id ?? null;
    this.collaboration_room_id = entity.collaboration_room_id ?? null;
    this.target_typeid_str = entity.target_typeid_str ?? null;
    this.exe_folder = entity.exe_folder ? FSRef.fromJson(entity.exe_folder) : null;
    this.input_folder = entity.input_folder ? FSRef.fromJson(entity.input_folder) : null;
    this.output_folder = entity.output_folder ? FSRef.fromJson(entity.output_folder) : null;
    this.assets_folder = entity.assets_folder ? FSRef.fromJson(entity.assets_folder) : null;
    this.plan_path = entity.plan_path ?? null;
    this.markdown_docs = entity.markdown_docs ?? [];
    // Persisted snapshot mirror — only overwrite when the field is present so a
    // partial `data_op` (which omits it) doesn't wipe the live-pushed value.
    if ('status_report' in entity) {
      this.statusReport = parseStatusReport(entity.status_report) ?? null;
    }
    this.queue = entity.queue ?? null;
  }

  // NOTE: project_id projection moved server-side. The base Python
  // ``Entity.get_implicit_private_context_entities`` projects project_id
  // for every entity with one; AgenticProcess inherits the projection
  // automatically. FE displays the merged ``private_context_entities``
  // from the wire as-is.

  // ── Field declarations (populated by constructor / wire data) ──────────────

  plan_path: string | null = null;

  /**
   * User-facing markdown docs authored by this process, oldest-first. Tail is
   * the latest doc shown by the ribbon's docs chip; the chevron/popover lists
   * the rest when there is more than one. Backend-owned (persisted field).
   */
  markdown_docs: MarkdownDoc[] = [];

  /**
   * Latest agent-progress snapshot (counters + focused asset + statuses).
   * Backend-owned projection: mirrored from the persisted `status_report` field
   * on reload and refreshed live by `handleFlowData` when a `progress_report`
   * envelope arrives. Null until the first report. Read by the counters
   * one-liner and the focused-asset chip; never written from the frontend.
   */
  statusReport: ProcessStatusReport | null = null;

  /**
   * Reflected prompt-queue state (backend-owned). Populated by `deepAssign`
   * off the wire and refreshed on every `data_op`; the panel reads this and
   * mutates exclusively through the queue action methods below.
   */
  queue: QueueState | null = null;

  /**
   * Get the workdir as a VFSPath if available.
   * Resolves plain machine paths against the current compute-node context.
   */
  get workDirVfs(): VFSPath | null {
    const contextWorkdir = this.workdir;
    if (!contextWorkdir) {
      return null;
    }

    // If it already looks like a VFS path, parse directly.
    if (contextWorkdir.includes(':/') || contextWorkdir.includes('-@') || contextWorkdir.startsWith('vfs://')) {
      return VFSPath.parse(contextWorkdir);
    }

    const computeNodeTypeId = dataContext.computeNode?.typeId;
    if (!computeNodeTypeId) {
      return VFSPath.parse(contextWorkdir);
    }

    try {
      return VFSPath.fromMachinePath(contextWorkdir, computeNodeTypeId);
    } catch {
      return VFSPath.parse(contextWorkdir);
    }
  }

  get shellEntity(): Shell | null {
    if (!this.shell_id) return null;
    return dataManager.getByTypeIdFromCache<Shell>(new TypeId(Shell.type, this.shell_id));
  }

  get compute_node_id(): string | null {
    return this.shellEntity?.compute_node_id ?? null;
  }

  get compute_node_uname(): string | null {
    return this.shellEntity?.compute_node_uname ?? null;
  }

  /**
   * Get the current stack frame (top-level variables).
   * This is a convenience accessor mirroring Python's state.stackFrame.
   */
  get stackFrame(): Record<string, unknown> {
    return {};
  }

  /**
   * Whether this process has reached logical turn completion.
   *
   * ``workerStatus`` is the raw transcript projection, so it may become
   * terminal while the headless driver is still flushing its final FlowData.
   * The backend-owned ``busy`` projection is the turn-lifecycle authority:
   * only terminal + idle means consumers may close their output stream.
   */
  get completed(): boolean {
    if (this.busy || this._turnOutcome === 'pending') return false;
    return (
      this._turnOutcome === 'complete' ||
      this._turnOutcome === 'error' ||
      this.status === ProcessStatus.FAILED ||
      isWorkerTerminal(this.workerStatus)
    );
  }

  /**
   * Error if execution failed, null otherwise.
   */
  get error(): Error | null {
    return this._error;
  }

  /** Resolve an already-settled failure even when no live error event was seen. */
  private completionError(): Error | null {
    if (this._error) return this._error;
    if (this.status === ProcessStatus.FAILED) return new Error('Process failed');
    switch (this.workerStatus) {
      case WorkerStatus.ERROR:
        return new Error('Process error');
      case WorkerStatus.INTERRUPTED:
        return new Error('Process was terminated');
      case WorkerStatus.INACTIVE:
        return new Error('Process became inactive before completing');
      case WorkerStatus.API_TIMEOUT:
        return new Error('Process timed out');
      default:
        return null;
    }
  }

  /** Start a headless turn without trusting a terminal status from its predecessor. */
  private beginTurn(): void {
    this._turnOutcome = 'pending';
    this._observedTurnEnd = null;
    this._observedTurnError = null;
    this._observedTurnFrame = false;
    this._error = null;
  }

  /**
   * Observe the current print-mode turn's own stream terminator. Unlike the raw
   * transcript projection, END belongs to this exact worker invocation, so an
   * inherited COMPLETE from a resumed/forked session cannot settle the new turn.
   */
  private observeHeadlessTurnFrame(flowData: FlowData): void {
    if (this.pty_mode) return;

    // A separately hydrated watcher may miss/coalesce the busy-start entity
    // edge. Its first live worker frame still establishes a new turn locally.
    if (this._turnOutcome === null) this.beginTurn();
    if (this._turnOutcome !== 'pending') return;
    // A frame for the pending turn means this client is streaming it — its END
    // frame is the authoritative terminator, so the busy:false edge must not
    // settle it from a raw worker_status before that END arrives.
    this._observedTurnFrame = true;

    if (flowData.elementType === FlowElementTypes.ERROR) {
      this._observedTurnError = new Error(String(flowData.content || 'Headless process error'));
    } else if (
      flowData.elementType === FlowElementTypes.STATUS &&
      flowData.attributes?.subtype === 'exit-error'
    ) {
      this._observedTurnError = new Error(String(flowData.content || 'Headless process exited with an error'));
    } else if (
      flowData.elementType === FlowElementTypes.RESULT &&
      flowData.attributes?.outcome === 'error'
    ) {
      this._observedTurnError = new Error('Headless process reported an error result');
    }

    if (flowData.elementType === FlowElementTypes.END) {
      this._observedTurnEnd = this._observedTurnError ? 'error' : 'complete';
      this.settleObservedHeadlessTurn();
    }
  }

  /** Finalize only after both this turn's END frame and backend idle are visible. */
  private settleObservedHeadlessTurn(): void {
    if (this.busy || this._turnOutcome !== 'pending' || this._observedTurnEnd === null) return;
    if (this._observedTurnEnd === 'error') {
      this._handleError(this._observedTurnError ?? new Error('Headless process ended with an error'));
    } else {
      this._handleComplete();
    }
  }

  /**
   * Async iterator for streaming FlowData outputs.
   *
   * Yields FlowData as they arrive from the backend.
   * First yields any already-collected outputs, then waits for new ones.
   *
   * Mirrors Python's `async for data in process.output()` pattern.
   *
   * @example
   * ```typescript
   * for await (const flowData of process.output()) {
   *   console.log(`[${flowData.elementType}]`, flowData.data);
   * }
   * ```
  */
  async *output(): AsyncGenerator<FlowData, void, unknown> {
    // Subscribe before yielding the existing snapshot. Every yield returns
    // control to the event loop; subscribing afterwards would lose frames that
    // arrive while the consumer is processing those existing items.
    const queue: FlowData[] = [];
    let resolver: ((v: FlowData | null) => void) | null = null;
    let completed = this.completed;

    const dataHandler = (data: FlowData) => {
      if (resolver) {
        resolver(data);
        resolver = null;
      } else {
        queue.push(data);
      }
    };

    const completeHandler = () => {
      completed = true;
      if (resolver) {
        resolver(null);
        resolver = null;
      }
    };

    const errorHandler = () => {
      completed = true;
      if (resolver) {
        resolver(null);
        resolver = null;
      }
    };

    const unsubData = this.on('flow_data', dataHandler);
    const unsubComplete = this.on('complete', completeHandler);
    const unsubError = this.on('error', errorHandler);
    // No async boundary exists between listener registration and this copy, so
    // a live frame belongs either to the snapshot or the queue, never both.
    const existing = [...this.flowDataStream.items];

    try {
      for (const data of existing) {
        yield data;
      }

      while (true) {
        // Drain every frame that arrived before the terminal edge. A backend
        // can emit the final CHAT/RESULT burst and COMPLETE back-to-back; the
        // generator may still be paused at its previous yield while those
        // frames queue. Checking `completed` before the queue would silently
        // discard that terminal burst.
        const queued = queue.shift();
        if (queued !== undefined) {
          yield queued;
          continue;
        }

        if (completed) {
          break;
        }

        // Wait for next event
        const data = await new Promise<FlowData | null>((r) => {
          resolver = r;
        });

        if (data === null) {
          // A terminal event and a final frame can be dispatched back-to-back.
          // Loop once more so the queue is drained before observing completion.
          continue;
        }
        yield data;
      }
    } finally {
      unsubData();
      unsubComplete();
      unsubError();
    }
  }

  /**
   * Get all collected FlowData outputs.
   * Uses the inherited flowDataStream from APIEntity.
   */
  getOutputs(): readonly FlowData[] {
    return this.flowDataStream.items;
  }

  /**
   * Optimistically append a user message to the flow stream.
   * This avoids missing USER_MESSAGE when emitted before watchers connect.
   */
  appendUserMessage(content: string): void {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    // Guard against double-submitting the SAME text — but only against a live
    // placeholder, never against a persisted row: matching history too would
    // silently swallow a message the user deliberately sends twice ("hi", then
    // "hi" again), leaving nothing on screen until the next replay.
    if (this.flowDataStream.ownItems.some((item) => item.isOptimisticEcho && item.content === trimmed)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const userFlowData = FlowDataFactory.fromElementType(
      FlowElementTypes.USER_MESSAGE,
      trimmed,
      {
        role: 'user',
        t: timestamp,
        // A placeholder, not an observation — see `FlowData.isOptimisticEcho`.
        [FlowDataAttribute.OPTIMISTIC_ECHO]: 'true',
      },
      true,
    );
    userFlowData.markReady();
    this.flowDataStream.ingest(userFlowData);
  }

  async reportEvent(
    name: AgenticProcessEventName,
    data: Record<string, unknown> = {},
  ): Promise<AgenticProcessReportEventResult> {
    const actionInfo = new ActionInfo('report_event', AgenticProcess.type, this.id, 'GET');
    actionInfo.subpath = name;
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    actionInfo.queryParameters = {
      data: JSON.stringify(data),
      request_id: requestId,
    };
    return dataManager.callAction<void, AgenticProcessReportEventResult>(actionInfo);
  }

  /**
   * Load history from backend and populate the flowDataStream.
   *
   * This is called after reconnecting to a process to restore the
   * FlowData stream with historical data. Safe to call multiple times -
   * will only load once.
   *
   * @returns Promise that resolves when history is loaded
   */
  async loadHistory(options: { force?: boolean; onlyUserMessages?: boolean } = {}): Promise<void> {
    const { force = false, onlyUserMessages = false } = options;

    // Prevent duplicate loading unless forced
    if (this._historyLoaded && !force) {
      return;
    }

    // Return existing promise if already loading
    if (this._historyLoading) {
      return this._historyLoading;
    }

    this._historyLoading = (async () => {
      try {
        const actionInfo = new ActionInfo('get-history', AgenticProcess.type, this.id, 'GET');
        const response = await dataManager.callAction<void, HistoryResponse>(actionInfo);

        if (!response || !response.history) {
          return;
        }

        // A forced reload REPLACES the stream with the on-disk transcript (not
        // append): clear here so the dedup below starts from empty and re-ingests
        // the authoritative history. Callers therefore never need a separate
        // `flowDataStream.clear()` before `loadHistory({ force: true })` — clearing
        // without also forcing would leave `_historyLoaded` set and no-op the load,
        // a footgun this removes. Cleared only after a successful fetch so an error
        // doesn't flash the view empty.
        if (force) this.flowDataStream.clear();

        // Update session info
        this.session_id = response.session_id;
        this.use_worker_history = response.use_worker_history;

        // Convert history items to FlowData and append to stream
        const historyItems: FlowData[] = [];
        for (const item of response.history) {
          const flowData = FlowData.fromJSON({
            flow_value: item.flow_value,
            attributes: item.attributes,
            index: item.index,
            created_time: item.created_time,
            process_entry: item.process_entry,
          });
          if (onlyUserMessages) {
            const isUserMessage = flowData.elementType === 'user-message' || flowData.attributes.role === 'user';
            if (!isUserMessage) {
              continue;
            }
          }
          // Mark as ready (historical items are complete) and tag as History
          // so downstream stream consumers can distinguish replayed events from
          // live stream deltas.
          flowData.markReady();
          flowData.source = FlowDataSource.History;
          historyItems.push(flowData);
        }

        // History rows are already complete records. Reconcile one-for-one with
        // any live observations, then append directly so repeated turns and
        // adjacent CHAT/REASONING rows are not deduped or chunk-consolidated.
        //
        // Force-path concurrency contract: clear() above through append()
        // below run in ONE synchronous block after the fetch resolved — no
        // await separates them, so a live frame can never land between clear
        // and append. Frames that streamed in DURING the fetch are replaced
        // by their transcript counterparts (history is authoritative); a frame
        // not yet persisted to the transcript would be dropped, which is why
        // callers only force-reload when no turn is in flight (post-switchMode
        // reconcile behind the isReadyForInput toggle gate; the chat pane's
        // useTurnCompletionReconcile on the busy→ready edge).
        // History is AUTHORITATIVE for user messages, so retire the echo of a
        // message it now carries rather than trying to reconcile it (the echo
        // is stamped at submit with a client clock and no transcript id, so it
        // matches neither tier). Paired by content: an echo minted WHILE this
        // fetch was in flight has no counterpart in the payload and must
        // survive, or the message the user just sent vanishes from the pane.
        const persistedUserMessages = new Set(
          historyItems.filter((item) => item.elementType === FlowElementTypes.USER_MESSAGE).map((item) => item.content),
        );
        if (persistedUserMessages.size > 0) {
          this.flowDataStream.retract((item) => item.isOptimisticEcho && persistedUserMessages.has(item.content));
        }
        const newItems = force ? historyItems : reconcileHistoryOverlap(historyItems, this.flowDataStream.items);
        if (newItems.length > 0) this.flowDataStream.append(newItems);
        // Close any open groups after loading history
        this.flowDataStream.closeOpenGroups();

        // History replay can reveal that the worker already reached a
        // terminal state by the time we mounted. Fire the matching
        // handler so consumers waiting on the ``complete`` / ``error``
        // event resolve instead of hanging.
        if (this.completed && this._turnOutcome === null) {
          const error = this.completionError();
          if (error) this._handleError(error);
          else this._handleComplete();
        }

        console.log(`[AgenticProcess] Loaded ${historyItems.length} history items for process ${this.id}`);
        this._historyLoaded = true;
      } catch (error) {
        console.error(`[AgenticProcess] Failed to load history for process ${this.id}:`, error);
        // Don't throw - history loading failure shouldn't break the app
      } finally {
        this._historyLoading = null;
      }
    })();

    return this._historyLoading;
  }

  /**
   * Whether history has been loaded from backend.
   */
  get historyLoaded(): boolean {
    return this._historyLoaded;
  }

  /**
   * Resolve once the process is READY for the next turn/submit — the canonical
   * "can I send now" gate, so callers never hand-roll status/mode checks. Keyed
   * on the LIVE transport (headless: idle/stopped; live PTY: RUNNING + awaiting),
   * reading the watch-updated `status`/`workerStatus`. Requires a live (watched)
   * process; throws if not ready within `timeout`.
   *
   * @example
   *   await ap.switchMode(WorkerMode.Interactive);
   *   await ap.waitForReady();     // PTY resumed + at its prompt
   *   await ap.submit('do the thing');
   */
  async waitForReady(options: { timeout?: number; interval?: number } = {}): Promise<void> {
    const { timeout = 60_000, interval = 300 } = options;
    // Transport-aware readiness:
    //  - live PTY: the wire status is READY (live and no turn in flight — the
    //    same `isReadyForInput` gate the UI toggle uses, so it can't 409). READY
    //    also ignores the STALE pre-switch BUSY/terminal state right after
    //    switchMode — the resume hasn't booted yet.
    //  - headless: no persistent worker, so a submit always enqueues / boots a
    //    per-turn worker — it's always ready to accept the next turn.
    const ready = () => !this.pty_mode || isReadyForInput(this);
    const deadline = Date.now() + timeout;
    for (;;) {
      if (ready()) return;
      if (Date.now() > deadline) {
        throw new Error(
          `waitForReady: not ready within ${timeout}ms ` +
            `(status=${this.status} worker=${this.workerStatus} pty=${this.pty_mode})`,
        );
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /**
   * Wait for process completion (complete or error event).
   *
   * @returns Promise that resolves when execution completes
   * @throws Error if execution fails
   */
  async waitForComplete(): Promise<void> {
    if (this.completed) {
      const error = this.completionError();
      if (error) throw error;
      return;
    }

    return new Promise((resolve, reject) => {
      const completeHandler = () => {
        unsubError();
        resolve();
      };

      const errorHandler = (error: Error) => {
        unsubComplete();
        reject(error);
      };

      const unsubComplete = this.on('complete', completeHandler);
      const unsubError = this.on('error', errorHandler);
    });
  }

  // ============ Process Interpreter API ============

  /**
   * Execute an instruction on this process.
   *
   * This is the primary API for running instructions on an existing process.
   * The process must not be stopping or already executing work.
   *
   * @param instruction - The instruction text to execute
   * @param options - Execution options
   * @param options.sync - If true (default), wait for completion before returning
   * @returns Promise that resolves when instruction is queued (sync=false) or completed (sync=true)
   *
   * @example
   * ```typescript
   * const process = await createProcess(context);
   *
   * // Sync execution (default) - waits for completion
   * await process.execute("Remember the number 42");
   * await process.execute("What number did I ask you to remember?");
   *
   * // Async execution - returns immediately
   * await process.execute("Do something long", { sync: false });
   * // ... do other work ...
   * await process.wait();
   * ```
   */
  /**
   * Load an agent from a VFS path and embed it into this process.
   * Mirrors the Python `process.load_embedded_agent()` API.
   * The agent spec is merged into cli_config on the backend and persisted.
   */
  async loadEmbeddedAgent(sourcePath: string): Promise<void> {
    const actionInfo = new ActionInfo('load-embedded-agent', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { asset_ref: sourcePath };
    await dataManager.callAction(actionInfo);
  }

  /**
   * Symlink a skill folder into this process's assets dir so Claude Code
   * discovers it at startup. `sourcePath` is the absolute path of the skill
   * folder (parent of SKILL.md). Live edits to the source SKILL.md flow
   * through to the next session — no re-materialization needed.
   */
  async loadEmbeddedSkill(sourcePath: string): Promise<void> {
    const actionInfo = new ActionInfo('load-embedded-skill', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { asset_ref: sourcePath };
    await dataManager.callAction(actionInfo);
  }

  /**
   * Unified read-side view of every asset visible to this process.
   * Mirrors `flow_sdk.builtin.agentic_process.AgenticProcess.get_asset_descriptors`.
   *
   * The same asset may appear multiple times with different `source` values
   * (e.g. EMBEDDED + USER_DIR for a skill that's both materialized into the
   * process and globally discoverable).
   *
   * Path-discovered process-visible rows are executable assets (skills +
   * agents). Transcript usage can also surface other file-backed entities that
   * were read in the session.
   */
  async getAssets(): Promise<AssetDescriptor[]> {
    const actionInfo = new ActionInfo('get-assets', AgenticProcess.type, this.id, 'GET');
    const response = await dataManager.callAction<void, { assets?: AssetDescriptor[] }>(actionInfo);
    return response?.assets ?? [];
  }

  /**
   * Everything this run produced, as durable Artifact rows.
   *
   * A PROPERTY, not a fetch: hydrated once by {@link loadArtifacts} and kept
   * live from there by the `artifact.*` bus lane through
   * {@link applyArtifactEvent}. One source of truth, so every reader — the
   * ribbon chip, a viewer, a test — sees the same array.
   *
   * The array is REPLACED on every change (never mutated in place) so a
   * memoized React reader notices.
   */
  get artifacts(): Artifact[] {
    return this._artifacts;
  }

  /**
   * Hydrate {@link artifacts} from the server, once.
   *
   * Server-side this is a match query over `generated_by`, not a list field on
   * the process, so concurrent registrations cannot clobber one another's
   * append. GET, like its sibling `get-assets`: a pure read with no body.
   *
   * **The snapshot MERGES; it never replaces.** Callers subscribe to the bus
   * BEFORE calling this (fetch-then-subscribe silently loses any event landing
   * in the gap), which means deltas can — and in a busy run will — be applied
   * while this request is still in flight. A row the deltas already carry wins
   * over the snapshot's copy of it, and a row the deltas deleted is not
   * resurrected by a snapshot that predates the delete.
   */
  async loadArtifacts(): Promise<Artifact[]> {
    if (this._artifactsLoaded) return this._artifacts;
    if (this._artifactsLoading) return this._artifactsLoading;
    this._artifactsLoading = (async () => {
      const actionInfo = new ActionInfo('artifacts', AgenticProcess.type, this.id, 'GET');
      try {
        const response = await dataManager.callAction<void, { artifacts?: unknown[] }>(actionInfo);
        const snapshot = (response?.artifacts ?? []).map((row) => new Artifact(row as Partial<IArtifact>));
        this._mergeArtifactSnapshot(snapshot);
        this._artifactsLoaded = true;
        return this._artifacts;
      } finally {
        this._deletedArtifactIds.clear();
        this._artifactsLoading = null;
      }
    })();
    return this._artifactsLoading;
  }

  /**
   * Apply one `artifact.created|updated|deleted` delta, by id.
   *
   * Returns whether the array changed, so a subscriber can skip a re-render on
   * a duplicate or an unknown-id delete. Events for another producer are
   * ignored: the bus lane is scoped by `ctx.scope`, but a delivery filter is
   * not an identity check and this list means "what THIS run made".
   */
  applyArtifactEvent(event: FlowEvent): boolean {
    const id = artifactIdOf(event);
    if (!id) return false;
    const producer = event.data?.generated_by;
    if (typeof producer === 'string' && producer && producer !== `${AgenticProcess.type}-${this.id}`) {
      return false;
    }
    if (event.tag === 'artifact.deleted') {
      // Only an in-flight GET can resurrect this row; once its snapshot settles
      // the database itself is the authoritative record of the delete.
      if (this._artifactsLoading) this._deletedArtifactIds.add(id);
      const next = this._artifacts.filter((a) => String(a.id) !== id);
      if (next.length === this._artifacts.length) return false;
      this._artifacts = next;
      return true;
    }
    const at = this._artifacts.findIndex((a) => String(a.id) === id);
    const merged = new Artifact({
      ...(at >= 0 ? (this._artifacts[at].toJSON() as Partial<IArtifact>) : {}),
      ...artifactFieldsOf(event, id),
    });
    const next = [...this._artifacts];
    if (at >= 0) next[at] = merged;
    else next.push(merged);
    this._artifacts = next;
    return true;
  }

  /** Snapshot ∪ deltas: deltas win per id, deleted ids stay deleted. */
  private _mergeArtifactSnapshot(snapshot: Artifact[]): void {
    const live = new Map(this._artifacts.map((a) => [String(a.id), a]));
    const merged: Artifact[] = [];
    for (const row of snapshot) {
      const id = String(row.id);
      if (this._deletedArtifactIds.has(id)) continue;
      merged.push(live.get(id) ?? row);
      live.delete(id);
    }
    // Rows the snapshot predates — created by an event during the request.
    merged.push(...live.values());
    this._artifacts = merged;
  }

  /**
   * Unified attach/detach/list for file-backed entities (agents, skills, …)
   * materialized under the process's assets dir and discovered by Claude via
   * ``--add-dir``. Mirrors Python ``process.attach_embedded_asset`` /
   * ``detach_embedded_asset`` / ``list_embedded_assets``.
   *
   * Pass a serialized TypeId (``agent-<id>`` / ``skill-<id>``) or the entity
   * itself — ``typeId.toString()`` is extracted automatically.
   */
  readonly embeddedAssets = {
    attach: async (entityOrRef: { typeId?: TypeId } | TypeId | string): Promise<void> => {
      const ref = this._coerceRef(entityOrRef);
      const actionInfo = new ActionInfo('attach-embedded-asset', AgenticProcess.type, this.id, 'POST');
      actionInfo.bodyParameters = { entity_ref: ref.toString() };
      await dataManager.callAction(actionInfo);
      // The WS broadcast lands embedded_asset_refs as plain stringified TypeIds
      // (the server serializes them that way); avoid duplicating by comparing
      // on the string form instead of property-by-property on TypeId.
      const refStr = ref.toString();
      const current = this.embedded_asset_refs ?? [];
      const has = current.some((r) => String(r) === refStr);
      if (!has) this.embedded_asset_refs = [...current, ref];
    },
    detach: async (entityOrRef: { typeId?: TypeId } | TypeId | string): Promise<void> => {
      const ref = this._coerceRef(entityOrRef);
      const actionInfo = new ActionInfo('detach-embedded-asset', AgenticProcess.type, this.id, 'POST');
      actionInfo.bodyParameters = { entity_ref: ref.toString() };
      await dataManager.callAction(actionInfo);
      const refStr = ref.toString();
      this.embedded_asset_refs = (this.embedded_asset_refs ?? []).filter((r) => String(r) !== refStr);
    },
    list: (): TypeId[] => [...(this.embedded_asset_refs ?? [])],
  };

  /** Normalize the three accepted input shapes to a TypeId. */
  private _coerceRef(input: { typeId?: TypeId } | TypeId | string): TypeId {
    if (input instanceof TypeId) return input;
    if (typeof input === 'string') return new TypeId(input);
    if (input.typeId) return input.typeId;
    throw new Error('embeddedAssets: input must be TypeId, entity with typeId, or serialized string');
  }

  /**
   * Print-mode streaming prompt. Available on ``visible === false`` (print-mode)
   * processes created with ``outputFormat: "stream-json"`` on the AgenticContext.
   *
   * POSTs ``/agentic_process/<id>/prompt`` with ``{ message }``, consumes the
   * streaming XML response body via ``FlowStreamProcessor``, and ingests each
   * emitted FlowData into ``this.flowDataStream`` so the UI sees it via the
   * same hook pipeline (``useProcessStream``) the rest of the app already uses.
   *
   * PTY-interactive processes (visible=true) will 409 on this action — they
   * use ``inject``/``executeInstruction`` instead.
   */
  async prompt(
    text: string,
    abortController?: AbortController,
    opts?: { permissionMode?: PermissionMode },
  ): Promise<void> {
    const { FlowStreamProcessor } = await import('../flow_processing/flow-stream-processor');
    const { FlowEvents } = await import('../flow_processing/flow-events');

    const ctrl = abortController ?? new AbortController();

    // Bracket the whole turn as "prompting" (the reliable in-flight signal the
    // chat activity indicator watches) — set optimistically before the request
    // and cleared when the stream ends or errors.
    this._setPromptingDelta(1);
    try {
      // Optimistic echo of the user turn into the stream.
      this.appendUserMessage(text);

      const actionInfo = new ActionInfo(
        'prompt',
        AgenticProcess.type,
        this.id,
        'POST',
        false,
        true, // streaming
        ctrl.signal,
      );
      actionInfo.bodyParameters = {
        message: text,
        ...(opts?.permissionMode ? { permission_mode: opts.permissionMode } : {}),
      };

      const response = await dataManager.callAction<unknown, Response>(actionInfo);
      if (!response || !response.body) {
        throw new Error('[AgenticProcess.prompt] no streaming response body');
      }

      const processor = new FlowStreamProcessor();
      processor.on(FlowEvents.DATA, (fd: FlowData) => {
        try {
          this.flowDataStream.ingest(fd);
        } catch (err) {
          console.error('[AgenticProcess.prompt] ingest error', err);
        }
      });
      processor.on(FlowEvents.ERROR, (err) => {
        console.error('[AgenticProcess.prompt] processor error', err);
      });

      await processor.ingestStream(response.body.getReader(), ctrl);
    } finally {
      this._setPromptingDelta(-1);
    }
  }

  /**
   * Watch a turn this client did NOT start, and render it live.
   *
   * `prompt()` above carries a turn's content back to whoever sent it. Nobody
   * else has a source — a turn typed into the xterm, watched from a second tab,
   * or driven by a background worker leaves other surfaces on a stale list
   * until history is reloaded at turn end. This opens the backend's read-only
   * `observe-turn` stream and ingests it into the same `flowDataStream`.
   *
   * Deliberately NOT bracketed with `_setPromptingDelta`: `isPrompting` means
   * "I am driving a turn", and that is exactly the flag callers use to decide
   * whether to observe. Setting it here would make a watcher look like a
   * sender.
   *
   * Resolves when the turn ends. Abort the controller (on unmount) to stop
   * watching — the worker is unaffected, only the observation stops.
   */
  async observeTurn(abortController?: AbortController): Promise<void> {
    const { FlowStreamProcessor } = await import('../flow_processing/flow-stream-processor');
    const { FlowEvents } = await import('../flow_processing/flow-events');

    const ctrl = abortController ?? new AbortController();
    const actionInfo = new ActionInfo(
      'observe-turn',
      AgenticProcess.type,
      this.id,
      'POST',
      false,
      true, // streaming
      ctrl.signal,
    );

    const response = await dataManager.callAction<unknown, Response>(actionInfo);
    if (!response || !response.body) return; // nothing in flight — not an error

    const processor = new FlowStreamProcessor();
    processor.on(FlowEvents.DATA, (fd: FlowData) => {
      try {
        this.flowDataStream.ingest(fd);
      } catch (err) {
        console.error('[AgenticProcess.observeTurn] ingest error', err);
      }
    });
    processor.on(FlowEvents.ERROR, (err) => {
      console.error('[AgenticProcess.observeTurn] processor error', err);
    });

    await processor.ingestStream(response.body.getReader(), ctrl);
  }

  /**
   * Set ONLY tab-visibility (`visible`) — whether this process shows as a
   * terminal tab. Decoupled from transport: `visible` does NOT pick PTY vs
   * headless (that's `pty_mode`). Use this to show/hide the tab without
   * restarting the worker or flipping the session. The backend broadcasts the
   * update, so a watched process reflects the new `visible` on the entity.
   */
  async setVisible(visible: boolean): Promise<void> {
    const actionInfo = new ActionInfo('set-visible', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { visible };
    await dataManager.callAction(actionInfo);
    // Optimistic + latched until the wire agrees (see onEntityUpdate).
    this.stageTransportIntent({ visible });
  }

  /**
   * Stage input WITHOUT submitting — "type" `text` into the input, no Enter.
   *
   * Pairs with {@link submit}: `input(x)` then `submit()` ≡ `submit(x)`. On a
   * live PTY this writes the raw keystrokes (no trailing `\r`); headless, it
   * enqueues onto the process's PERSISTED prompt queue (so the staged turn
   * survives a reload / separate `submit` request), which `submit` drains.
   *
   * `options` is a generic per-call bag; `options.queueOptions` is passed to the
   * queue on the headless path (e.g. `{ source }`).
   */
  async input(text: string, options?: { queueOptions?: Record<string, unknown> }): Promise<void> {
    const actionInfo = new ActionInfo('input', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { text, ...(options ? { options } : {}) };
    await dataManager.callAction(actionInfo);
  }

  /**
   * Commit the current input as one turn. `submit(x)` ≡ `input(x)` + `submit()`.
   *
   * If `instruction` is given it is {@link input} first; then a live PTY gets a
   * discrete Enter, while a headless process fires the staged turn. Fire-and-
   * forget — observe output on the stream. `options` is reserved for per-turn
   * flags (e.g. permission mode); accepted now so the signature is stable.
   */
  async submit(instruction?: string, options?: { permissionMode?: PermissionMode }): Promise<void> {
    const actionInfo = new ActionInfo('submit', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = {
      ...(instruction !== undefined ? { instruction } : {}),
      ...(options ? { options } : {}),
    };
    await dataManager.callAction(actionInfo);
  }

  /**
   * Cancel the in-flight prompt turn. Server-side SIGTERMs the subprocess with
   * a 5 s grace then SIGKILL; a final ``<flow-end>`` arrives on the stream.
   */
  async cancelPrompt(): Promise<void> {
    const actionInfo = new ActionInfo('cancel-prompt', AgenticProcess.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);
  }

  /**
   * Interrupt the in-flight turn from a single call site. For a visible PTY
   * process this sends Ctrl-C (``\x03``, no trailing newline) to the same PTY
   * the xterm types into; for a print-mode process it cancels the streaming
   * subprocess via ``cancelPrompt``. Lets both the chat pane and the floating
   * assistant share one "stop generating" handler.
   */
  async interruptTurn(): Promise<void> {
    // Keys on the TRANSPORT (`pty_mode`), never tab-visibility: a hidden live
    // PTY (`visible=false, pty_mode=true`) is still a PTY, and routing it to
    // cancelPrompt sent a cancel to a print-mode subprocess that doesn't exist
    // — Stop silently did nothing.
    if (this.pty_mode && this.shell_id) {
      const pty = this.ptyConnection ?? (await Shell.getById<Shell>(this.shell_id))?.ptyConnection;
      if (pty) {
        await pty.sendInput('\x03');
        return;
      }
    }
    await this.cancelPrompt();
  }

  async executeInstruction(
    instruction: string,
    options: { sync?: boolean; workerSessionId?: string } = {},
  ): Promise<void> {
    const { sync = true, workerSessionId } = options;

    if (this.status === ProcessStatus.STOPPING) {
      throw new Error('Process is stopping');
    }

    if (this.status === ProcessStatus.FAILED) {
      throw new Error('Process failed to start');
    }

    if (this.busy || isWorkerRunning(this.workerStatus)) {
      throw new Error('Process is already running');
    }

    // Do not trust the prior session's raw terminal status for a new headless
    // invocation. The current turn settles from its own FlowData END frame.
    const priorTurnState = {
      outcome: this._turnOutcome,
      error: this._error,
      observedEnd: this._observedTurnEnd,
      observedError: this._observedTurnError,
      observedFrame: this._observedTurnFrame,
    };
    // Completion is per instruction, including interactive PTY prompts. A PTY
    // process stays alive between turns, but each execute still owns a fresh
    // worker-status terminal edge and must emit its own complete/error event.
    this.beginTurn();

    // Optimistically echo user message into the stream
    this.appendUserMessage(instruction);

    // Call backend execute action
    const actionInfo = new ActionInfo('execute', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { instruction, ...(workerSessionId ? { worker_session_id: workerSessionId } : {}) };

    try {
      await dataManager.callAction(actionInfo);
    } catch (error) {
      // No backend turn was accepted, so do not leave the local pending latch
      // masking the process's last authoritative status.
      this._turnOutcome = priorTurnState.outcome;
      this._error = priorTurnState.error;
      this._observedTurnEnd = priorTurnState.observedEnd;
      this._observedTurnError = priorTurnState.observedError;
      this._observedTurnFrame = priorTurnState.observedFrame;
      throw error;
    }

    // If sync, wait for execution to complete
    if (sync) {
      await this.waitForExecutionComplete();
    }
  }

  /**
   * Wait for execution to complete.
   *
   * Listens for the ``complete`` / ``error`` events which fire when the
   * SDK observes ``workerStatus`` transitioning to a terminal value via
   * an entity-op broadcast. Backend is the sole authority on that
   * transition; the SDK only reacts.
   */
  private async waitForExecutionComplete(): Promise<void> {
    if (this.completed) {
      const error = this.completionError();
      if (error) throw error;
      return;
    }

    return new Promise((resolve, reject) => {
      let resolved = false;

      const done = (result: 'resolve' | 'reject', error?: Error) => {
        if (resolved) return;
        resolved = true;
        unsubComplete();
        unsubError();
        if (result === 'resolve') {
          resolve();
        } else {
          reject(error ?? new Error('Unknown error'));
        }
      };

      const unsubComplete = this.on('complete', () => {
        done('resolve');
      });

      const unsubError = this.on('error', (err) => {
        done('reject', err instanceof Error ? err : new Error(String(err)));
      });

      // Race: a terminal broadcast could land between the entry check above
      // and listener installation. Re-check after subscribing.
      if (this.completed) {
        const error = this.completionError();
        done(error ? 'reject' : 'resolve', error ?? undefined);
      }
    });
  }

  /**
   * Wait for the worker_status to reach a terminal state.
   *
   * Use this after async execute() calls to wait for completion.
   */
  async wait(): Promise<void> {
    if (this.completed) {
      const error = this.completionError();
      if (error) throw error;
      return;
    }

    return new Promise((resolve, reject) => {
      const checkState = () => {
        if (!this.completed) return;
        const error = this.completionError();
        if (!error) {
          unsubState();
          unsubError();
          resolve();
        } else {
          unsubState();
          unsubError();
          reject(error);
        }
      };

      const unsubState = this.on('state_change', checkState);
      const unsubError = this.on('error', (err) => {
        unsubState();
        unsubError();
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      // Check current state immediately
      checkState();
    });
  }

  /**
   * Terminate this process.
   *
   * After exit, the worker is stopped and the lifecycle status is controlled by the backend.
   *
   * @example
   * ```typescript
   * const process = await createProcess(context);
   * await process.execute("Do something");
   * await process.exit(); // Cleanup
   * ```
   */
  async exit(): Promise<void> {
    if (!this.shell_id) return; // Nothing to exit

    // Mark this stop as user-initiated so the auto-recovery dispatcher does
    // not relaunch the worker between the optimistic CLOSING update and the
    // backend's eventual STOPPED/STOPPING write.
    this._userInitiatedStop = true;

    // Optimistically mark the shell CLOSING synchronously (no await) so the
    // loader's resolveDefaultShell sees it as non-alive and won't redirect back
    // to this tab while the exit API call is in-flight.
    const shell = Shell.getByIdFromCache(this.shell_id);
    if (shell) {
      shell.status = ShellStatus.CLOSING;
      dataManager.notifyEntityChanged(shell);
    }

    const actionInfo = new ActionInfo('exit', AgenticProcess.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);

    // Shell entity is kept alive by the backend — do NOT call shell.close()
  }

  /**
   * Re-attach this process to a Project derived from its `workdir`.
   *
   * Calls the `recover-project` backend action which walks 3 phases (existing
   * exact-match → ~/.claude/projects materialization → fresh entity), repoints
   * `self.project_id`, saves on the server, and returns the recovered Project.
   * This method drops the recovered entity into the local `dataManager` cache
   * and updates `this.project_id` (no save — backend already saved).
   *
   * Used by the route loader on a 404 from the project context fetch.
   */
  async recoverProject(): Promise<import('../entities/project').Project> {
    const { Project } = await import('../entities/project');
    const action = new ActionInfo('recover-project', AgenticProcess.type, this.id, 'POST');
    const response = await dataManager.callAction<void, { project: unknown }>(action);
    if (!response?.project) {
      throw new Error('recover-project returned no project entity');
    }
    const project = dataManager.updateEntityFromJson<import('../entities/project').Project>(
      response.project as Record<string, unknown>,
    );
    this.project_id = project.id;
    return project;
  }

  /**
   * Permanent teardown: kill worker + delete shell entity.
   * Use for "close tab" — shell is gone after this call.
   */
  async close(): Promise<void> {
    if (this.status === ProcessStatus.STOPPING || this.status === ProcessStatus.STOPPED) return;

    // Permanent teardown — mark user intent so the backend recovery watchdog
    // (which respawns dead workers) does not relaunch this process.
    this._userInitiatedStop = true;

    if (this.shell_id) {
      const shell = Shell.getByIdFromCache(this.shell_id);
      if (shell) {
        shell.status = ShellStatus.CLOSING;
        dataManager.notifyEntityChanged(shell);
      }
    }

    const actionInfo = new ActionInfo('close', AgenticProcess.type, this.id, 'POST');
    await dataManager.callAction(actionInfo);

    // Dispose frontend PTY client — backend already deleted the shell entity.
    if (this.shell_id) {
      const shell = Shell.getByIdFromCache(this.shell_id);
      if (shell) await shell.close().catch(() => {});
    }
  }

  // ============ Shell Lifecycle API ============

  /**
   * Start (or reopen) this AgenticProcess.
   *
   * Calls the backend `open` action which builds the full claude command
   * server-side and opens a Shell-owned PTY. Handles all cases:
   * fresh start, reopen after restart (resumes Claude), or no-op if PTY alive.
   *
   * @param options - Optional instruction to execute
   * @returns Shell session ID and session ID
   */
  async start(options?: {
    instruction?: string;
    visible?: boolean;
    ptyTimeout?: number;
    /** Initial PTY dimensions. Authoritative resize is issued by the
     * InteractiveTerminal once xterm has fitted; this seed exists so the
     * worker's first paint isn't wrapped at 80 cols on a wide viewport. */
    cols?: number;
    rows?: number;
    /** Explicit user retry of a failed-to-start process: clears the
     * server-side `start_failure` latch before launching. Without it the
     * backend refuses to respawn a latched process. */
    retry?: boolean;
  }): Promise<boolean> {
    // No client-side STOPPING guard. The server's ``open`` action runs
    // ``reap_if_orphaned()`` at entry: if the row is stuck in STOPPING with
    // a dead worker, it's reset to STOPPED and the start proceeds normally.
    // If it's a *live* transitioner (within the 10s grace), the server will
    // refuse with a useful response — let the server be the authority.
    //
    // No client-side lifecycle fast path. The backend ``open`` action is the
    // single oracle for reattach-vs-recover-vs-fresh. The dedupe that *did*
    // matter — "I'm already on this same pty_id, don't reopen the WS" — is
    // already enforced inside ``PtyConnection.attach`` via the
    // ``_attachedPtyId`` early-return and the in-flight ``_attachPromise``
    // guard, so removing the short-circuit here costs nothing on tab-switch
    // performance and removes the empty-shell-after-refresh failure mode
    // (the cached ``status === RUNNING`` could outlive the actual worker).
    const actionInfo = new ActionInfo('open', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = options ?? {};
    const tOpen = performance.now();
    const result = await dataManager.callAction<
      unknown,
      {
        shell_id: string;
        pty_id: string;
        session_id: string | null;
        status?: string;
        shell: Record<string, unknown>;
      } | null
    >(actionInfo);
    toplog.log(
      'process_load',
      `AgenticProcess.start POST /open took ${msSince(tOpen)}ms proc=${this.id.slice(0, 8)} ok=${!!result}`,
    );
    if (!result) throw new Error('Process could not be opened (process may be terminated)');
    if (result.status) {
      this.status = result.status as ProcessStatus;
    }
    this.shell_id = result.shell_id;
    this.session_id = result.session_id;
    dataManager.updateEntityFromJson(result.shell);
    const shell = await dataManager.getByTypeId<Shell>(new TypeId(Shell.type, result.shell_id));
    if (!shell) throw new Error(`Shell ${result.shell_id} not found after start()`);
    shell.pty_pid = result.pty_id;
    // Sync PtyConnection identifiers before attaching (guard: fakes in tests may lack ptyConnection).
    if (shell.ptyConnection) {
      shell.ptyConnection.shellId = shell.id;
      if (shell.compute_node_id) shell.ptyConnection.computeNodeId = shell.compute_node_id;
    }
    const tAttach = performance.now();
    await shell.attachPty({
      // Real xterm size only — undefined means "keep current size, just repaint".
      cols: options?.cols,
      rows: options?.rows,
      timeout: options?.ptyTimeout,
      ptyId: result.pty_id,
    });
    toplog.log(
      'process_load',
      `AgenticProcess.start attachPty took ${msSince(tAttach)}ms pty=${result.pty_id?.slice(0, 8)}`,
    );
    // Successful open clears any prior user-stop intent.
    this._userInitiatedStop = false;
    // A successful open implies the process is not latched (the backend gate
    // refuses latched opens; retry clears before launching). Clear locally
    // too: the entity dump drops None fields, so the server-side clear never
    // arrives as `start_failure: null`.
    this.start_failure = null;
    return true;
  }

  /**
   * Fork this session into a new sibling AgenticProcess.
   *
   * Creates a new process that resumes from this session's conversation history
   * but diverges into a fresh session ID — equivalent to running:
   *   claude --resume <this.session_id> --fork-session
   *
   * @param visible - Whether the new process should appear in the tabs view (default: false).
   *                  Pass true when forking from the UI toolbar.
   * @returns The new AgenticProcess, already opened with a live PTY.
   */
  async fork(visible = false): Promise<AgenticProcess> {
    const actionInfo = new ActionInfo('fork', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { visible };
    const data = await dataManager.callAction<{ visible: boolean }, Record<string, unknown>>(actionInfo);
    if (!data?.id) throw new Error('Fork failed: backend returned no process data');
    dataManager.updateEntityFromJson(data);
    const newProcess = await dataManager.getByTypeId<AgenticProcess>(
      new TypeId(AgenticProcess.type, data.id as string),
    );
    if (!newProcess) throw new Error(`Fork failed: new process ${data.id} not found after registration`);
    await newProcess.start();
    return newProcess;
  }

  /**
   * Start a CollaborationRoom around this process — creates a fresh room on
   * the project and binds this process to it.
   */
  async createCollaborationRoom(
    hostName: string,
    options?: { hostMemberId?: string; name?: string | null },
  ): Promise<import('../entities/collaboration-room').CollaborationRoom> {
    const { CollaborationRoom } = await import('../entities/collaboration-room');
    const room = await CollaborationRoom.create({
      projectId: this.project_id ?? undefined,
      hostName,
      hostMemberId: options?.hostMemberId,
      name: options?.name ?? null,
    });
    // Bind this process to the new room on both ends.
    this.collaboration_room_id = room.id;
    await this.save();
    try {
      await room.addProcess(this.id);
    } catch (err) {
      console.warn('[AgenticProcess.createCollaborationRoom] addProcess failed', err);
    }
    return room;
  }

  /**
   * Stop the current shell session while keeping the shell entity available for reuse.
   *
   * Calls the backend exit action which kills the worker and PTY but
   * preserves the shell entity. The session_id is preserved so the
   * process can be resumed later via start().
   */
  async stop(): Promise<void> {
    await this.exit();
  }

  /**
   * Stop the current shell session and start a new one, preserving session history.
   * Emits 'restarted' so the terminal can clear and re-attach.
   */
  async restart(): Promise<void> {
    if (this.shell_id) await this.stop();
    await this.start();
    this.emit('restarted', { process: this });
  }

  /**
   * Standardized transport switch — the single way to flip a session between the
   * interactive PTY terminal (`WorkerMode.Interactive`) and headless CLI /
   * JSON-stream (`WorkerMode.CLI`). One logical session (one `session_id` /
   * transcript); routing stays `headless == !visible`, and the durable `pty_mode`
   * intent is persisted so a reload keeps the chosen transport.
   *
   * Frontend → backend: the CLI direction calls the `switch-mode` action (kill
   * PTY, visible=False, pty_mode=False); the PTY direction routes through the
   * canonical `start()`/`open` path (which the backend `switch-mode` INTERACTIVE
   * branch mirrors for non-UI callers) so the live PTY attach happens, plus the
   * `restarted` event so the terminal clears + re-attaches. Rejected mid-turn
   * (backend 409); the caller disables the toggle while a turn is in flight.
   */
  async switchMode(mode: WorkerMode, opts?: { cols?: number; rows?: number }): Promise<void> {
    if (mode === WorkerMode.Interactive) {
      const restoreTransport = this.stageTransportIntent({ pty_mode: true, visible: true });
      try {
        await this.start({ visible: true, retry: true, cols: opts?.cols, rows: opts?.rows });
        this.emit('restarted', { process: this });
      } catch (error) {
        // The open action rejected, so the optimistic transport intent never
        // became durable. Restore the durable fields and their stale-wire
        // latch in one scoped step; otherwise later headless broadcasts are
        // discarded and the UI stays pinned to a terminal that never started.
        restoreTransport();
        throw error;
      }
      return;
    }
    // CLI: one `switch-mode` round-trip. Mirror exit()'s optimistic CLOSING +
    // user-stop guard. Do NOT emit 'restarted' — it drives re-attachPty, wrong
    // after the PTY is killed; the view's toggle handler owns the chat reconcile.
    this._userInitiatedStop = true;
    const shell = this.shell_id ? Shell.getByIdFromCache(this.shell_id) : null;
    if (shell) {
      shell.status = ShellStatus.CLOSING;
      dataManager.notifyEntityChanged(shell);
    }
    // Stage the desired CLI transport BEFORE the request, symmetric with the
    // Interactive branch above. Backend exit/final-save broadcasts happen
    // before the HTTP response; keeping the prior PTY latch during that window
    // can discard the authoritative false frame as stale. Roll back both the
    // fields and latch if the action is rejected.
    const restoreTransport = this.stageTransportIntent({ pty_mode: false, visible: false });
    const actionInfo = new ActionInfo('switch-mode', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { mode };
    try {
      await dataManager.callAction(actionInfo);
    } catch (error) {
      restoreTransport();
      throw error;
    }
  }

  /**
   * Bridge backend-initiated restarts to the local 'restarted' event.
   *
   * The UI restart button drives {@link restart} client-side, which emits
   * 'restarted' directly. A *server*-initiated restart (e.g. the agent running
   * `flow process restart` after installing an MCP, via the backend
   * `self-restart` action) has no such client signal — the backend instead
   * pushes a `worker.restarted` entity event once the fresh PTY is up. Re-emit
   * it as the same local 'restarted' event so {@link InteractiveTerminal}
   * clears and re-attaches to the new PTY without any extra wiring.
   */
  onEntityEvent(event: string, payload: Record<string, unknown>): void {
    super.onEntityEvent(event, payload);
    if (event === 'worker.restarted') {
      this.emit('restarted', { process: this, payload });
    }
    // Mirror of Python `AgenticProcess.on_show` (the `flow show` verb): the
    // agent declared a display-focus target. Re-emit as the typed 'show'
    // event so display surfaces subscribe via `proc.onShow(...)` without
    // string-matching the generic entity_event channel.
    if (event === 'on_show') {
      this.emit('show', payload);
    }
  }

  /**
   * Subscribe to agent-declared display focus (`flow show`). The payload is
   * the resolved show target from the backend action (see
   * `flow_sdk/core/display_target.py`). Returns the unsubscribe function.
   */
  onShow(handler: (payload: ShowTarget) => void): () => void {
    return this.on('show', handler);
  }

  /**
   * The agent's display history (`context_data.display_stack`) — every `flow
   * show` target with its `shown_at` stamp, newest last. Empty when nothing has
   * been shown. The newest entry is the current display pin (mirrors
   * `context_data.last_shown`).
   */
  get displayStack(): DisplayEntry[] {
    const raw = (this.context_data as { display_stack?: unknown } | undefined)?.display_stack;
    return Array.isArray(raw) ? (raw as DisplayEntry[]) : [];
  }

  /**
   * Intercept the live agent-progress push before it enters the flow stream.
   *
   * The backend reuses the `progress_report` envelope (attributes.kind ===
   * 'process_status') to push the ProcessStatusReport on every debounce flush.
   * It's control-plane, not renderable content, so we update `statusReport`,
   * emit a `status_report` event for subscribers, and return WITHOUT ingesting
   * it into `flowDataStream` (keeps it out of history/output). All other
   * FlowData falls through to the base handler unchanged.
   */
  handleFlowData(flowData: FlowData): void {
    if (
      flowData.elementType === FlowElementTypes.PROGRESS_REPORT &&
      flowData.attributes?.kind === PROCESS_STATUS_KIND
    ) {
      const report = parseStatusReport(flowData.rawData);
      if (report) {
        this.statusReport = report;
        this.emit('status_report', report);
      }
      return;
    }
    super.handleFlowData(flowData);
    this.observeHeadlessTurnFrame(flowData);
  }

  /**
   * Write raw text to the live PTY stdin.
   * The shell must have an active PTY (call start() first).
   *
   * @param text - Text to send (newline appended automatically)
   */
  async sendInput(text: string): Promise<void> {
    if (!this.shell_id) throw new Error('[AgenticProcess.sendInput] No shell linked to this process');
    const pty = this.ptyConnection;
    if (pty) {
      await pty.sendInput(text + '\n');
      return;
    }
    // Fallback: shell not yet in cache — load it and delegate
    const typeId = new TypeId(Shell.type, this.shell_id);
    const shell = await dataManager.getByTypeId<Shell>(typeId);
    if (!shell) throw new Error(`[AgenticProcess.sendInput] Shell ${this.shell_id} not found`);
    await shell.ptyConnection.sendInput(text + '\n');
  }

  /**
   * Inject a new instruction into the process's injected queue.
   *
   * The instruction is added to the backend's injected queue and will
   * be executed after all file-based instructions complete.
   *
   * @param instruction - The instruction text to inject
   * @returns Object with instructionId and updated queue size
   *
   * @example
   * ```typescript
   * const { process } = await AgenticProcess.spawn({ workdir }, { instruction: 'First task' });
   *
   * // Inject additional instructions during execution
   * const result = await process.inject("Now do another task");
   * console.log('Injected instruction:', result.instructionId);
   * ```
   */
  async inject(instruction: string): Promise<{ instructionId: string; injectedQueueSize: number }> {
    const actionInfo = new ActionInfo('control', AgenticProcess.type, this.id, 'POST');
    actionInfo.subpath = '/inject';
    actionInfo.bodyParameters = { message: instruction };

    const result = await dataManager.callAction<unknown, { injected: boolean; message_length: number }>(actionInfo);

    // Generate a client-side instruction ID since backend doesn't return one
    const instructionId = `instr_${Date.now().toString(36)}`;

    return {
      instructionId,
      injectedQueueSize: result.message_length,
    };
  }

  /**
   * Execute one instruction and yield its FlowData.
   *
   * This method waits for the next instruction to execute and yields
   * all FlowData generated by that single instruction.
   *
   * Note: This is a simplified step API for client-side use. The actual
   * step execution happens on the backend; this method streams the results.
   *
   * @example
   * ```typescript
   * const process = await processor.execute("First task", context);
   *
   * // Execute first instruction
   * for await (const data of process.step()) {
   *   console.log('Step 1:', data);
   * }
   *
   * // Inject and execute second instruction
   * await process.inject("Second task");
   * for await (const data of process.step()) {
   *   console.log('Step 2:', data);
   * }
   * ```
   */
  async *step(): AsyncGenerator<FlowData, void, unknown> {
    // Wait for flow data until the process completes
    const queue: FlowData[] = [];
    let resolver: ((v: FlowData | null) => void) | null = null;
    let stepComplete = this.completed;

    const dataHandler = (data: FlowData) => {
      if (resolver) {
        resolver(data);
        resolver = null;
      } else {
        queue.push(data);
      }
    };

    const stateHandler = () => {
      if (this.completed) {
        stepComplete = true;
        if (resolver) {
          resolver(null);
          resolver = null;
        }
      }
    };

    const completeHandler = () => {
      stepComplete = true;
      if (resolver) {
        resolver(null);
        resolver = null;
      }
    };

    const errorHandler = () => {
      stepComplete = true;
      if (resolver) {
        resolver(null);
        resolver = null;
      }
    };

    const unsubData = this.on('flow_data', dataHandler);
    const unsubState = this.on('state_change', stateHandler);
    const unsubComplete = this.on('complete', completeHandler);
    const unsubError = this.on('error', errorHandler);

    try {
      while (true) {
        // Check queue first
        const queued = queue.shift();
        if (queued !== undefined) {
          yield queued;
          continue;
        }

        if (stepComplete) {
          break;
        }

        // Worker already terminal — drain and exit.
        if (this.completed) {
          break;
        }

        // Wait for next event
        const data = await new Promise<FlowData | null>((r) => {
          resolver = r;
        });

        if (data === null) {
          continue;
        }
        yield data;
      }
    } finally {
      unsubData();
      unsubState();
      unsubComplete();
      unsubError();
    }
  }

  // ============ Internal Methods ============

  /**
   * Handle incoming FlowData.
   * Note: Storage and 'flow_data' emit are handled by base class handleFlowData().
   * This method handles process-specific logic including state updates from FlowData
   * (following Flow's pattern of state management via FlowData messages).
   * @internal
   */
  /**
   * Called by the store when the backend pushes an entity update via WebSocket.
   * Propagates state changes (including COMPLETE) so output() terminates correctly.
   *
   * The ``state_change`` event carries a delta payload:
   *   { field: 'status' | 'workerStatus', oldValue, newValue }
   * so subscribers can distinguish lifecycle transitions from worker-status updates
   * without re-reading the entity.
   * @internal
   */
  protected onEntityUpdate(data: Partial<IAgenticProcess>): void {
    const wasBusy = this.busy;
    let workerStatusChanged = false;
    // Reflected ``queue`` must REPLACE, not merge. ``deepAssign`` (which runs
    // right after this hook) recurses into arrays and merges them by index,
    // never shrinking the target — so a dequeue/clear would leave stale tail
    // entries (e.g. [A,B] + wire [B] → [B,B]). Assign the wire value wholesale
    // here and strip it from the payload so the following deepAssign skips it.
    // (Same "remove from payload before deepAssign" guard the cache path uses
    // for ``state``.)
    if ('queue' in data) {
      const q = data.queue;
      this.queue = q ? { enabled: !!q.enabled, entries: [...(q.entries ?? [])] } : null;
      delete data.queue;
    }
    // ``context_data.display_stack`` (the flow-show history) has the SAME
    // array-index-merge hazard as ``queue``: deepAssign recurses into
    // ``context_data`` and then index-merges the nested array, never shrinking
    // it — so a dedupe/cap/reorder would leave stale tail entries. Replace the
    // stack wholesale and strip it from the payload, letting the following
    // deepAssign deep-merge the REST of context_data untouched.
    if (data.context_data && typeof data.context_data === 'object' && 'display_stack' in data.context_data) {
      const ctx = data.context_data as Record<string, unknown>;
      const stack = ctx.display_stack;
      this.context_data = {
        ...(this.context_data ?? {}),
        display_stack: Array.isArray(stack) ? [...stack] : stack,
      };
      const { display_stack: _omit, ...rest } = ctx;
      data.context_data = rest as IAgenticProcess['context_data'];
    }
    // Desired-value latch: once the client optimistically sets the transport /
    // visibility (`switchMode`/`setVisible`), HOLD that value against every
    // broadcast until the NEXT client switch overwrites the latch. `pty_mode` /
    // `visible` only ever change via those client actions, so a wire value that
    // disagrees is always stale (a pre-switch broadcast, which can arrive even
    // AFTER an agreeing one) — strip it so the optimistic value survives
    // `deepAssign`. Do NOT clear on first match: an early agreeing broadcast
    // followed by a delayed stale one is exactly the desync this guards against.
    // Same "remove from payload before deepAssign" shape as the `queue` guard.
    const pendingPtyMode = this._pendingTransport?.pty_mode;
    if (pendingPtyMode !== undefined && 'pty_mode' in data && data.pty_mode !== pendingPtyMode) {
      delete data.pty_mode;
    }
    const pendingVisible = this._pendingTransport?.visible;
    if (pendingVisible !== undefined && 'visible' in data && data.visible !== pendingVisible) {
      delete data.visible;
    }
    if (data.busy === true && !wasBusy) {
      // Reset before applying any failure fields from the same payload, so a
      // combined {busy:true,status:failed} update cannot clear its own error.
      this.beginTurn();
    }
    // Skip no-op transitions: castAndDeepAssign() runs this hook for every
    // WS entity-op AND for every REST-response write-through, so the same
    // status often arrives many times. Without the equality guard, downstream
    // `state_change` listeners (ProcessToolbar, useProcessState, useActiveTerminals)
    // would re-render at the broadcast frequency even when nothing changed.
    let statusEnteredFailed = false;
    if (data.status && data.status !== this.status) {
      const oldStatus = this.status;
      this.status = data.status as ProcessStatus;
      statusEnteredFailed = this.status === ProcessStatus.FAILED;
      this.emit('state_change', {
        field: 'status',
        oldValue: oldStatus,
        newValue: this.status,
      });
      // Named transition event — listener signature: (newValue, oldValue) => void.
      // Note: ``Shell`` also emits ``'status'`` for WS connection state — different
      // object, benign name overlap.
      this.emit('status', this.status, oldStatus);
    }
    // Guard on the value being a real boolean (not truthiness) so a
    // ``true → false`` turn-end flip still applies and emits — else the
    // input/toggle gates (isBusy) never re-enable.
    if (typeof data.busy === 'boolean' && data.busy !== this.busy) {
      const oldBusy = this.busy;
      this.busy = data.busy as boolean;
      this.emit('state_change', {
        field: 'busy',
        oldValue: oldBusy,
        newValue: this.busy,
      });
    }
    if ('worker_status' in data) {
      const nextWorkerStatus = data.worker_status ?? undefined;
      if (nextWorkerStatus !== this.workerStatus) {
        const oldWorker = this.workerStatus;
        this.workerStatus = nextWorkerStatus;
        workerStatusChanged = true;
        this.emit('state_change', {
          field: 'workerStatus',
          oldValue: oldWorker,
          newValue: this.workerStatus,
        });
      }
    }

    // Apply every wire field before deciding settlement. A single entity-op can
    // carry lifecycle, busy, and worker-status changes together.
    //
    // Settle from FAILED only on the TRANSITION into it, never on a statusless
    // op that merely observes an already-FAILED status. A fresh headless turn
    // (beginTurn above, on the busy:true edge) leaves ``status`` at a
    // stale FAILED inherited from the prior turn; firing ``_handleError`` on
    // every subsequent name-stamp / transcript-debounce op would re-settle that
    // fresh pending turn as an error.
    if (statusEnteredFailed) {
      this._handleError(new Error(`Process ended with lifecycle status: ${this.status}`));
    }
    if (this.busy) return;

    // A current headless invocation settles from its OWN FlowData END marker,
    // not a raw worker_status that may be inherited from a resumed/forked turn.
    // On the busy:false edge while the turn is still pending:
    //   - END already observed → settle from it now that the backend is idle.
    //   - This client is streaming the turn (saw frames) but END hasn't arrived
    //     yet → keep waiting; that END is the authoritative per-turn terminator.
    //   - Passive client (only entity edges, never any FlowData) → it will never
    //     see an END frame, so fall through to the worker_status fallback below
    //     instead of pinning ``completed`` at false forever.
    if (!this.pty_mode && this._turnOutcome === 'pending') {
      if (this._observedTurnEnd !== null) {
        this.settleObservedHeadlessTurn();
        return;
      }
      if (this._observedTurnFrame) return;
    }

    if (
      this._turnOutcome !== 'complete' &&
      this._turnOutcome !== 'error' &&
      (wasBusy || workerStatusChanged) &&
      isWorkerTerminal(this.workerStatus)
    ) {
      const error = this.completionError();
      if (error) this._handleError(error);
      else this._handleComplete();
    }
  }

  /**
   * Local-side reaction to ``workerStatus`` transitioning to COMPLETE.
   * Frontend does NOT decide completion; backend's projection does. This
   * just closes the stream and fires the ``complete`` event so consumers
   * (``output()``, ``waitForExecutionComplete``) can resolve.
   *
   * Caller contract: only invoke on a real transition into COMPLETE. The
   * call site in ``onEntityUpdate`` is gated by ``newValue !== oldValue`` so
   * this is naturally one-per-edge.
   * @internal
  */
  _handleComplete(): void {
    if (this._turnOutcome === 'complete' || this._turnOutcome === 'error') return;
    this._turnOutcome = 'complete';
    this._observedTurnEnd = 'complete';
    this._observedTurnError = null;
    this._error = null;
    this.flowDataStream.closeOpenGroups();
    this.flowDataStream.markComplete();
    this.emit('complete');
  }

  /**
   * Local-side reaction to ``workerStatus`` transitioning to a failure
   * state. Same authority model as ``_handleComplete``: backend decides;
   * SDK reacts.
   * @internal
  */
  _handleError(error: Error): void {
    if (this._turnOutcome === 'complete' || this._turnOutcome === 'error') return;
    this._turnOutcome = 'error';
    this._observedTurnEnd = 'error';
    this._observedTurnError = error;
    this._error = error;
    this.emit('error', error);
  }

  /**
   * Execute a plan file in the active Claude PTY session.
   * @param filePath - Absolute path to the plan file
   * @param options - Optional options (e.g., clearContext to inject /clear first)
   */
  async executePlan(filePath: string, options?: { clearContext?: boolean }): Promise<void> {
    const actionInfo = new ActionInfo('execute-plan', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { file_path: filePath, clear_context: options?.clearContext };
    return dataManager.callAction(actionInfo);
  }

  /**
   * Update a plan file based on <plan-note> annotations.
   * @param filePath - Absolute path to the plan file
   */
  async updatePlan(filePath: string): Promise<void> {
    const actionInfo = new ActionInfo('update-plan', AgenticProcess.type, this.id, 'POST');
    actionInfo.bodyParameters = { file_path: filePath };
    return dataManager.callAction<void, void>(actionInfo);
  }
}
