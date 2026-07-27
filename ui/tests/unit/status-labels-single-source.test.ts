import { describe, it, expect } from 'vitest';
import { PROCESS_STATUS_LABEL, ProcessStatus, WORKER_STATUS_LABEL, WorkerStatus } from '@sdk';
import {
  processStatusConfig,
  workerStatusConfig,
} from '@src/components/agentic-progress/shared/status-indicator';
import { workerStatusLabel } from '@src/components/footer/worker-status-label';

/**
 * Single-source guarantee for user-facing status labels.
 *
 * There is exactly ONE label table per axis (``WORKER_STATUS_LABEL`` /
 * ``PROCESS_STATUS_LABEL`` in ts_sdk). Both the status indicator's config and the
 * footer chip source their labels from it, so the two surfaces can never drift
 * (they used to be two independent maps with diverging wording).
 */

describe('status labels — single source of truth', () => {
  it('the status indicator sources every worker label from WORKER_STATUS_LABEL', () => {
    for (const s of Object.values(WorkerStatus)) {
      expect(workerStatusConfig[s].label).toBe(WORKER_STATUS_LABEL[s]);
    }
  });

  it('the status indicator sources every process label from PROCESS_STATUS_LABEL', () => {
    for (const s of Object.values(ProcessStatus)) {
      expect(processStatusConfig[s].label).toBe(PROCESS_STATUS_LABEL[s]);
    }
  });

  it('the footer chip sources its labels from WORKER_STATUS_LABEL', () => {
    for (const s of Object.values(WorkerStatus)) {
      expect(workerStatusLabel(s, false)).toBe(WORKER_STATUS_LABEL[s]);
    }
  });

  it('the footer pending override reads "Idle" from the shared table', () => {
    expect(workerStatusLabel(WorkerStatus.THINKING, true)).toBe(WORKER_STATUS_LABEL[WorkerStatus.IDLE]);
  });

  it('a live RUNNING process reads as "Idle" (turn-in-flight is the separate busy boolean)', () => {
    // There is no READY/BUSY status anymore; the bare live lifecycle state is
    // RUNNING, which reads as the idle-at-prompt "Idle". A turn in flight is
    // surfaced via the fine-grained worker status ("Working"/"Thinking"/…), not a
    // status value.
    expect(PROCESS_STATUS_LABEL[ProcessStatus.RUNNING]).toBe('Idle');
    expect(WORKER_STATUS_LABEL[WorkerStatus.WORKING]).toBe('Working');
  });

  it('every enum member has a non-empty label (exhaustive tables)', () => {
    for (const s of Object.values(WorkerStatus)) expect(WORKER_STATUS_LABEL[s]).toBeTruthy();
    for (const s of Object.values(ProcessStatus)) expect(PROCESS_STATUS_LABEL[s]).toBeTruthy();
  });
});
