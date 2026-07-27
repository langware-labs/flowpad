import { WorkerStatus, WORKER_STATUS_LABEL } from '@sdk';

/**
 * @param raw the lowercase string form of WorkerStatus, as stored on the
 *            tracker / entity (`'thinking'`, `'tool_call'`, …).
 * @param pending if the process is in the pending-input ("your turn") glow
 *                window, override with the "Idle" label regardless of the
 *                underlying worker_status — this is how the user reads the row.
 *
 * Labels come from the single shared table ``WORKER_STATUS_LABEL`` (ts_sdk) —
 * this file no longer keeps its own map, so the footer and the status indicator
 * can never drift.
 */
export function workerStatusLabel(
  raw: string | undefined,
  pending: boolean,
): string {
  if (pending) return WORKER_STATUS_LABEL[WorkerStatus.IDLE];
  if (!raw) return WORKER_STATUS_LABEL[WorkerStatus.WORKING];
  return WORKER_STATUS_LABEL[raw as WorkerStatus] ?? WORKER_STATUS_LABEL[WorkerStatus.WORKING];
}
