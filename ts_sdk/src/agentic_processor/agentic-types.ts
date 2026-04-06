/**
 * Shared types for AgenticProcessor and AgenticProcess.
 *
 * Extracted to break circular dependency:
 *   agentic-process -> agentic-processor -> agentic-process
 *
 * Both modules now import these types from agentic-types instead.
 */

/**
 * Processor execution status enum.
 *
 * File-level (no transcript):
 *   NULL         — JSONL file does not exist
 *   EMPTY        — JSONL exists but has no parseable content
 *
 * Workflow default:
 *   IDLE         — process created, no Claude session linked yet
 *
 * Terminal (session ended, cannot resume):
 *   COMPLETE     — finished cleanly (end_turn / last-prompt)
 *   ERROR        — abnormal end (stop_sequence / crash)
 *   INTERRUPTED  — user interrupted (Escape / Ctrl-C)
 *   INACTIVE     — stale file >5 min with no terminal signal (assumed dead)
 *
 * Active (transcript-derivable):
 *   WAITING      — user message received, Claude has not yet responded
 *   THINKING     — assistant streaming / generating text
 *   TOOL_CALL    — Claude finished its turn and dispatched tool(s)
 *   TOOL_RUNNING — tool is actively executing (progress events)
 *
 * Workflow-level (legacy — no longer set by ProcessorState):
 *   RUNNING, PAUSED, STEPPING
 *
 * Use isProcessorRunning() to aggregate all active states.
 */
export enum ProcessorStatus {
  // No transcript
  NULL         = 'null',
  EMPTY        = 'empty',

  // Workflow default
  IDLE         = 'idle',

  // Terminal
  COMPLETE     = 'complete',
  ERROR        = 'error',
  INTERRUPTED  = 'interrupted',
  INACTIVE     = 'inactive',

  // Active
  WAITING      = 'waiting',
  THINKING     = 'thinking',
  TOOL_CALL    = 'tool_call',
  TOOL_RUNNING = 'tool_running',

  // Workflow-level
  RUNNING      = 'running',
  PAUSED       = 'paused',
  STEPPING     = 'stepping',
}

const RUNNING_STATUSES = new Set<ProcessorStatus>([
  ProcessorStatus.WAITING,
  ProcessorStatus.THINKING,
  ProcessorStatus.TOOL_CALL,
  ProcessorStatus.TOOL_RUNNING,
  ProcessorStatus.RUNNING,
  ProcessorStatus.PAUSED,
  ProcessorStatus.STEPPING,
]);

const BUSY_STATUSES = new Set<ProcessorStatus>([
  ProcessorStatus.THINKING,
  ProcessorStatus.TOOL_CALL,
  ProcessorStatus.TOOL_RUNNING,
  ProcessorStatus.RUNNING,
]);

const TERMINAL_STATUSES = new Set<ProcessorStatus>([
  ProcessorStatus.COMPLETE,
  ProcessorStatus.ERROR,
  ProcessorStatus.INTERRUPTED,
  ProcessorStatus.INACTIVE,
]);

/** True for any active state (WAITING, THINKING, TOOL_CALL, TOOL_RUNNING, RUNNING, PAUSED, STEPPING). */
export function isProcessorRunning(status: ProcessorStatus): boolean {
  return RUNNING_STATUSES.has(status);
}

/** True when actively processing (THINKING, TOOL_CALL, TOOL_RUNNING, RUNNING). Excludes WAITING/PAUSED/STEPPING. */
export function isProcessorBusy(status: ProcessorStatus): boolean {
  return BUSY_STATUSES.has(status);
}

/** True when not active (NULL, EMPTY, IDLE, COMPLETE, ERROR, INTERRUPTED, INACTIVE). */
export function isProcessorIdle(status: ProcessorStatus): boolean {
  return !RUNNING_STATUSES.has(status);
}

/** True when the session has ended and cannot be resumed (COMPLETE, ERROR, INTERRUPTED, INACTIVE). */
export function isProcessorTerminal(status: ProcessorStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * UI Component payload from flow-ui instruction
 */
export interface UIComponentPayload {
  ui_id: string;
  uri?: string;
  page?: string;
  params: Record<string, unknown>;
  schema?: Record<string, unknown>;
  blocking: boolean;
  content?: string;
}

/**
 * Parsed UI URI components
 */
export interface ParsedUIUri {
  /** Entity VFS path (e.g., "compute_node-@local/.flow/system_skills/onboarding") */
  entityVfs: string;
  /** Page name (e.g., "index") */
  page?: string;
  /** Component name (e.g., "hello-flowpad") */
  component?: string;
}

/**
 * Parse a UI URI into its components.
 *
 * URI format: ui://<entity_vfs>?page=<page>&component=<component>
 *
 * @param uri - The URI to parse (e.g., "ui://compute_node-@local/.flow/system_skills/onboarding?page=index&component=hello-flowpad")
 * @returns Parsed URI components
 */
export function parseUIUri(uri: string): ParsedUIUri {
  // Strip ui:// prefix
  const withoutProtocol = uri.replace(/^ui:\/\//, '');
  const [entityPart, queryPart] = withoutProtocol.split('?');

  const params = new URLSearchParams(queryPart || '');
  return {
    entityVfs: entityPart,
    page: params.get('page') || undefined,
    component: params.get('component') || undefined,
  };
}
