/**
 * A hook's watch is given back however early the component leaves (F1).
 *
 * `dataManager.watch` counts the holder synchronously and answers with its release only after
 * the `/watch` POST returns. A hook that keeps the resolved release has nothing to call when it
 * unmounts first, and the count stays up for good; the hook keeps the PROMISE, so the release
 * runs whenever the answer arrives. Real store and real hooks; only the HTTP POST is held and
 * counted instead of sent.
 */
import { connectionManager, dataManager, type Task } from '@sdk';
import { useWatch } from '@sdk/react/hooks/entity-hooks';
import { useAnalysisTaskProgress } from '@src/hooks/use-analysis-task-progress';
import { TaskType } from '@src/components/task-bar/task-utils';
import { act, renderHook } from '@testing-library/react';
import { posts, spyPost, watchedProcess } from './watch_test_utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROCESS_ID = '7b1a0c2e-0000-4000-8000-0000000000f3';
const { typeId, count, seedProcess } = watchedProcess(PROCESS_ID);

let answer: () => void;

beforeEach(async () => {
  vi.useFakeTimers();
  await dataManager.clearCache();
  vi.spyOn(connectionManager, 'connected', 'get').mockReturnValue(true);
  answer = () => {};
  // The `/watch` POST stays open until the test answers it.
  spyPost().mockImplementation((url: string) =>
    String(url).endsWith('/watch')
      ? new Promise((r) => (answer = () => r(undefined as never)))
      : Promise.resolve(undefined as never),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useWatch', () => {
  it('unmounting before the watch POST answers still ends at zero', async () => {
    seedProcess();
    const { unmount } = renderHook(() => useWatch(typeId));
    expect(count()).toBe(1);
    unmount();
    await act(async () => {
      answer();
      await vi.runAllTimersAsync();
    });
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });

  it('a mounted hook holds one count and gives it back on unmount', async () => {
    seedProcess();
    const { unmount } = renderHook(() => useWatch(typeId));
    await act(async () => {
      answer();
      await vi.runAllTimersAsync();
    });
    expect(count()).toBe(1);
    unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });
});

describe('useAnalysisTaskProgress', () => {
  it('unmounting before the watch POST answers still ends at zero', async () => {
    const proc = seedProcess();
    vi.spyOn(proc, 'loadHistory').mockResolvedValue(undefined as never);
    const task = { id: 't1', task_type: TaskType.ANALYSIS, process_id: PROCESS_ID } as unknown as Task;
    const { unmount } = renderHook(() => useAnalysisTaskProgress(task));
    // The process resolves from the cache; the hook's watch is now waiting on its POST.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(count()).toBe(1);
    unmount();
    await act(async () => {
      answer();
      await vi.runAllTimersAsync();
    });
    expect(count()).toBe(0);
    expect(posts('/unwatch')).toBe(1);
  });
});
