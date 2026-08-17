/**
 * Shared status and UI types for AgenticProcess.
 *
 * ## Status model (all logic backend-side; the frontend is read-only)
 *
 * ``ProcessStatus`` — the **lifecycle "what it means"** status, shared identically
 * across every worker vendor. A small FSM
 * (NEW → STARTING → RUNNING → STOPPING → STOPPED, any → FAILED), emitted verbatim
 * on the wire (``RUNNING`` and all — no projection). The wire carries NEW /
 * STARTING / RUNNING / STOPPING / STOPPED / FAILED.
 *
 * ``busy`` — the **separate, orthogonal** "is a turn in flight?" boolean, derived
 * backend-side (``status_predicates.is_turn_busy``) and serialized as its own
 * field. This is the single value the UI gates input and the pty-mode
 * (xterm ⇄ chat) switch on — see ``isBusy``. It is NOT folded into ``status``.
 *
 * ``WorkerStatus`` — the raw **"what we found"** state of the worker, in worker
 * lingo. Derived from the vendor transcript tail on every serialize; never
 * stored; nullable on the wire when nothing was found. Only meaningful when the
 * process is live. Used for the fine-grained activity indicator, never to gate
 * input (that is ``busy``'s job).
 *
 * ## Invariants
 *
 * - ``WORKER_RUNNING_STATUSES`` / ``WORKER_BUSY_STATUSES`` (here) are byte-for-byte
 *   identical to their Python counterparts, verified by a contract test against
 *   ``test_fixtures/status_sets.json``.
 * - ``isBusy(process)`` ⇔ ``process.busy`` is the single canonical "the user must
 *   wait" predicate. ``isReadyForInput`` combines ``!busy`` with the lifecycle
 *   states that can accept a prompt or transport switch (RUNNING, fresh headless,
 *   or headless-idle). The two are disjoint by construction. There is no
 *   worker-status-derived gating in the frontend.
 */

/**
 * Lifecycle "what it means" status of the AgenticProcess. Backend-owned, emitted
 * verbatim on the wire (RUNNING included — no ready/busy projection). "Is a turn
 * in flight?" is the separate ``busy`` boolean (see ``isBusy``).
 */
/**
 * The CLI worker vendors a process can run.
 *
 * ONE spelling, in the SDK, because the app currently carries several
 * incompatible ones — `'claude'` vs `'claude_code'`, with and without
 * `'workflow'`, with and without `'opencode'` — and picking the wrong union at a
 * call site silently yields `undefined` rather than an error (the app's
 * `type-check` script is a no-op, so nothing catches it).
 *
 * New vendors add a member HERE; every signature that accepts a vendor should
 * reference this rather than re-spelling the union inline.
 */
export type WorkerType = 'claude_code' | 'codex' | 'copilot' | 'opencode';

export enum ProcessStatus {
  NEW = 'new',
  STARTING = 'starting',
  /** Live container. Turn-in-flight is the orthogonal ``busy`` boolean. */
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  FAILED = 'failed',
}

/**
 * Live process states on the wire — the stored/emitted RUNNING plus the
 * STARTING/STOPPING bookends.
 */
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

/** True while the process container is live (STARTING/RUNNING/STOPPING). */
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
  /**
   * Projection — the turn ended cleanly (COMPLETE/ERROR/INTERRUPTED) within
   * the last ~5 minutes and the worker sits at its prompt waiting for the
   * next user message; ages out to INACTIVE. Mirrors the Python
   * ``WorkerStatus.PENDING_USER`` (``flow_sdk/builtin/worker_status.py``).
   * Deliberately in NO helper set: not mid-turn (``isWorkerRunning`` false),
   * not terminal (``isWorkerTerminal`` false), and not in the ready baseline
   * (Python's gold ``is_ready_for_input`` excludes it too — only the
   * queue-drain superset admits it).
   */
  PENDING_USER = 'pending_user',
  /** Active — user message received; Claude hasn't responded yet. */
  WORKING      = 'working',
  /** Active — assistant generating. */
  THINKING     = 'thinking',
  /** Active — Claude dispatched tool(s). */
  TOOL_CALL    = 'tool_call',
  /** Active — tool is executing (progress events). */
  TOOL_RUNNING = 'tool_running',
  /** Active — Anthropic API error, Claude is retrying mid-turn. */
  API_ERROR    = 'api_error',
  /** Terminal — JSONL stalled in WORKING, needs intervention. */
  API_TIMEOUT  = 'api_timeout',
  /** Parse fallback — last JSONL entry did not match any known pattern. Replaces the former RUNNING catchall. */
  UNKNOWN      = 'unknown',
}

