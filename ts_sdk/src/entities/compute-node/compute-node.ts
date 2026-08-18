/**
 * ComputeNode entity for managing compute environments.
 * Represents a sandboxed execution environment (local machine, E2B, etc.)
 *
 * Session Ownership (Frontend-only):
 * ComputeNode owns the frontend session cache. Sessions are stored per-node and
 * represent the local view of PTY sessions on this compute node. When the active
 * ComputeNode changes, the frontend cache is reset (NOT the backend PTYs).
 */

import { APIEntity, dataManager, registerEntity } from '../../APIEntity';
import { isApiError } from '../../ApiResponse';
import { TypeId } from '../../models/TypeId';
import type { IAgenticProcess } from '../../process/agentic-process';
import { ConnectionManager } from '../../websocket';
import {
  FlowData,
  FlowElementTypes,
  FlowEvents,
  FlowStreamProcessor,
  ShellCmdProgress,
  ShellCommandProcessor,
  ShellInputFlowData,
  ShellOutputFlowData,
} from '../../flow_processing';
import { IEntity } from '../../IEntity';
import { ActionInfo } from '../../models';
import {
  ComputeProviderType,
  type NodeStatus,
  RuntimeEnvironment,
  SANDBOX_PROVIDERS,
  type WorkspaceReady,
} from './compute-node-types';
import type { MachineStatus, ProcessInfo } from './machine-status';
import { ServiceControlError, type ServiceRuntimeDescriptor } from './service-control';
import { Shell } from '../shell';
import { PtyConnection } from '../../services/shell/ptyConnection';
import { GitWorkdir } from '../git-workdir';

/**
 * The `node_config` marker the sandbox UI writes at create time to mean "this box
 * is a workspace someone opens", as opposed to an agent's deployment box.
 */
export const WORKSPACE_FLAVOR = 'workspace';

/** Callback for when a new machine session is detected */
export type MachineSessionCallback = (sessionId: string, session: Shell) => void;

/** CLI worker kind shared across resolver APIs. */
export type WorkerKind = 'claude' | 'codex' | 'copilot' | 'opencode';

/** Descriptor returned by {@link ComputeNode.findSession} on hit. */
export interface FindSessionResult {
  session_id: string;
  worker_type: WorkerKind;
  transcript_path: string | null;
  cwd: string | null;
  project_id: string | null;
  session_name: string | null;
}

/**
 * Convert a VFS-relative path to an OS absolute path.
 * VFS paths are relative (no leading slash, no drive letter) like "Users/gadi/Flowpad workspace".
 * This function combines them with the OS root and normalizes slashes for the target OS.
 *
 * @param vfsPath - VFS-relative path (e.g., "Users/gadi/Flowpad workspace/.flow/system_skills")
 * @param root - OS filesystem root (e.g., "C:\\" on Windows, "/" on Unix)
 * @returns OS absolute path with normalized slashes
 */
