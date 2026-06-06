/**
 * Shared status and UI types for AgenticProcess.
 *
 * ## Two-axis status model
 *
 * ``ProcessStatus`` — **app/user-level lifecycle** of the process container.
 * Backend-owned FSM. Stored. Transitions are explicit (writers in
 * ``flow_sdk/builtin/agentic_process/agentic_process.py``):
 *     NEW → STARTING → RUNNING → STOPPING → STOPPED,  any → FAILED.
 *
 * ``WorkerStatus`` — **expert-level state of the worker** running inside the
 * process (Claude Code session). Derived from the JSONL transcript on every
 * serialize via ``_tail_status`` in ``flow_sdk/fs_records/agent_status.py``;
 * never stored. Only meaningful when ``ProcessStatus ∈ {RUNNING, STOPPING,
 * STOPPED}`` — in any other lifecycle state, treat as undefined.
 *
 * ## Invariants
 *
 * - ``_RUNNING_STATUSES`` (Python) and ``WORKER_RUNNING_STATUSES`` (here) are
 *   byte-for-byte identical, verified by a contract test against
 *   ``test_fixtures/status_sets.json``.
 * - ``isReadyForInput(process)`` is the single canonical "can the user send now?"
 *   predicate. There is no stored ``waiting_for_prompt`` or ``is_active`` field.
 */

/**
 * App/user-level lifecycle of the AgenticProcess container.
 *
 * Backend-owned. Stored. Transitions are explicit (no derivation).
 */
export enum ProcessStatus {
  NEW = 'new',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  FAILED = 'failed',
}

const RUNNING_PROCESS_STATUSES = new Set<ProcessStatus>([
  ProcessStatus.STARTING,
  ProcessStatus.RUNNING,
  ProcessStatus.STOPPING,
]);

const STARTABLE_PROCESS_STATUSES = new Set<ProcessStatus>([
  ProcessStatus.NEW,
  ProcessStatus.STOPPED,
  ProcessStatus.FAILED,
]);

/** True while the process container is running (STARTING/RUNNING/STOPPING). */
export function isProcessRunning(status: ProcessStatus): boolean {
  return RUNNING_PROCESS_STATUSES.has(status);
}

/** @deprecated Use ``isProcessRunning``. Kept as an alias during the rename sweep. */
export const isProcessActive = isProcessRunning;

/** True when ``start()`` can be invoked (NEW/STOPPED/FAILED). */
export function isProcessStartable(status: ProcessStatus): boolean {
  return STARTABLE_PROCESS_STATUSES.has(status);
}

/**
 * Expert-level state of the worker running inside the process.
 *
 * Mirrors the Python ``WorkerStatus`` enum in ``flow_sdk/fs_records/agent_status.py``.
 * Arrives on the wire as the ``worker_status`` field on ``AgenticProcess``.
 *
 * Only meaningful when ``ProcessStatus ∈ {RUNNING, STOPPING, STOPPED}``.
 */
export enum WorkerStatus {
  /** Worker spun up; transcript not yet materialised. Replaces the former INIT + EMPTY split. */
  INITIALIZING = 'initializing',
  /** Workflow default — no Claude session linked yet; ready for input. */
  IDLE         = 'idle',
  /** Terminal — finished cleanly (end_turn / last-prompt). */
  COMPLETE     = 'complete',
  /** Terminal — abnormal end (stop_sequence / crash). */
  ERROR        = 'error',
  /** Terminal — user interrupted (Escape / Ctrl-C). */
  INTERRUPTED  = 'interrupted',
  /** Terminal — stale file >5 min with no terminal signal. */
  INACTIVE     = 'inactive',
  /** Active — user message received; Claude hasn't responded yet. */
  WAITING      = 'waiting',
  /** Active — assistant generating. */
  THINKING     = 'thinking',
  /** Active — Claude dispatched tool(s). */
  TOOL_CALL    = 'tool_call',
  /** Active — tool is executing (progress events). */
  TOOL_RUNNING = 'tool_running',
  /** Active — Anthropic API error, Claude is retrying mid-turn. */
  API_ERROR    = 'api_error',
  /** Terminal — JSONL stalled in WAITING, needs intervention. */
  API_TIMEOUT  = 'api_timeout',
  /** Parse fallback — last JSONL entry did not match any known pattern. Replaces the former RUNNING catchall. */
  UNKNOWN      = 'unknown',
}

const WORKER_RUNNING_STATUSES = new Set<WorkerStatus>([
  WorkerStatus.WAITING,
  WorkerStatus.THINKING,
  WorkerStatus.TOOL_CALL,
  WorkerStatus.TOOL_RUNNING,
  WorkerStatus.API_ERROR,
]);

const WORKER_TERMINAL_STATUSES = new Set<WorkerStatus>([
  WorkerStatus.COMPLETE,
  WorkerStatus.ERROR,
  WorkerStatus.INTERRUPTED,
  WorkerStatus.INACTIVE,
  WorkerStatus.API_TIMEOUT,
]);

const READY_WORKER_STATUSES = new Set<WorkerStatus>([
  WorkerStatus.IDLE,
  WorkerStatus.COMPLETE,
  WorkerStatus.INTERRUPTED,
]);