const WORKER_RUNNING_STATUSES = new Set<WorkerStatus>([
  WorkerStatus.WORKING,
  WorkerStatus.THINKING,
  WorkerStatus.TOOL_CALL,
  WorkerStatus.TOOL_RUNNING,
  WorkerStatus.API_ERROR,
]);

/**
 * Raw worker statuses that mean "the worker is mid-turn and the user must wait".
 * Byte-for-byte equal to the Python ``_BUSY_WORKER_STATUSES`` in
 * ``status_predicates.py`` via ``status_sets.json`` (key ``worker_busy``).
 * NOTE api_error is NOT here — an API error is re-promptable, so the backend maps
 * it to ¬busy; while a turn genuinely retries the prompt lock keeps the process
 * busy. This set is the backend's; the frontend gates on the derived ``busy``
 * boolean (``isBusy``), never on this set directly.
 */
export const WORKER_BUSY_STATUSES = new Set<WorkerStatus>([
  WorkerStatus.INITIALIZING,
  WorkerStatus.WORKING,
  WorkerStatus.THINKING,
  WorkerStatus.TOOL_CALL,
  WorkerStatus.TOOL_RUNNING,
]);

const WORKER_TERMINAL_STATUSES = new Set<WorkerStatus>([
  WorkerStatus.COMPLETE,
  WorkerStatus.ERROR,
  WorkerStatus.INTERRUPTED,
  WorkerStatus.INACTIVE,
  WorkerStatus.API_TIMEOUT,
]);

/** True while the worker is mid-turn (WORKING/THINKING/TOOL_CALL/TOOL_RUNNING/API_ERROR). */
export function isWorkerRunning(status: WorkerStatus | null | undefined): boolean {
  return status != null && WORKER_RUNNING_STATUSES.has(status);
}

/** True when the worker turn has ended and cannot be resumed in place. */
export function isWorkerTerminal(status: WorkerStatus | null | undefined): boolean {
  return status != null && WORKER_TERMINAL_STATUSES.has(status);
}

/**
 * True when the worker has started (has some transcript beyond INITIALIZING)
 * and is not in the ready-for-input baseline. Used to gate operations like
 * "fork" that are only sensible after at least one turn has happened.
 */
export function hasWorkerStarted(status: WorkerStatus | null | undefined): boolean {
  // No reported status means no transcript — same "nothing yet" as INITIALIZING.
  return status != null && status !== WorkerStatus.INITIALIZING;
}

/**
 * Minimal shape for ``isReadyForInput`` / ``getDisplayStatus`` / ``getWorkerMode`` callers.
 * Avoids coupling to the full ``AgenticProcess`` class.
 */
export interface StatusBearingProcess {
  status?: ProcessStatus | string;
  /** Turn-in-flight — the orthogonal boolean the input/toggle gates read. */
  busy?: boolean;
  workerStatus?: WorkerStatus | string;
  worker_status?: WorkerStatus | string;
  session_id?: string | null;
  /** Tab visibility only — NOT the transport router (see ``pty_mode``). */
  visible?: boolean;
  /**
   * Transport intent and the routing key for ``WorkerMode`` /
   * ``ExecutionMode``: ``true`` = PTY worker, ``false`` = headless CLI. A hidden
   * live PTY carries ``pty_mode=true`` with ``visible=false``. When absent, the
   * classifiers fall back to ``visible`` (``visible=true ⟹ pty_mode=true``).
   */
  pty_mode?: boolean;
  ptyMode?: boolean;
}

/**
 * Which mode the worker is currently running in.
 *
 * Derived from the *transport* ``pty_mode`` (NOT tab ``visible``):
 * - ``pty_mode === true``  → ``Interactive`` (PTY worker, xterm in the dock)
 * - ``pty_mode === false`` → ``CLI`` (headless ``claude -p`` subprocess per turn)
 *
 * A hidden live PTY (``visible=false`` but ``pty_mode=true``) is Interactive.
 * ``session_id`` survives both directions — both modes write the same
 * ``~/.claude/projects/<encoded-cwd>/<sid>.jsonl``. Switching is two-way via the
 * ``switch-mode`` action.
 */
export enum WorkerMode {
  Interactive = 'interactive',
  CLI         = 'cli',
}