export function vfsToOsPath(vfsPath: string, root: string): string {
  if (!vfsPath) return root;
  const combined = `${root}${vfsPath}`;
  // Detect OS from root: Windows roots contain backslash or colon (e.g., "C:\")
  const isWindows = root.includes('\\') || (root.length >= 2 && root[1] === ':');
  // Normalize slashes: backslash for Windows, forward slash for Unix
  return isWindows ? combined.replace(/\//g, '\\') : combined.replace(/\\/g, '/');
}

/**
 * Interface for ComputeNode entity data.
 */
export interface IComputeNode extends IEntity {
  name: string;
  runtime: RuntimeEnvironment;
  node_provider_type?: ComputeProviderType;
  node_provider_id?: string;
  node_config?: Record<string, unknown>;
  fs_storage_mount_path?: string | null;
  home_dir?: string | null;
  /** Whether the box belongs to a single person. Owner-only to change, and only
   *  through the hub's `auto-login` action — it is in the hub's
   *  `_immutable_update`, so a PUT carrying it is silently dropped. */
  auto_login?: boolean;
  /** Who the box last reported itself signed in as, cached hub-side. `null` (or
   *  absent) means "not signed in as far as the hub knows", which includes
   *  "never looked". Read-only: server-owned, never sent. */
  logged_in_user?: string | null;
}

/**
 * ComputeNode entity class.
 * Manages sandboxed execution environments for running commands and processes.
 */
@registerEntity
export class ComputeNode extends APIEntity<ComputeNode> implements IComputeNode {
  name: string = '';
  runtime: RuntimeEnvironment = { name: '' };
  node_provider_type?: ComputeProviderType;
  node_provider_id?: string;
  node_config?: Record<string, unknown>;
  fs_storage_mount_path?: string | null;
  home_dir?: string | null;
  auto_login?: boolean;
  logged_in_user?: string | null;
  static type: string = 'compute_node';

  /**
   * Frontend-only session cache.
   * Sessions are owned by this ComputeNode and represent the local view of PTY sessions.
   * This cache is reset when switching to a different ComputeNode (NOT affecting backend PTYs).
   */
  private sessions: Map<string, Shell> = new Map();

  /** Track known machine session IDs to detect new ones */
  private knownMachineSessions: Set<string> = new Set();

  /** Callback for when a new machine session is detected */
  private machineSessionCallback: MachineSessionCallback | null = null;

  /** Bound handler for WebSocket data ops (for cleanup) */
  private boundDataOpHandler:
    | ((toEntity: string, op: string, data: { active_pty_sessions?: string[] }) => void)
    | null = null;

  constructor(entity: Partial<IComputeNode> = {}) {
    super(entity);
    this.name = entity.name || '';
    this.runtime = entity.runtime || { name: '' };
    this.node_provider_type = entity.node_provider_type;
    this.node_provider_id = entity.node_provider_id;
    this.node_config = entity.node_config;
    this.fs_storage_mount_path = entity.fs_storage_mount_path ?? undefined;
    this.home_dir = entity.home_dir ?? undefined;
    // Declaring these as class fields is NOT enough to carry them. Under the
    // app's `useDefineForClassFields: true`, a declared-but-unassigned field is
    // DEFINED as `undefined` at construction — overwriting whatever `super`
    // copied off the payload. So the server sent `logged_in_user`, the entity
    // dropped it, and every card rendered "signed out". Every other field here
    // is assigned for the same reason; these two were simply missed.
    this.auto_login = entity.auto_login;
    this.logged_in_user = entity.logged_in_user;
  }

  /**
   * Resolve the singleton `@local` compute node — "this machine".
   *
   * The robust frontend counterpart to the backend `ComputeNode.get_local()`.
   * Resolution order (cheap → authoritative):
   *   1. the current context compute node, when it is the @local one
   *   2. the bootstrap-issued `default_compute_node`
   *   3. a fetch by the `@local` alias typeid (server resolves it)
   *
   * This is a READ: minting the node is a backend concern (the client cannot
   * create entities). The backend self-heals on any action that touches @local
   * — including {@link Project.getComputeNode} — so a missing row is recreated
   * server-side rather than here. Returns null only if the backend has no
   * @local node AND cannot resolve the alias (should not happen in local mode).
   */
  static async getLocal(): Promise<ComputeNode | null> {
    const { dataContext } = await import('../../FlowSync/context');
    const current = dataContext.computeNode;
    // The context node is @local unless a cloud/sandbox node is active. Treat a
    // local_machine-provider node as @local; otherwise fall through.
    if (current && current.node_provider_type === ComputeProviderType.LOCAL_MACHINE) {
      return current;
    }
    const fromBootstrap = dataContext.bootstrapInfo?.default_compute_node;
    if (fromBootstrap) {
      const node = new ComputeNode(fromBootstrap as any);
      node.markAsExpanded();
      return node;
    }
    try {
      return await dataManager.getByTypeId<ComputeNode>(new TypeId(ComputeNode.type, '@local'));
    } catch {
      return null;
    }
  }

  /**
   * Create a new idle AgenticProcess on this ComputeNode.
   *
   * @param context - Execution context (workdir, permissionMode, model, etc.)
   * @param options - Optional result metadata and watch settings
   * @returns Promise resolving to a new AgenticProcess in NEW status
   *
   * @example
   * ```typescript
   * const computeNode = await ComputeNode.getLocal();
   * const process = await computeNode.createProcess({ workdir: '/path' });
   * await process.start();
   * ```
   */
  async createProcess(
    context: import('../../process/agentic-context').AgenticContext = {},
    options?: {
      result?: { uname?: string; resultType?: string; sourceSessionId?: string };
      watchProcess?: boolean;
      visible?: boolean;
      /**
       * Transport intent for the new session: true → interactive PTY (default
       * when omitted), false → headless JSON-stream (no PTY/xterm). Omitted →
       * the backend defaults to true, preserving today's behaviour.
       */
      pty_mode?: boolean;
      /**
       * First prompt to seed onto the process's queue server-side, BEFORE the
       * visible auto-start. The worker then boots with it as its launch
       * instruction (deterministic — no post-spawn stdin race). Used by
       * {@link AgenticProcess.openTab}.
       */
      launchPrompt?: string;
    },
  ): Promise<import('../../process/agentic-process').AgenticProcess> {
    const { AgenticProcess } = await import('../../process/agentic-process');
    const { serializeAgenticContext } = await import('../../process/agentic-context');

    const action = new ActionInfo('createProcess', ComputeNode.type, this.id, 'POST');
    action.bodyParameters = {
      context: serializeAgenticContext(context),
      ...(options?.result
        ? {
            result: {
              uname: options.result.uname,
              resultType: options.result.resultType,
              sourceSessionId: options.result.sourceSessionId,
            },
          }
        : {}),
      ...(options?.visible !== undefined ? { visible: options.visible } : {}),
      ...(options?.pty_mode !== undefined ? { pty_mode: options.pty_mode } : {}),
      ...(options?.launchPrompt ? { launch_prompt: options.launchPrompt } : {}),
    };

    const response = await dataManager.callAction<unknown, IAgenticProcess>(action);

    const process = dataManager.updateEntityFromJson<import('../../process/agentic-process').AgenticProcess>(response);
    process._context = context;

    if (options?.watchProcess !== false) {
      await process.watch();
    }

    return process;
  }

  /**
   * Resolve a session id to its on-disk descriptor.
   *
   * Pure read-only lookup: never creates an AgenticProcess. Use
   * `AgenticProcess.getByWorkerId(id)` for the find+open flow.
   *
   * @param sessionId - UUID/thread id.
   * @param workerType - Optional hint to skip the other indexer.
   * @returns Descriptor on hit, `null` on 404 (session not found in either history).
   */
  async findSession(sessionId: string, workerType?: WorkerKind): Promise<FindSessionResult | null> {
    const action = new ActionInfo('findSession', ComputeNode.type, this.id, 'GET');
    action.queryParameters = {
      session_id: sessionId,
      ...(workerType ? { worker_type: workerType } : {}),
    };
    try {
      return await dataManager.callAction<void, FindSessionResult>(action);
    } catch (e) {
      if (isApiError(e) && e.response?.status === 404) return null;
      throw e;
    }
  }

  // ============================================================
  // Session Management (Frontend-only cache)
  // ============================================================

  appendSession(session: Shell): void {
    session.compute_node_id = this.id;
    this.sessions.set(session.id, session);
  }

  /**
   * Create a new shell session in this node's frontend cache.
   * @param sessionId - Unique session identifier
   * @param name - Display name for the session
   * @returns The created Shell
   */
  async createSession(sessionId: string, name: string): Promise<Shell> {
    if (this.sessions.has(sessionId)) {
      console.warn(`[ComputeNode] Session '${sessionId}' already exists`);
      return this.sessions.get(sessionId)!;
    }
    const shell = Shell.create(this, { name });
    // Override the auto-generated ID with the requested sessionId
    (shell as any).id = sessionId;
    shell.pty = new PtyConnection();
    shell.pty.computeNodeId = this.id;
    this.sessions.set(sessionId, shell);
    return shell;
  }

  /**
   * Get a session from this node's frontend cache.
   * @param sessionId - Session identifier
   * @returns ShellSession or undefined if not found
   */
  getSession(sessionId: string): Shell | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists in this node's frontend cache.
   * @param sessionId - Session identifier
   * @returns true if session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Remove a session from this node's frontend cache.
   * Note: This does NOT close the backend PTY - it only removes the frontend cache entry.
   * @param sessionId - Session identifier
   * @returns true if session was removed
   */
  removeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Re-key a session from oldId to newId, preserving Map insertion order.
   * Marks the new ID as known so the machine session watcher won't duplicate it.
   */
  rekeySession(oldId: string, newId: string): boolean {
    if (!this.sessions.has(oldId)) return false;

    const entries = Array.from(this.sessions.entries());
    this.sessions.clear();
    for (const [key, value] of entries) {
      this.sessions.set(key === oldId ? newId : key, value);
    }

    this.knownMachineSessions.delete(oldId);
    this.knownMachineSessions.add(newId);
    return true;
  }

  /**
   * Get all sessions from this node's frontend cache.
   * @returns Array of ShellSession sorted by creation time
   */
  getAllSessions(): Shell[] {
    return Array.from(this.sessions.values()).sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
      return aTime - bTime;
    });
  }

  /**
   * Clear all sessions from this node's frontend cache.
   * Note: This does NOT close backend PTYs - it only clears the frontend cache.
   * Used when switching to a different ComputeNode.
   */
  clearLocalSessions(): void {
    this.sessions.clear();
  }

  /**
   * Add a session directly to this node's frontend cache.
   * Used when syncing sessions from backend.
   * @param session - ShellSession to add
   */
  addSession(session: Shell): void {
    session.compute_node_id = this.id;
    this.sessions.set(session.id, session);
  }

  /**
   * Get the number of sessions in this node's frontend cache.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  // ============================================================
  // Machine Session WebSocket Watching
  // ============================================================

  /**
   * Start watching for machine session updates via WebSocket.
   * When new PTY sessions are detected in `active_pty_sessions`, creates local shell sessions.
   * @param onNewSession - Callback invoked when a new machine session is detected
   */
  startWatchingMachineSessions(onNewSession?: MachineSessionCallback): void {
    this.machineSessionCallback = onNewSession || null;

    // Already watching
    if (this.boundDataOpHandler) {
      return;
    }

    const manager = ConnectionManager.getInstance();
    if (!manager.connected) {
      console.warn('[ComputeNode] Cannot watch machine sessions: ConnectionManager not connected');
      return;
    }

    this.boundDataOpHandler = (toEntity: string, _op: string, data: { active_pty_sessions?: string[] }) => {
      // on_data_op emits the entity as a string (e.g. "compute_node-@local").
      // Parse it and only handle updates for this compute node.
      let parsedTypeId: TypeId;
      try {
        parsedTypeId = new TypeId(toEntity);
      } catch {
        return;
      }
      if (parsedTypeId.type !== 'compute_node' || parsedTypeId.id !== this.id) {
        return;
      }

      const activeMachineSessions = data.active_pty_sessions;
      if (!activeMachineSessions || !Array.isArray(activeMachineSessions)) {
        return;
      }

      // Find new sessions that we haven't seen before
      for (const sessionId of activeMachineSessions) {
        if (!this.knownMachineSessions.has(sessionId)) {
          this.knownMachineSessions.add(sessionId);

          // Create Shell entity for the new machine session
          const sessionName = `Terminal ${sessionId.substring(0, 8)}`;
          void this.createSession(sessionId, sessionName).then((shell) => {
            // Mark PTY as started — the PTY is already running on the backend
            shell.pty = shell.pty ?? new PtyConnection();
            shell.pty.started = true;
            shell.pty.computeNodeId = this.id;
            shell.status = 'running';

            // Notify callback if provided
            if (this.machineSessionCallback) {
              this.machineSessionCallback(sessionId, shell);
            }
          });
        }
      }
    };

    manager.on('on_data_op', this.boundDataOpHandler);
  }

  /**
   * Stop watching for machine session updates.
   */
  stopWatchingMachineSessions(): void {
    if (this.boundDataOpHandler) {
      const manager = ConnectionManager.getInstance();
      manager.off('on_data_op', this.boundDataOpHandler);
      this.boundDataOpHandler = null;
    }
    this.machineSessionCallback = null;
  }

  /**
   * Check if currently watching for machine session updates.
   */
  get isWatchingMachineSessions(): boolean {
    return this.boundDataOpHandler !== null;
  }

  /**
   * Setup the compute node provider.
   * This initializes the compute provider and sets the node_provider_id.
   * Must be called after creating/saving the node before executing commands.
   *
   * @returns Promise with provider node ID
   *
   * @example
   * ```typescript
   * const computeNode = new ComputeNode({
   *   name: 'my-node',
   *   runtime: { name: 'test' },
   *   node_provider_type: ComputeProviderType.LOCAL_MACHINE
   * });
   * await computeNode.save();
   * await computeNode.setup(); // Initialize provider
   * ```
   */
  async setup(body?: Record<string, unknown>): Promise<string> {
    const data = await this.ops<string>('setup', body);

    if (!data) {
      throw new Error('Failed to setup compute node: No response data');
    }

    // Update local provider_id from response
    this.node_provider_id = data;

    return data;
  }

  /**
   * Call one `ops/<op>` command on this node.
   *
   * THE single place a client builds an ops URL. Callers used to hand-roll
   * `new ActionInfo('ops', ...)` wherever they needed one — `use-sandboxes.ts`
   * carried its own copy and called it for eleven different commands, which is
   * why `executeCommand` below had no callers outside tests despite doing the
   * same thing. One spelling, so a change to the action name or the envelope
   * lands in one place.
   *
   * `op` mirrors the hub's command names verbatim (`compute_node_tools.py` and
   * the `ops` dispatch table), so the pair greps as a pair.
   */
  private async ops<T>(op: string, body?: Record<string, unknown>): Promise<T> {
    const action = new ActionInfo('ops', ComputeNode.type, this.id, 'POST');
    action.subpath = [op];
    if (body) action.bodyParameters = body;
    return dataManager.callAction<Record<string, unknown> | undefined, T>(action);
  }

  /**
   * Whether this node is a cloud SANDBOX — a box a person opens and works in,
   * as opposed to an agent's deployment box or the local machine.
   *
   * On the entity, not in a screen. `use-sandboxes.ts` used to answer it inline
   * by reading BOTH the provider AND a magic string out of the untyped
   * `node_config` blob, so every surface that wanted the question had to know
   * that blob's shape. The rule is one thing; it belongs in one place.
   *
   * Worth knowing before touching it: the
   * hub stopped reading `flavor` for TEMPLATE selection ("one family, one axis,
   * no client-derived input" — `setup_node`), which reads like the marker is
   * dead. It is not: the sandbox UI writes it at create time and nothing clears
   * it, so it remains the marker separating an interactive workspace from a
   * provider's other compute nodes.
   *
   * The provider field is read tolerantly because the hub spells it
   * `node_provider` and this entity types it `node_provider_type`.
   */
  get isSandbox(): boolean {
    const provider = (this as unknown as { node_provider?: string }).node_provider ?? this.node_provider_type;
    const flavor = (this.node_config as { flavor?: string } | undefined)?.flavor;
    return SANDBOX_PROVIDERS.has(provider ?? '') && flavor === WORKSPACE_FLAVOR;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  /** Start a provisioned node. */
  async startup(): Promise<void> {
    await this.ops<void>('startup');
  }

  /** Stop it for good — the provider machine goes away. */
  async shutdown(): Promise<void> {
    await this.ops<void>('shutdown');
  }

  /** Put it to sleep. Cheap to wake; the shared link wakes it on its own. */
  async pause(): Promise<void> {
    await this.ops<void>('pause');
  }

  /** Wake it. */
  async resume(): Promise<void> {
    await this.ops<void>('resume');
  }

  /**
   * What the backing machine is doing.
   *
   * Normalized server-side into one shape across providers, so this type is no
   * longer the union of one provider's fields with another's.
   */
  async status(): Promise<NodeStatus> {
    return this.ops<NodeStatus>('status');
  }

  /**
   * Bring the Flowpad app inside the box up, and sign it in.
   *
   * Returns whether it is healthy and who it ended up signed in as — the hub
   * reads that identity back from the box rather than reporting what it asked
   * for.
   */
  async workspaceReady(): Promise<WorkspaceReady> {
    return this.ops<WorkspaceReady>('workspace-ready');
  }

  // ── computeNodeTools: setting a box's projects up ────────────────────
  //
  // One method per hub command, same names. These are the composable half:
  // a box usually needs more than one project (the engagement, plus help desks
  // and context projects), so the caller sequences them rather than asking for
  // one do-everything call.

  async validateProjectName(name: string): Promise<{ available: boolean; suggested?: string }> {
    return this.ops('validate-project-name', { name });
  }

  async cloneProject(body: Record<string, unknown>): Promise<{ project?: { id: string }; path?: string }> {
    return this.ops('clone-project', body);
  }

  async initEmptyProject(name: string, projectId: string): Promise<{ project?: { id: string }; path?: string }> {
    return this.ops('init-empty-project', { name, project_id: projectId });
  }

  async indexProject(path: string, projectId: string): Promise<unknown> {
    return this.ops('index-project', { path, project_id: projectId });
  }

  async reconcileManifest(projectId: string): Promise<unknown> {
    return this.ops('reconcile-manifest', { project_id: projectId });
  }

  async attachContextProject(projectId: string, contextPath: string, scope = 'shared'): Promise<unknown> {
    return this.ops('attach-context-project', { project_id: projectId, context_path: contextPath, scope });
  }

  async setDefaultProject(projectId: string): Promise<unknown> {
    return this.ops('set-default-project', { project_id: projectId });
  }

  /**
   * Sign the box out of the cloud, clearing the credentials stored ON it.
   *
   * Deliberately NOT the same thing as turning `auto_login` off. That also
   * revokes the node-bound API key, which is a change to how the box behaves
   * from now on; this is just "end the session that is running in there", and
   * leaves the setting alone. The consequence is worth knowing: with
   * `auto_login` on, the next open signs the box straight back in — which is the
   * correct behaviour for "log me out of it now", not a gap.
   *
   * Signing the box out never touches the caller's OWN hub session: the
   * credentials live on the box's disk, and this asks the box to clear them.
   */
  async logoutUser(): Promise<unknown> {
    return this.ops('logout-user');
  }

  /** Who the box is signed in as, asked of the box itself. The cached
   *  `logged_in_user` field is the cheap answer; this is the authoritative one
   *  and costs a round-trip to a machine that may be paused. */
  async loginStatus(): Promise<{ logged_in: boolean; logged_in_user?: string | null }> {
    return this.ops('login-status');
  }

  /**
   * Execute a shell command on this compute node.
   * @param input - ShellInputFlowData with command and session info
   * @returns Promise with ShellOutputFlowData result
   *
   * @example
   * ```typescript
   * const computeNode = await flow.getComputeNode();
   * const input = new ShellInputFlowData('ls -la', 'cmd_123', 'flow-shell');
   *
   * const output = await computeNode.executeCommand(input);
   * // output contains stdout, stderr, and exit_code
   * ```
   */
  async executeCommand(input: ShellInputFlowData): Promise<ShellOutputFlowData> {
    const action = new ActionInfo('ops', ComputeNode.type, this.id, 'POST', true);
    action.subpath = 'command';
    action.bodyParameters = {
      command: input.command,
      session_id: input.sessionId,
    };

    const response = await dataManager.callAction(action);
    const data = (response as Record<string, unknown>).data || response;

    if (!data) {
      throw new Error('No response from command execution');
    }

    // Parse XML response using FlowStreamProcessor
    const processor = new FlowStreamProcessor();
    const output = new ShellOutputFlowData();

    processor.on(FlowEvents.DATA_END, (flowData: FlowData) => {
      if (flowData.elementType === FlowElementTypes.SHELL_OUTPUT) {
        const channel = flowData.channel;
        const content = flowData.content;

        if (channel === 'stdout') {
          output.appendStdout(content);
        } else if (channel === 'stderr') {
          output.appendStderr(content);
        }

        // Check if this is the final chunk
        if (flowData.isFinal) {
          const exitCode = parseInt(flowData.attributes['exit-code'] || '0', 10);
          output.markComplete(exitCode);
        }
      }
    });

    processor.process_chunk(data as string);

    return output;
  }

  /**
   * Execute a shell command with streaming output.
   * @param input - ShellInputFlowData with command and session info
   * @param onCmdProgress - Optional callback for progress updates
   * @returns Promise that resolves when command completes
   */
  async executeCommandStreaming(
    input: ShellInputFlowData,
    onCmdProgress?: (progress: ShellCmdProgress) => void,
  ): Promise<void> {
    const abortController = new AbortController();
    const action = new ActionInfo(
      'ops',
      ComputeNode.type,
      this.id,
      'POST',
      false, // isRawResponse
      true, // isStreaming
      abortController.signal,
    );
    action.subpath = 'command';
    action.bodyParameters = {
      command: input.command,
      session_id: input.sessionId,
      stream: true, // Enable streaming
    };

    // Use dataManager to get streaming response
    const response = await dataManager.callAction<typeof action.bodyParameters, Response>(action);

    if (!response) {
      throw new Error('No response from API');
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (!response.body) {
      throw new Error('CMD Response body is null - server may not support streaming');
    }

    // Get reader for stream processing
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();

    // ShellCommandProcessor processes and reports FlowData elements via progress callback
    await ShellCommandProcessor.processCmdStream(reader, onCmdProgress, abortController);
  }

  // ============================================================
  // Service Control Methods
  // ============================================================

  /**
   * Run a simple shell command and return stdout.
   * @param command - Shell command to execute
   * @returns stdout from the command
   */
  private async runShell(command: string): Promise<string> {
    const input = new ShellInputFlowData(command, 'service-control');
    const output = await this.executeCommand(input);
    return output.stdout;
  }

  /**
   * Get machine status (processes and network connections) from the compute node.
   * @returns MachineStatus with processes and network info
   */
  async getMachineStatus(): Promise<MachineStatus> {
    const action = new ActionInfo('get-machine-status', ComputeNode.type, this.id);
    return await dataManager.callAction<void, MachineStatus>(action);
  }

  /**
   * Get the process info for an ephemeral local service descriptor.
   * @returns ProcessInfo if service is running, null otherwise
   */
  async getArtifactProcess(service: ServiceRuntimeDescriptor): Promise<ProcessInfo | null> {
    if (!service.port) {
      throw new ServiceControlError('Service has no port defined', service.id || '', 'get');
    }

    const port = parseInt(service.port, 10);
    const status = await this.getMachineStatus();

    // Find network connection by port
    const connection = status.network.find((conn) => conn.port === port);
    if (!connection) {
      return null;
    }

    // Find process by PID
    const process = status.processes.find((proc) => proc.pid === connection.pid);
    return process || null;
  }

  /**
   * Stop the process running an ephemeral local service.
   * @returns ProcessInfo of the killed process
   * @throws ServiceControlError if service is not running or kill fails
   */
  async stopArtifactProcess(service: ServiceRuntimeDescriptor): Promise<ProcessInfo> {
    const process = await this.getArtifactProcess(service);
    if (!process) {
      throw new ServiceControlError(`Service on port ${service.port} is not running`, service.id || '', 'stop');
    }

    // Kill the process
    const killResult = await this.runShell(`kill ${process.pid}`);
    if (killResult.includes('No such process')) {
      throw new ServiceControlError(`Failed to kill process ${process.pid}: No such process`, service.id || '', 'stop');
    }

    return process;
  }

  /**
   * Start an ephemeral local service using its start command.
   * @param maxWaitMs - Maximum time to wait for service to start (default: 30000)
   * @param pollIntervalMs - Interval between status checks (default: 1000)
   * @returns ProcessInfo of the started process
   * @throws ServiceControlError if start_cmd is missing or service fails to start
   */
  async startArtifactProcess(
    service: ServiceRuntimeDescriptor,
    maxWaitMs: number = 30000,
    pollIntervalMs: number = 1000,
  ): Promise<ProcessInfo> {
    if (!service.start_cmd) {
      throw new ServiceControlError('Service has no start command defined', service.id || '', 'start');
    }

    if (!service.port) {
      throw new ServiceControlError('Service has no port defined', service.id || '', 'start');
    }

    // Run start command in background (nohup + &)
    const startCmd = `nohup ${service.start_cmd} > /dev/null 2>&1 &`;
    await this.runShell(startCmd);

    // Poll until service is running or timeout
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const process = await this.getArtifactProcess(service);
      if (process) {
        return process;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new ServiceControlError(`Service failed to start within ${maxWaitMs}ms`, service.id || '', 'start');
  }

  /**
   * Restart an ephemeral local service (stop then start).
   * @param maxWaitMs - Maximum time to wait for service to start (default: 30000)
   * @returns ProcessInfo of the new process
   * @throws ServiceControlError if stop or start fails
   */
  async restartArtifactProcess(service: ServiceRuntimeDescriptor, maxWaitMs: number = 30000): Promise<ProcessInfo> {
    // Stop if running (ignore error if not running)
    try {
      await this.stopArtifactProcess(service);
      // Wait a moment for port to be released
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      // Ignore "not running" errors, rethrow others
      if (error instanceof ServiceControlError && error.operation === 'stop') {
        // Service wasn't running, that's fine
      } else {
        throw error;
      }
    }

    // Start the service
    return this.startArtifactProcess(service, maxWaitMs);
  }

  // ============================================================
  // JSON File Operations
  // ============================================================

  /**
   * Read a JSON file from the compute node filesystem.
   * @param path - Absolute path to the JSON file
   * @returns Parsed JSON data
   */
  async getJsonFile<T = unknown>(path: string): Promise<T> {
    const action = new ActionInfo('get-json-file', ComputeNode.type, this.id, 'GET');
    action.queryParameters = { path };
    const response = await dataManager.callAction(action);
    // Extract data from ApiSuccessResponse wrapper
    const data = (response as Record<string, unknown>).data || response;
    return data as T;
  }

  /**
   * Write JSON data to a file on the compute node filesystem.
   * @param path - Absolute path to the JSON file
   * @param data - JSON data to write
   */
  async saveJsonFile(path: string, data: unknown): Promise<void> {
    const action = new ActionInfo('save-json-file', ComputeNode.type, this.id, 'POST');
    action.bodyParameters = { path, data };
    await dataManager.callAction(action);
  }

  /**
   * Clear all in-memory PTY state on the server for this compute node.
   * Mimics a server restart: wipes session_manager, replay_buffer, and
   * provider _pty_sessions. Shell DB entities are untouched; _open_shell
   * will detect the dead PTY via is_pty_alive() on the next resume().
   * @returns number of sessions cleared
   */
  async resetPty(): Promise<number> {
    const action = new ActionInfo('reset-pty', ComputeNode.type, this.id, 'POST');
    const response = await dataManager.callAction<void, { cleared: number }>(action);
    return (response as any)?.data?.cleared ?? 0;
  }

  /**
   * Get the current working directory (runs `pwd`).
   */
  async getCwd(): Promise<string> {
    const action = new ActionInfo('get-cwd', ComputeNode.type, this.id);
    const response = await dataManager.callAction<void, { cwd: string }>(action);
    return response?.cwd ?? '';
  }

  /**
   * Open a native OS folder-picker dialog and return the selected path.
   * Returns null if the user cancelled.
   */
  async openPathDialog(initialDir?: string, mode: 'folder' | 'file' = 'folder'): Promise<string | null> {
    const action = new ActionInfo('pick-folder', ComputeNode.type, this.id, 'POST');
    action.bodyParameters = { ...(initialDir ? { initial_dir: initialDir } : {}), mode };
    const response = await dataManager.callAction<void, { path: string | null }>(action);
    return (response as any)?.path ?? null;
  }

  /**
   * Create a workdir-bound git ops helper for this compute node.
   * @param workDir - Absolute path to the working directory
   */
  git(workDir: string): GitWorkdir {
    return new GitWorkdir(workDir, this.id);
  }

  /** Which of a project's declared secrets this node may see: `{project_id: [ENV_VAR]}`.
   *  Value-free — the token IS the env var name. An ABSENT project key means
   *  ALL of that project's secrets (an uncurated node is unrestricted). */
  attached_secrets: Record<string, string[]> = {};

  private secretAction<T>(name: string, body: Record<string, unknown>): Promise<T | null> {
    const action = new ActionInfo(name, ComputeNode.type, this.id, 'POST');
    action.bodyParameters = body;
    return dataManager.callAction<unknown, T>(action) as Promise<T | null>;
  }

  /** Every declared secret on the project, flagged attached or not.
   *  `all_attached` is true when nothing has been curated yet, so the UI can
   *  show every row checked without pretending someone chose them. */
  async listAttachedSecrets(projectId: string): Promise<{
    project_id: string;
    all_attached: boolean;
    secrets: { env_var: string; attached: boolean }[];
  } | null> {
    return this.secretAction('list-attached-secrets', { project_id: projectId });
  }

  async attachSecret(projectId: string, envVar: string): Promise<void> {
    await this.secretAction('attach-secret', { project_id: projectId, env_var: envVar });
  }

  async detachSecret(projectId: string, envVar: string): Promise<void> {
    await this.secretAction('detach-secret', { project_id: projectId, env_var: envVar });
  }

  /** Attach everything the project declares RIGHT NOW — a snapshot, not a
   *  standing wildcard. */
  async attachAllSecrets(projectId: string): Promise<void> {
    await this.secretAction('attach-all-secrets', { project_id: projectId });
  }
}
