/**
 * useShellRun — the verbs and state around running commands in a shell's terminal: one run at a
 * time, its clock start, how it ended, Stop, and a run found already going on arrival.
 * A real Shell; only its HTTP answers (run-command / interrupt / run-state) are stood in for.
 */
import { Shell } from '@sdk';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellRun } from '@src/hooks/useShellRun';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

function makeShell({ runningPid = null as number | null } = {}) {
  const shell = new Shell({ id: crypto.randomUUID(), compute_node_id: crypto.randomUUID() });
  let marker = 0;
  const posted: string[] = [];
  vi.spyOn(shell as unknown as { post: (a: string, b: unknown) => Promise<unknown> }, 'post').mockImplementation(
    async (action: string) => {
      posted.push(action);
      if (action === 'run-command') return { marker: `__flow_m${++marker}` };
      if (action === 'interrupt') return { stopped: true };
      return null;
    },
  );
  const state = { running_pid: runningPid };
  vi.spyOn(shell, 'runState').mockImplementation(async () => ({ ...state, status: 'running' }));
  const end = (n: number, code: number) =>
    shell.ptyConnection.appendOutput(b64(`\x1b]7770;__flow_m${n};s\x07out\r\n\x1b]7770;__flow_m${n};${code}\x07`));
  return { shell, posted, end, state };
}

beforeEach(() => vi.restoreAllMocks());

describe('useShellRun', () => {
  it('runs one command at a time, clocks it, and keeps how it ended', async () => {
    const { shell, posted, end } = makeShell();
    const { result } = renderHook(() => useShellRun(shell));
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.run('python x.py');
    });
    await waitFor(() => expect(result.current.running).toBe(true));
    expect(result.current.startedAt).toEqual(expect.any(Number));
    await act(async () => {
      expect(await result.current.run('again')).toBeNull(); // one at a time
    });
    expect(posted.filter((a) => a === 'run-command')).toHaveLength(1);
    await act(async () => {
      end(1, 3);
      await first;
    });
    expect(result.current.running).toBe(false);
    expect(result.current.startedAt).toBeNull();
    expect(result.current.lastExit).toMatchObject({ exitCode: 3, output: 'out\r\n' });
  });

  it('a run started on a terminal the view has only just been handed survives the hand-over', async () => {
    const { shell, end } = makeShell();
    const { result, rerender } = renderHook(({ s }) => useShellRun(s), { initialProps: { s: null as Shell | null } });
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.run('python x.py', { shell });
    });
    rerender({ s: shell }); // the view now holds the terminal it just made
    await waitFor(() => expect(result.current.running).toBe(true));
    await act(async () => {
      end(1, 0);
      await first;
    });
    expect(await first).toMatchObject({ exitCode: 0 });
    expect(result.current.lastExit).toMatchObject({ exitCode: 0 });
  });

  it('Stop is the terminal interrupt', async () => {
    const { shell, posted } = makeShell();
    const { result } = renderHook(() => useShellRun(shell));
    await act(async () => {
      expect(await result.current.interrupt()).toBe(true);
    });
    expect(posted).toEqual(['interrupt']);
  });

  it('adopts a command found running on arrival, and lets go once the backend says it ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { shell, state } = makeShell({ runningPid: 4242 });
      const { result } = renderHook(() => useShellRun(shell));
      await waitFor(() => expect(result.current.running).toBe(true));
      expect(result.current.startedAt).toBeNull(); // not a run this view clocked
      state.running_pid = null;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(result.current.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaving the view stops the wait, not the command', async () => {
    const { shell, posted } = makeShell();
    const { result, unmount } = renderHook(() => useShellRun(shell));
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run('sleep 999');
    });
    await waitFor(() => expect(result.current.running).toBe(true));
    unmount();
    await expect(run).resolves.toBeNull();
    expect(posted).not.toContain('interrupt');
  });
});