/**
 * Portable model **tier** (size) — set as `context.model` instead of a vendor
 * model name. The backend driver maps the tier to its own model family at launch
 * (for example, claude: sm→haiku, md→sonnet, lg→opus)
 * — see `flow_sdk/builtin/agentic_process/model_tiers.py`, the single source of
 * truth. A concrete model string (e.g. `'sonnet'`) may still be passed directly.
 *
 * Values are the wire form sent to the backend, so this enum must stay in lockstep
 * with the Python `ModelTier`.
 */
export enum WorkerModelTier {
  SM = 'sm',
  MD = 'md',
  LG = 'lg',
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
  | 'opencode'
  | 'opencode-restore'
  | 'generic'
  | 'generic-restore';

/**
 * True when the process runs on the PTY transport. Keys on ``pty_mode`` (the
 * transport axis); falls back to ``visible`` when ``pty_mode`` isn't carried on
 * the payload (``visible=true ⟹ pty_mode=true``, so the fallback is safe — it can
 * only miss the hidden-live-PTY case, which then reads as non-PTY as before).
 */
function isPtyTransport(p: StatusBearingProcess): boolean {
  return (p.pty_mode ?? p.ptyMode ?? p.visible) === true;
}

/** Derive the worker mode from the process' transport intent (``pty_mode``). */
export function getWorkerMode(p: StatusBearingProcess): WorkerMode {
  return isPtyTransport(p) ? WorkerMode.Interactive : WorkerMode.CLI;
}

/**
 * Coarse "kind of running worker" classification used by the footer worker-list
 * chip. Unlike ``WorkerMode`` (which only splits PTY vs headless on ``visible``),
 * this folds in error/liveness and an out-of-app ``External`` bucket so the chip
 * can group + filter every worker on the machine by view mode.
 *
 * Derived, never stored. Mirrored on the backend by ``classify_execution_mode``
 * in ``flow_sdk/builtin/worker_status.py`` (contract-tested via
 * ``test_fixtures/status_sets.json`` → ``worker_execution_error``).
 */
export enum ExecutionMode {
  /** PTY worker (xterm in the dock). Standard view. */
  Interactive = 'interactive',
  /** Headless ``claude -p`` worker. Standard view. */
  Background = 'background',
  /** Worker in an error/dead state (see ``ERROR_WORKER_STATUSES`` / dead PID). Advanced view. */
  Error = 'error',
  /** Worker running outside the app (OS-scanned). Advanced view; server-only. */
  External = 'external',
}

/**
 * Worker states that read as an *error* for execution-mode classification:
 * abnormal end (ERROR), a stalled/timed-out turn (API_TIMEOUT), or a stale
 * transcript with no clean termination (INACTIVE). Distinct from
 * ``WORKER_TERMINAL_STATUSES`` — COMPLETE/INTERRUPTED are clean terminals, not
 * errors. Kept byte-for-byte equal to the Python ``_ERROR_STATUSES`` via the
 * shared ``status_sets.json`` fixture (key ``worker_execution_error``).
 */
export const ERROR_WORKER_STATUSES = new Set<WorkerStatus>([
  WorkerStatus.ERROR,
  WorkerStatus.API_TIMEOUT,
  WorkerStatus.INACTIVE,
]);

const STANDARD_EXECUTION_MODES: readonly ExecutionMode[] = [
  ExecutionMode.Interactive,
  ExecutionMode.Background,
];

const ADVANCED_EXECUTION_MODES: readonly ExecutionMode[] = [
  ...STANDARD_EXECUTION_MODES,
  ExecutionMode.Error,
  ExecutionMode.External,
];

/**
 * Execution modes a given view mode is allowed to surface. Standard hides the
 * error/external complexity entirely (so a Standard user never sees — or counts
 * — those workers); Advanced/Dev add them.
 */
export function supportedExecutionModes(isAdvanced: boolean): readonly ExecutionMode[] {
  return isAdvanced ? ADVANCED_EXECUTION_MODES : STANDARD_EXECUTION_MODES;
}

/**
 * Classify a *live* worker into an ``ExecutionMode``. Returns ``null`` when the
 * process is not live (``ProcessStatus ∉ {RUNNING, STARTING}``) — those are not
 * listed. ``External`` is never returned here; external workers come only from
 * the ``/workers`` backend snapshot.
 *
 * Keyed on the *transport* ``pty_mode`` (NOT tab ``visible``). Truth table
 * (first match wins):
 *   1. worker_status ∈ ERROR_WORKER_STATUSES         → Error
 *   2. pty (transport) && pidAlive===false (dead PTY) → Error
 *   3. pty (transport)                                → Interactive
 *   4. headless (no PTY transport)                    → Background
 *
 * A hidden live PTY (``visible=false`` but ``pty_mode=true``) is Interactive.
 * ``pidAlive`` is only meaningful for PTY; CLI workers have no PID, so
 * dead-PID→error never applies to them — CLI error relies solely on rule 1. When
 * ``pidAlive`` is undefined (the live WS payload has no PID liveness) rule 2 never
 * fires; dead-PTY→error is then authoritative only via ``/workers``.
 */
export function classifyExecutionMode(
  p: StatusBearingProcess & { pidAlive?: boolean },
): ExecutionMode | null {
  const status = resolveStatus(p);
  // Live for execution-mode = running EXCEPT the terminal-bound STOPPING (a
  // stopping worker is not "executing"). Reuses isProcessRunning's wire set.
  if (status === undefined || !isProcessRunning(status) || status === ProcessStatus.STOPPING) return null;
  const worker = resolveWorkerStatus(p);
  if (worker !== undefined && ERROR_WORKER_STATUSES.has(worker)) return ExecutionMode.Error;
  const isPty = isPtyTransport(p);
  if (isPty && p.pidAlive === false) return ExecutionMode.Error;
  return isPty ? ExecutionMode.Interactive : ExecutionMode.Background;
}

function resolveStatus(p: StatusBearingProcess): ProcessStatus | undefined {
  return (p.status as ProcessStatus) ?? undefined;
}

function resolveWorkerStatus(p: StatusBearingProcess): WorkerStatus | undefined {
  const w = p.workerStatus ?? p.worker_status;
  return (w as WorkerStatus) ?? undefined;
}

/**
 * The single canonical "the user must wait" predicate — the ONE boolean the UI
 * gates input and the pty-mode (xterm ⇄ chat) switch on. All the logic is
 * backend-side: ``busy`` is the separate serialized boolean the backend derived
 * from the prompt lock + ``_turn_in_flight`` + worker activity in
 * ``status_predicates.is_turn_busy``. The frontend just reads ``p.busy``.
 *
 * A non-live process (NEW / STOPPED / FAILED …) is never ``busy`` (the backend
 * only sets it while RUNNING), so callers that need "can send now" should use
 * ``isReadyForInput``, and callers gating a spinner / the switch toggle on "a
 * turn is running" should use ``isBusy``.
 */
export function isBusy(p: StatusBearingProcess): boolean {
  return p.busy === true;
}

/**
 * "Can the caller send a new user prompt / switch transport now?" — ⇔ no turn is
 * in flight (``!busy``) AND the worker is either fully up (``status === RUNNING``),
 * a fresh headless process, OR a **headless-idle** session. Mirror of the Python
 * ``is_ready_from_busy`` / ``is_ready_for_input``.
 *
 * A fresh headless process (CLI transport at ``status === NEW``) has no persistent
 * worker or session yet, but its first prompt and an interactive-mode switch are
 * both accepted immediately. Treating it as not ready disabled the chat/terminal
 * toggle before the first turn even though the backend switch guard accepted it.
 *
 * Headless-idle readiness (CLI transport — ``!isPtyTransport`` — with a live
 * ``session_id`` at ``status === STOPPED``): the CLI transport runs a fresh
 * ``claude -p`` worker per turn, so between turns a headless session sits at
 * STOPPED with its ``session_id`` preserved, yet is ready for the next prompt and
 * to toggle chat⇄terminal back. Without this the toggle wedged permanently off
 * once a session went headless-idle (RCA #12a: switch→cli ``exit()`` → STOPPED).
 *
 * "ready" and "busy" stay disjoint (``!busy`` gates first), so enabling the
 * toggle on ready can never hit the backend's busy 409.
 */
export function isReadyForInput(p: StatusBearingProcess): boolean {
  if (isBusy(p)) return false;
  const status = resolveStatus(p);
  if (status === ProcessStatus.RUNNING) return true;
  if (status === ProcessStatus.NEW && !isPtyTransport(p)) return true;
  return status === ProcessStatus.STOPPED && !isPtyTransport(p) && !!p.session_id;
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
  const worker = resolveWorkerStatus(p);
  if (worker !== undefined && worker !== WorkerStatus.UNKNOWN && ERROR_WORKER_STATUSES.has(worker)) {
    return worker;
  }
  if (isProcessRunning(status)) {
    if (worker !== undefined && worker !== WorkerStatus.UNKNOWN) return worker;
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
