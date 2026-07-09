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
