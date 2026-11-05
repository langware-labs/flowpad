import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcess } from '@sdk';
import {
  __resetTrackersForTest,
  buildWorkerEntries,
  handleDataOp,
} from '@src/store/pending-actions-store';

/**
 * Regression for the post-restart phantom-agents bug.
 *
 * The footer "agents at work" chip counts the worker list built by
 * ``buildWorkerEntries``, which reads ``status ∈ {RUNNING, STARTING}`` as a running worker. After a backend restart a
 * dead headless (``visible=false``) worker still carries ``status='running'`` on
 * disk, so it shows as a phantom "Background" agent until the backend stamps it
 * terminal.
 *
 * The backend fix (``reconcile_orphaned_workers``) emits a ``status='stopped'``
 * update on restart. This test drives the REAL ingestion path (``handleDataOp``)
 * and asserts the reactive-correction the chip relies on: a RUNNING headless
 * worker is a running row, then Completed the instant the STOPPED update arrives.
 */
describe('pending-actions worker list — restart reconciliation', () => {
  const PROC_ID = '11111111-1111-4111-8111-111111111111';
  const typeIdStr = `${AgenticProcess.type}-${PROC_ID}`;

  beforeEach(() => __resetTrackersForTest());

  const entry = () => buildWorkerEntries(Date.now()).find((e) => e.processId === PROC_ID);

  it('a running headless worker is a running Background row, and Completed once it goes STOPPED', () => {
    // Phantom live worker (what a restart leaves behind on disk).
    handleDataOp(typeIdStr, 'update', { status: 'running', visible: false });
    expect(entry()).toMatchObject({ category: 'background', state: 'running' });

    // Backend reconcile sweep emits the terminal status → the row is no longer a live worker.
    handleDataOp(typeIdStr, 'update', { status: 'stopped', visible: false });
    expect(entry()?.state).toBe('completed');
  });

  it('a worker that comes up STOPPED is never a running row', () => {
    handleDataOp(typeIdStr, 'update', { status: 'stopped', visible: false });
    expect(buildWorkerEntries(Date.now()).filter((e) => e.state === 'running')).toHaveLength(0);
  });
});
