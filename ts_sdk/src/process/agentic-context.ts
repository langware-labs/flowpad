/**
 * AgenticContext - Execution context for AgenticProcess
 *
 * Frontend DTO for passing execution parameters to the backend.
 * Note: compute_node_id is NOT passed from frontend - it's a security-sensitive
 * field managed internally by the backend process runtime.
 */

import type { ProcessKind } from './process-types';

/**
 * Permission mode for instruction execution. Mirrors Claude Code's
 * `--permission-mode` values plus the legacy app aliases.
 * - 'bypassPermissions': Skip permission checks (for automated execution)
 * - 'askUser': Prompt user for permission on sensitive operations
 * - 'plan': Read-only plan mode — model produces a plan, cannot edit files
 * - 'acceptEdits': Auto-apply file edits, still gate other sensitive ops
 */
export type PermissionMode = 'bypassPermissions' | 'askUser' | 'plan' | 'acceptEdits';

/**
 * Context for AgenticProcess execution.
 *
 * Provides optional configuration for running instruction files.
 * The compute node is managed by the backend process runtime (not passed from frontend).
 *
 * @example
 * ```typescript
 * const context: AgenticContext = {
 *   workdir: '/path/to/workdir',
 *   model: 'claude-sonnet-4-20250514',
 *   projectId: 'project-123',
 * };
 * ```
 */
export interface AgenticContext {
  /** Additional instructions to prepend to execution */
  instructions?: string;

  /** Working directory for file operations */
  workdir?: string;

  /** Environment variables for command execution */
  envVars?: Record<string, string>;

  /** LLM model to use for agentic computation */
  model?: string;

  /** Maximum thinking tokens for extended reasoning */
  maxThinkingTokens?: number;

  /** Permission mode for sensitive operations */
  permissionMode?: PermissionMode;

  /** Project ID to associate the process with (for project-scoped queries) */
  projectId?: string;

  /** Session ID to resume - worker will continue this session */
  resumeSessionId?: string;

  /** When true with resumeSessionId, forks the session instead of resuming in-place */
  forkSession?: boolean;

  /** Claude Code --agents spec: sub-agent definitions keyed by name */
  agentsJson?: Record<string, Record<string, unknown>>;

  /** Enable Claude Code --chrome flag */
  chrome?: boolean;

  /** Enable Claude Code --debug flag (writes debug logs to ~/.claude/debug/) */
  debug?: boolean;

  /** Enable Claude Code --worktree flag (runs in an isolated git worktree) */
  worktree?: boolean;

  /** Extra directories to expose to Claude via --add-dir */
  additionalDirs?: string[];

  /** Mount the Flowpad Assistant skills/agents for this worker (sets the
   * per-process `load_flowpad_assistant` flag BEFORE the auto-start, so the
   * driver's `--add-dir` set includes the assistant). Lets a worker run in the
   * conversation's *own* project while still discovering the assistant skills —
   * no need to switch the cwd to the `@flowpad_assistant` system project. */
  loadFlowpadAssistant?: boolean;

  /** Provenance links stamped onto the new process's `shared_context_entities`
   * (string TypeIds) before save — e.g. the anchor FlowMessage a conversation
   * session is started from. */
  sharedContextEntities?: string[];

  /** VFS path the process is keyed to. Either an entity TypeId ("type-id") for entity-scoped processes, or "<typeid>/<sub_path>" for surface-scoped processes (e.g. a per-doc process keyed on the file path). */
  targetVfsPath?: string;

  /** One of "text" | "json" | "stream-json"; omit for CLI default. When
   * "stream-json", the process runs print-mode (no PTY) and `AgenticProcess.prompt`
   * streams per-event FlowData over HTTP. */
  outputFormat?: string;

  /** Backend worker (`'claude_code'` | `'codex'` | `'copilot'`). Default: backend's
   * `FLOWPAD_DEFAULT_WORKER` (typically claude). Surfaced so the UI can
   * launch alternate CLI tabs from the same opener flow. */
  workerType?: 'claude_code' | 'codex' | 'copilot';

  /** Discriminates how this process is being used (chat vs execution). */
  processType?: ProcessKind;
}

/**
 * Named alias for AgenticContext — typed entrypoint for AgenticProcess.spawn().
 */
export interface IAgenticProcessOptions extends AgenticContext {
  /** Parent entities to scope this process under (e.g. a Workflow TypeId) */
  scope?: import('../models/TypeId').TypeId[];
  /** False=direct PTY spawn (default), True=legacy zsh intermediary. */
  shellMode?: boolean;
}

/**
 * Controls how AgenticProcess.spawn() activates the process after creation.
 */
export interface ISpawnWorkerOptions {
  /** PTY shell mode: passed to process.start({ instruction }). Absent = open plain shell. */
  instruction?: string;
  /** True = headless mode: watch() + executeInstruction(). Default: false (PTY). */
  headless?: boolean;
  /** For headless mode. Default: false. */
  sync?: boolean;
  /** Custom worker session ID for headless mode. */
  workerSessionId?: string;
  /** Show process in tabs view (forwarded to CreateProcessOptions). */
  visible?: boolean;
  /** ProcessResult child metadata (forwarded to CreateProcessOptions). */
  result?: { uname?: string; resultType?: string; sourceSessionId?: string };
  /** Forwarded to createProcess(). Default: true. */
  watchProcess?: boolean;
  /** WS request timeout ms for shell.attachPty() (default: 30 000). */
  ptyTimeout?: number;
}

/**
 * Serialize AgenticContext to backend-compatible format.
 *
 * Converts camelCase properties to snake_case for Python backend.
 * Note: compute_node_id is NOT serialized - it's managed by the backend process runtime.
 *
 * @param ctx - AgenticContext to serialize
 * @returns Record suitable for REST API body
 */
export function serializeAgenticContext(ctx: AgenticContext): Record<string, unknown> {
  return {
    instructions: ctx.instructions,
    workdir: ctx.workdir,
    env_vars: ctx.envVars || {},
    model: ctx.model,
    max_thinking_tokens: ctx.maxThinkingTokens ?? 1024,
    permission_mode: ctx.permissionMode ?? 'bypassPermissions',
    project_id: ctx.projectId,
    resume_session_id: ctx.resumeSessionId,
    fork_session: ctx.forkSession,
    agents_json: ctx.agentsJson,
    chrome: ctx.chrome,
    debug: ctx.debug,
    worktree: ctx.worktree,
    additional_dirs: ctx.additionalDirs ?? [],
    load_flowpad_assistant: ctx.loadFlowpadAssistant,
    shared_context_entities: ctx.sharedContextEntities,
    target_typeid_str: ctx.targetVfsPath,
    output_format: ctx.outputFormat,
    worker_type: ctx.workerType,
    process_type: ctx.processType,
  };
}
