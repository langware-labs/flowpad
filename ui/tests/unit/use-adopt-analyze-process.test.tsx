/**
 * useAdoptAnalyzeProcess — decides whether the Analyze button reconnects to an
 * existing run. Keyed on the wizard's TARGET (the task's TypeId), found via
 * useProcessesForTarget — NOT on the lagging `task.process_id`. It reconnects
 * only to a genuinely-running task-analyze wizard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock the target query — the test drives what processes exist for the task.
const h = vi.hoisted(() => ({ useProcessesForTarget: vi.fn() }));
vi.mock('@src/components/entity-execution-panel/hooks/useProcessesForTarget', () => ({
  useProcessesForTarget: (...a: unknown[]) => h.useProcessesForTarget(...a),
}));

import { WorkerStatus } from '@sdk';
import { useAdoptAnalyzeProcess } from '@src/hooks/use-adopt-analyze-process';

function proc(topic: string, workerStatus: WorkerStatus, id = 'p1') {
  return {
    id,
    workerStatus,
    target_typeid_str: 'task-abc',
    context_data: { wizard: { name: topic, data: { title: 'Analyze group status' } } },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const task = { typeId: { toString: () => 'task-abc' } } as any;

beforeEach(() => {
  h.useProcessesForTarget.mockReset();
  h.useProcessesForTarget.mockReturnValue({ processes: [], isLoading: false, error: null });
});

describe('useAdoptAnalyzeProcess', () => {
  it('adopts a genuinely running task-analyze process for this target', () => {
    h.useProcessesForTarget.mockReturnValue({ processes: [proc('task-analyze', WorkerStatus.WORKING)] });
    const { result } = renderHook(() => useAdoptAnalyzeProcess(task));
    expect(result.current).toMatchObject({ target: 'task-abc', request: { wizardName: 'task-analyze' } });
  });

  it('does NOT adopt a run whose worker already completed', () => {
    h.useProcessesForTarget.mockReturnValue({ processes: [proc('task-analyze', WorkerStatus.COMPLETE)] });
    const { result } = renderHook(() => useAdoptAnalyzeProcess(task));
    expect(result.current).toBeNull();
  });

  it('does not adopt a non-analyze process on the same target, even if running', () => {
    h.useProcessesForTarget.mockReturnValue({ processes: [proc('git-context-folder', WorkerStatus.WORKING)] });
    const { result } = renderHook(() => useAdoptAnalyzeProcess(task));
    expect(result.current).toBeNull();
  });

  it('picks the running analyze even when a finished one is also present', () => {
    h.useProcessesForTarget.mockReturnValue({
      processes: [
        proc('task-analyze', WorkerStatus.COMPLETE, 'old'),
        proc('task-analyze', WorkerStatus.WORKING, 'new'),
      ],
    });
    const { result } = renderHook(() => useAdoptAnalyzeProcess(task));
    expect(result.current?.process.id).toBe('new');
  });

  it('returns null when the task has no processes', () => {
    const { result } = renderHook(() => useAdoptAnalyzeProcess(task));
    expect(result.current).toBeNull();
  });
});
