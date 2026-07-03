/**
 * pending-actions-store — worker-list view.
 *
 * Verifies the membership WIDENING from burning∪pending to all-live-classified,
 * the per-mode counts, view-mode supported-set gating, and that the
 * glow/pulse (`pending`) flags survive the refactor. Drives the store through
 * its real WS-op callback (the only seam mocked is `subscribeToEntityOps`, to
 * capture that callback) and reads state via the public hooks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Capture the entity-ops callback the store registers in attachOnce().
let captured: ((typeId: unknown, op: string, data: unknown) => void) | null = null;
vi.mock('@sdk/react/hooks', () => ({
  subscribeToEntityOps: (_type: string, cb: (t: unknown, op: string, d: unknown) => void) => {
    captured = cb;
    return () => {};
  },
}));

import {
  AgenticProcess,
  ExecutionMode,
  ProcessStatus,
  supportedExecutionModes,
  WorkerStatus,
} from '@sdk';

/** Minimal stand-in for a TypeId — the store only calls `.toString()`. */
const typeIdStub = (id: string) => ({ toString: () => `${AgenticProcess.type}-${id}` });
import {
  acknowledgePending,
  useWorkerCountsByMode,
  useWorkerList,
} from '@src/store/pending-actions-store';

const ADVANCED = supportedExecutionModes(true);
const STANDARD = supportedExecutionModes(false);

const createdIds = new Set<string>();

interface OpFields {
  status?: ProcessStatus;
  worker_status?: WorkerStatus;
  visible?: boolean;
  project_id?: string | null;
}

/** Push a synthetic WS op through the captured store callback. */
function emit(id: string, fields: OpFields, op: 'update' | 'delete' = 'update'): void {
  createdIds.add(id);
  act(() => {
    captured?.(typeIdStub(id), op, fields);
  });
}

beforeEach(() => {
  // Mount once so attachOnce() runs and `captured` is set.
  renderHook(() => useWorkerList(ADVANCED));
});

afterEach(() => {
  // Clear every tracker created this test so the singleton store doesn't leak
  // counts into the next test.
  for (const id of createdIds) {
    act(() => captured?.(typeIdStub(id), 'delete', {}));
  }
  createdIds.clear();
  localStorage.clear();
});

const uid = () => crypto.randomUUID();

describe('worker-list membership', () => {
  it('includes an idle-but-running worker (neither burning nor pending)', () => {
    const id = uid();
    emit(id, { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.IDLE, visible: false });

    const list = renderHook(() => useWorkerList(ADVANCED));
    const row = list.result.current.find((e) => e.processId === id);
    // The widened membership surfaces it even though it's idle: the old
    // burning∪pending view would have dropped it.
    expect(row).toBeDefined();
    expect(row?.burning).toBe(false);
    expect(row?.pending).toBe(false);
    expect(row?.mode).toBe(ExecutionMode.Background);
  });

  it('classifies interactive / background / error correctly', () => {
    const int = uid(), bg = uid(), err = uid();
    emit(int, { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: true });
    emit(bg, { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: false });
    emit(err, { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.ERROR, visible: true });

    const { result } = renderHook(() => useWorkerList(ADVANCED));
    const modeOf = (id: string) => result.current.find((e) => e.processId === id)?.mode;
    expect(modeOf(int)).toBe(ExecutionMode.Interactive);
    expect(modeOf(bg)).toBe(ExecutionMode.Background);
    expect(modeOf(err)).toBe(ExecutionMode.Error); // error wins over visible
  });

  it('excludes non-live (STOPPED) workers', () => {
    const id = uid();
    emit(id, { status: ProcessStatus.STOPPED, worker_status: WorkerStatus.COMPLETE, visible: false });
    const { result } = renderHook(() => useWorkerList(ADVANCED));
    expect(result.current.find((e) => e.processId === id)).toBeUndefined();
  });
});

describe('per-mode counts + view-mode gating', () => {
  it('counts by mode and hides error from the standard supported set', () => {
    const err = uid();
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: true });
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.WORKING, visible: false });
    emit(err, { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.INACTIVE, visible: false });

    const adv = renderHook(() => useWorkerCountsByMode(ADVANCED));
    expect(adv.result.current[ExecutionMode.Interactive]).toBe(1);
    expect(adv.result.current[ExecutionMode.Background]).toBe(1);
    expect(adv.result.current[ExecutionMode.Error]).toBe(1);
    expect(adv.result.current[ExecutionMode.External]).toBe(0);

    // Standard view never surfaces the error worker (complexity hidden).
    const std = renderHook(() => useWorkerList(STANDARD));
    expect(std.result.current.find((e) => e.processId === err)).toBeUndefined();
    const stdCounts = renderHook(() => useWorkerCountsByMode(STANDARD));
    expect(stdCounts.result.current).not.toHaveProperty(ExecutionMode.Error);
  });
});

describe('glow (transition-driven, arms on the wire READY status)', () => {
  it('arms glow on a busy → ready transition ("your turn"), and ack clears it', () => {
    const id = uid();
    // First observation is BUSY (mid-turn) → no glow armed.
    emit(id, { status: ProcessStatus.BUSY, worker_status: WorkerStatus.THINKING, visible: true });
    const initial = renderHook(() => useWorkerList(ADVANCED));
    expect(initial.result.current.find((e) => e.processId === id)?.pending).toBe(false);

    // Live transition into READY (turn finished) arms the glow.
    emit(id, { status: ProcessStatus.READY, worker_status: WorkerStatus.COMPLETE, visible: true });
    const armed = renderHook(() => useWorkerList(ADVANCED));
    expect(armed.result.current.find((e) => e.processId === id)?.pending).toBe(true);

    act(() => acknowledgePending(id));

    const after = renderHook(() => useWorkerList(ADVANCED));
    const row = after.result.current.find((e) => e.processId === id);
    // Still listed (live, Interactive) but no longer pending → no glow.
    expect(row?.mode).toBe(ExecutionMode.Interactive);
    expect(row?.pending).toBe(false);
  });

  it('arms glow on a busy → ready transition for a headless worker too', () => {
    const id = uid();
    emit(id, { status: ProcessStatus.BUSY, worker_status: WorkerStatus.THINKING, visible: false });
    emit(id, { status: ProcessStatus.READY, worker_status: WorkerStatus.IDLE, visible: false });
    const { result } = renderHook(() => useWorkerList(ADVANCED));
    expect(result.current.find((e) => e.processId === id)?.pending).toBe(true);
  });

  it('does NOT glow a process first observed already READY (no re-arm on seed/refresh)', () => {
    const id = uid();
    // First-ever observation is already ready (cache seed / reload).
    emit(id, { status: ProcessStatus.READY, worker_status: WorkerStatus.COMPLETE, visible: true });
    const { result } = renderHook(() => useWorkerList(ADVANCED));
    const row = result.current.find((e) => e.processId === id);
    expect(row).toBeDefined();
    expect(row?.pending).toBe(false);
  });

  it('does NOT glow on a transition INTO busy (mid-turn is not "your turn")', () => {
    const id = uid();
    // Seed ready (no arm on first observation), then go busy.
    emit(id, { status: ProcessStatus.READY, worker_status: WorkerStatus.IDLE, visible: true });
    emit(id, { status: ProcessStatus.BUSY, worker_status: WorkerStatus.THINKING, visible: true });
    const { result } = renderHook(() => useWorkerList(ADVANCED));
    expect(result.current.find((e) => e.processId === id)?.pending).toBe(false);
  });
});
