/**
 * AgenticContext - Execution context for AgenticProcess
 *
 * Frontend DTO for passing execution parameters to the backend.
 * Note: compute_node_id is NOT passed from frontend - it's a security-sensitive
 * field managed internally by the backend process runtime.
 */

/**
 * Permission mode for instruction execution
 * - 'bypassPermissions': Skip permission checks (for automated execution)
 * - 'askUser': Prompt user for permission on sensitive operations
 */
export type PermissionMode = 'bypassPermissions' | 'askUser';

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
  };
}
