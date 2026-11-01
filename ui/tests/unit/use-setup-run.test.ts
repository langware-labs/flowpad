/**
 * useSetupRun — `start(root)` runs one node of the tree: reading and Stop follow that root, and a new run
 * starts from nothing (the previous record's node states are never shown as this run's).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { Project } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/ask/ask-claims', () => ({ claimAskRun: () => () => {}, openQuestionOf: async () => null }));

import { SETUP_POLL_MS, useSetupRun } from '@src/components/project-setup/use-setup-run';

const PID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OLD = { state: 'failed', detail: '', root: null, total: 1, done: 0, ran: true } as const;

describe('useSetupRun', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('start(root) runs that node, then reads and stops it there', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi.spyOn(Project, 'setupRun').mockResolvedValue({ run: 'r', running: false, tree: OLD } as never);
    const start = vi.spyOn(Project, 'startSetup').mockResolvedValue('r');
    const stop = vi.spyOn(Project, 'stopSetup').mockResolvedValue(true);
    const { result } = renderHook(() => useSetupRun(PID, ''));
    await waitFor(() => expect(result.current.tree).toEqual(OLD));

    read.mockResolvedValue({ run: 'r', running: true, tree: null } as never);
    await act(() => result.current.start('micro_app-1'));

    expect(start).toHaveBeenCalledWith(PID, 'micro_app-1');
    expect(result.current.root).toBe('micro_app-1');
    expect(result.current.tree).toBeNull(); // the old record's states are gone
    await act(async () => {
      await result.current.stop?.();
    });
    expect(stop).toHaveBeenCalledWith(PID, 'micro_app-1');
    // The next poll (SETUP_POLL_MS later) reads the step's own run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
    });
    expect(read).toHaveBeenCalledWith(PID, 'micro_app-1');
  });

  it('a step run that ends goes back to the own root and its record', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi.spyOn(Project, 'setupRun').mockResolvedValue({ run: 'r', running: false, tree: OLD } as never);
    vi.spyOn(Project, 'startSetup').mockResolvedValue('r');
    const { result } = renderHook(() => useSetupRun(PID, ''));
    await waitFor(() => expect(result.current.tree).toEqual(OLD));
    await act(() => result.current.start('micro_app-1'));
    // The step's run is over at the next poll; the own record is read again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
    });
    expect(result.current.running).toBe(false);
    expect(result.current.root).toBe('');
    expect(result.current.tree).toEqual(OLD);
    expect(read).toHaveBeenLastCalledWith(PID, '');
  });

  it("start() with no root runs the hook's own root", async () => {
    vi.spyOn(Project, 'setupRun').mockResolvedValue(null);
    const start = vi.spyOn(Project, 'startSetup').mockResolvedValue('r');
    const { result } = renderHook(() => useSetupRun(PID, ''));
    await act(() => result.current.start());
    expect(start).toHaveBeenCalledWith(PID, '');
  });
});
