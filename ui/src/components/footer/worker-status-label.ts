import { WorkerStatus } from '@sdk';

/**
 * Human-readable label for the AgenticProcess worker_status enum,
 * scoped to the states the footer chip surfaces (active or pending).
 * Terminal states are reachable in transient edge cases (e.g. a process
 * just flipped COMPLETE but its pending window hasn't expired) — we
 * label those too rather than render an empty cell.
 */
const STATUS_LABEL: Record<WorkerStatus, string> = {
  [WorkerStatus.INITIALIZING]: 'Starting',
  [WorkerStatus.IDLE]: 'Idle',
  [WorkerStatus.COMPLETE]: 'Complete',
  [WorkerStatus.ERROR]: 'Error',
  [WorkerStatus.INTERRUPTED]: 'Interrupted',
  [WorkerStatus.INACTIVE]: 'Inactive',
  [WorkerStatus.WAITING]: 'Waiting for response',
  [WorkerStatus.THINKING]: 'Thinking',
  [WorkerStatus.TOOL_CALL]: 'Calling tool',
  [WorkerStatus.TOOL_RUNNING]: 'Running tool',
  [WorkerStatus.API_ERROR]: 'API error · retrying',
  [WorkerStatus.API_TIMEOUT]: 'API timeout',
  [WorkerStatus.UNKNOWN]: 'Working',
};

/**
 * @param raw the lowercase string form of WorkerStatus, as stored on the
 *            tracker / entity (`'thinking'`, `'tool_call'`, …).
 * @param pending if the process is in the pending-input window, override
 *                with the "Waiting for you" label regardless of underlying
 *                worker_status — this is how the user reads the row.
 */
export function workerStatusLabel(
  raw: string | undefined,
  pending: boolean,
): string {
  if (pending) return 'Waiting for you';
  if (!raw) return 'Working';
  return STATUS_LABEL[raw as WorkerStatus] ?? 'Working';
}
