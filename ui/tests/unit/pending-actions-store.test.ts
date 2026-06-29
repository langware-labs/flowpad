import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcess, ExecutionMode } from '@sdk';
import {
  __resetTrackersForTest,
  buildWorkerEntries,
  handleDataOp,
} from '@src/store/pending-actions-store';

/**
 * Regression for the post-restart phantom-agents bug.
 *
 * The footer "agents at work" chip counts the worker list built by
 * ``buildWorkerEntries`` → ``classifyExecutionMode``, which treats any
 * ``status ∈ {RUNNING, STARTING}`` as a live worker. After a backend restart a
 * dead headless (``visible=false``) worker still carries ``status='running'`` on
 * disk, so it shows as a phantom "Background" agent until the backend stamps it
 * terminal.
 *
 * The backend fix (``reconcile_orphaned_workers``) emits a ``status='stopped'``
 * update on restart. This test drives the REAL ingestion path (``handleDataOp``)
 * and asserts the reactive-correction the chip relies on: a RUNNING headless
 * worker is listed, then dropped the instant the STOPPED update arrives.
 */
describe('pending-actions worker list — restart reconciliation', () => {
  const PROC_ID = '11111111-1111-4111-8111-111111111111';
  const typeIdStr = `${AgenticProcess.type}-${PROC_ID}`;

  beforeEach(() => __resetTrackersForTest());

  it('counts a running headless worker, then drops it once it goes STOPPED', () => {
    // Phantom live worker (what a restart leaves behind on disk).
    handleDataOp(typeIdStr, 'update', { status: 'running', visible: false });
    const live = buildWorkerEntries(Date.now());
    expect(live.map((e) => e.processId)).toContain(PROC_ID);
    expect(live.find((e) => e.processId === PROC_ID)?.mode).toBe(ExecutionMode.Background);

    // Backend reconcile sweep emits the terminal status → chip must drop it.
    handleDataOp(typeIdStr, 'update', { status: 'stopped', visible: false });
    const after = buildWorkerEntries(Date.now());
    expect(after.map((e) => e.processId)).not.toContain(PROC_ID);
  });

  it('a worker that comes up STOPPED is never listed', () => {
    handleDataOp(typeIdStr, 'update', { status: 'stopped', visible: false });
    expect(buildWorkerEntries(Date.now())).toHaveLength(0);
  });
});
