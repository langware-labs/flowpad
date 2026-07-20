/**
 * useAdoptAnalyzeProcess — decides whether the Analyze button reconnects to an
 * existing run. The fix under test: gate on WORKER status, not the process
 * `status` (which lags at RUNNING after the worker is COMPLETE). So a wizard
 * whose agent finished without closing is NOT re-adopted (which would spin
 * forever), while a genuinely mid-turn run IS.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// useProcessState is mocked to hand back whatever worker status the test wants.
let currentWorkerStatus: string | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetched: any = null;

// Only AgenticProcess.getByIdWithHistory is stubbed; isWorkerRunning + the
// WorkerStatus enum stay real so the gate logic is exercised for real.
const h = vi.hoisted(() => ({ getByIdWithHistory: vi.fn() }));

vi.mock('@src/hooks/use-process-state', () => ({
  useProcessState: () => ({ workerStatus: currentWorkerStatus }),
}));
vi.mock('@sdk', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, AgenticProcess: { getByIdWithHistory: h.getByIdWithHistory } };
});

import { WorkerStatus } from '@sdk';
import { useAdoptAnalyzeProcess } from '@src/hooks/use-adopt-analyze-process';

function makeProc(topic: string) {
  return {
    id: 'p1',
    target_typeid_str: 'wizard:task-analyze:1',
    context_data: { wizard: { name: topic, data: { title: 'Analyze group status' } } },
    watch: vi.fn().mockResolvedValue(() => Promise.resolve()),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const taskWith = (process_id: string | null) => ({ process_id }) as any;

beforeEach(() => {
  currentWorkerStatus = null;
  fetched = makeProc('task-analyze');
  h.getByIdWithHistory.mockReset();
  h.getByIdWithHistory.mockImplementation(() => Promise.resolve(fetched));
});

describe('useAdoptAnalyzeProcess', () => {
  it('does NOT adopt a run whose worker already completed (the zombie-spinner bug)', async () => {
    currentWorkerStatus = WorkerStatus.COMPLETE;
    const { result } = renderHook(() => useAdoptAnalyzeProcess(taskWith('p1')));
    await waitFor(() => expect(h.getByIdWithHistory).toHaveBeenCalledWith('p1'));
    expect(result.current).toBeNull();
  });

  it('adopts a genuinely running task-analyze process', async () => {
    currentWorkerStatus = WorkerStatus.WORKING;
    const { result } = renderHook(() => useAdoptAnalyzeProcess(taskWith('p1')));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toMatchObject({
      target: 'wizard:task-analyze:1',
      request: { wizardName: 'task-analyze' },
    });
  });

  it('does not adopt a non-analyze process even if it is running', async () => {
    currentWorkerStatus = WorkerStatus.WORKING;
    fetched = makeProc('some-chat'); // wrong topic
    const { result } = renderHook(() => useAdoptAnalyzeProcess(taskWith('p1')));
    await waitFor(() => expect(h.getByIdWithHistory).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('returns null (and never fetches) when the task has no process_id', async () => {
    currentWorkerStatus = WorkerStatus.WORKING;
    const { result } = renderHook(() => useAdoptAnalyzeProcess(taskWith(null)));
    await Promise.resolve();
    expect(result.current).toBeNull();
    expect(h.getByIdWithHistory).not.toHaveBeenCalled();
  });
});