/** True while the worker is mid-turn (WAITING/THINKING/TOOL_CALL/TOOL_RUNNING/API_ERROR). */
export function isWorkerRunning(status: WorkerStatus): boolean {
  return WORKER_RUNNING_STATUSES.has(status);
}

/** True when the worker turn has ended and cannot be resumed in place. */
export function isWorkerTerminal(status: WorkerStatus): boolean {
  return WORKER_TERMINAL_STATUSES.has(status);
}

/**
 * True when the worker has started (has some transcript beyond INITIALIZING)
 * and is not in the ready-for-input baseline. Used to gate operations like
 * "fork" that are only sensible after at least one turn has happened.
 */
export function hasWorkerStarted(status: WorkerStatus): boolean {
  return status !== WorkerStatus.INITIALIZING;
}

/**
 * Minimal shape for ``isReadyForInput`` / ``getDisplayStatus`` / ``getWorkerMode`` callers.
 * Avoids coupling to the full ``AgenticProcess`` class.
 */
export interface StatusBearingProcess {
  status?: ProcessStatus | string;
  workerStatus?: WorkerStatus | string;
  worker_status?: WorkerStatus | string;
  session_id?: string | null;
  /** Router for ``WorkerMode`` — true when the process has an attached PTY. */
  visible?: boolean;
}

/**
 * Which mode the worker is currently running in.
 *
 * Derived from ``visible``; not stored as its own field. The routing is:
 * - ``visible === true``  → ``Interactive`` (PTY worker, xterm in the dock)
 * - ``visible === false`` → ``CLI`` (headless ``claude -p`` subprocess per turn)
 *
 * ``session_id`` survives both directions — both modes write the same
 * ``~/.claude/projects/<encoded-cwd>/<sid>.jsonl``. Switching is therefore
 * two-way: opening a shell tab flips ``visible=true`` (via ``/open``);
 * closing the tab flips it back (via ``/close``).
 */
export enum WorkerMode {
  Interactive = 'interactive',
  CLI         = 'cli',
}

/**
 * Symbolic icon identifier for an AgenticProcess. The TS SDK can't import
 * React components, so this is the contract: process exposes a key, the UI
 * resolves it to a concrete React icon via a registry (see
 * ``ui/src/components/icons/process-icons.ts``).
 *
 * Two axes:
 * - **vendor**: which CLI worker (`claude`, `codex`, `copilot`, generic fallback)
 * - **state**: `fresh` (this process started a new session) vs `restored`
 *   (this process resumed a prior `session_id`)
 */
export type ProcessIconKey =
  | 'claude'
  | 'claude-restore'
  | 'codex'
  | 'codex-restore'
  | 'copilot'
  | 'copilot-restore'
  | 'generic'
  | 'generic-restore';

/** Derive the worker mode from the process' ``visible`` field. */
export function getWorkerMode(p: StatusBearingProcess): WorkerMode {
  return p.visible ? WorkerMode.Interactive : WorkerMode.CLI;
}

function resolveStatus(p: StatusBearingProcess): ProcessStatus | undefined {
  return (p.status as ProcessStatus) ?? undefined;
}

function resolveWorkerStatus(p: StatusBearingProcess): WorkerStatus | undefined {
  const w = p.workerStatus ?? p.worker_status;
  return (w as WorkerStatus) ?? undefined;
}

/**
 * Single canonical "can the caller send a new user prompt?" predicate.
 *
 * Contract (mirrored by the Python ``is_ready_for_input`` in
 * ``flow_sdk/builtin/agentic_process/status_predicates.py``):
 *
 *     status == RUNNING  AND  workerStatus ∈ {IDLE, COMPLETE, INTERRUPTED}
 *
 * Special case: if ``workerStatus`` is missing and ``session_id`` is falsy,
 * treat as ready (process is live but never been prompted).
 */
export function isReadyForInput(p: StatusBearingProcess): boolean {
  if (resolveStatus(p) !== ProcessStatus.RUNNING) return false;
  const worker = resolveWorkerStatus(p);
  if (worker === undefined) return !p.session_id;
  return READY_WORKER_STATUSES.has(worker);
}

/**
 * UX-level "cannot accept input right now" flag — the negation of
 * ``isReadyForInput``. Surfaces that need a single boolean to gate input
 * fields, show a busy spinner, or drive a shortcut condition should use this.
 *
 * Covers every non-ready state: worker mid-turn (THINKING / TOOL_* / …),
 * process not yet RUNNING (NEW / STARTING), STOPPING, terminal, or errored.
 */
export function isBusy(p: StatusBearingProcess): boolean {
  return !isReadyForInput(p);
}

/**
 * Pick the right status to display for a given process:
 * - when the process is in a running lifecycle state, surface the fine-grained ``workerStatus``
 * - otherwise, surface the coarse ``status``
 *
 * Extracts the pattern that used to live inline at ``TabbedTerminal.tsx:118``
 * so every surface renders the same way.
 */
export function getDisplayStatus(p: StatusBearingProcess): ProcessStatus | WorkerStatus | undefined {
  const status = resolveStatus(p);
  if (status === undefined) return undefined;
  if (isProcessRunning(status)) {
    const worker = resolveWorkerStatus(p);
    if (worker !== undefined && worker !== WorkerStatus.UNKNOWN) return worker;
    return status;
  }
  return status;
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
