/**
 * Single source of truth for user-facing status labels (worker → user lingo).
 *
 * Both the footer worker chip (``ui/src/components/footer/worker-status-label.ts``)
 * and the status indicator (``ui/src/components/agentic-progress/shared/status-indicator.tsx``)
 * import from here — there is exactly ONE label table per axis. The indicator
 * keeps its own icon/color config but sources its ``.label`` from this file, so
 * the two surfaces can never drift (previously they were two independent maps
 * with diverging wording).
 *
 * Display text is presentation, so it lives frontend-side; the backend owns the
 * status VALUES, this file owns how they read to a user.
 */
import { ProcessStatus, WorkerStatus } from './agentic-types';

/**
 * The label a worker status should READ AS, preferring the CLI's own sentence.
 *
 * ``ERROR`` is one token, and the CLI usually already wrote something far more
 * useful behind it — ``"Not logged in · Please run /login"``, ``"You've hit your
 * session limit · resets 7:50pm"``. The backend recovers that sentence into
 * ``worker_status_detail`` (see ``worker_status.tail_status_detail``); this is
 * where it wins over the generic word, so no surface has to decide for itself.
 *
 * Falls back to the table whenever there is no detail, which is every status
 * except a terminal error.
 */
export function workerStatusText(status: WorkerStatus | string | undefined, detail?: string | null): string {
  const trimmed = detail?.trim();
  if (trimmed) return trimmed;
  return WORKER_STATUS_LABEL[status as WorkerStatus] ?? WORKER_STATUS_LABEL[WorkerStatus.UNKNOWN];
}

/** Raw worker status ("what we found") → user label. */
export const WORKER_STATUS_LABEL: Record<WorkerStatus, string> = {
  [WorkerStatus.INITIALIZING]: 'Initializing',
  [WorkerStatus.IDLE]: 'Idle',
  [WorkerStatus.COMPLETE]: 'Complete',
  [WorkerStatus.ERROR]: 'Error',
  [WorkerStatus.INTERRUPTED]: 'Interrupted',
  [WorkerStatus.INACTIVE]: 'Inactive',
  [WorkerStatus.PENDING_USER]: 'Idle',
  [WorkerStatus.WORKING]: 'Working',
  [WorkerStatus.THINKING]: 'Thinking',
  [WorkerStatus.TOOL_CALL]: 'Using tool',
  [WorkerStatus.TOOL_RUNNING]: 'Running tool',
  [WorkerStatus.API_ERROR]: 'API retry',
  [WorkerStatus.API_TIMEOUT]: 'Timed out',
  [WorkerStatus.UNKNOWN]: 'Unknown',
};

/**
 * Lifecycle process status ("what it means") → user label. Turn-in-flight is the
 * separate ``busy`` boolean (labelled by the worker status while running), not a
 * status value — so ``RUNNING`` reads as the idle-at-prompt "Idle" here.
 */
export const PROCESS_STATUS_LABEL: Record<ProcessStatus, string> = {
  [ProcessStatus.NEW]: 'New',
  [ProcessStatus.STARTING]: 'Starting',
  [ProcessStatus.RUNNING]: 'Idle',
  [ProcessStatus.STOPPING]: 'Stopping',
  [ProcessStatus.STOPPED]: 'Complete',
  [ProcessStatus.FAILED]: 'Error',
};
