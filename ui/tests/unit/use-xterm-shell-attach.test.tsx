/**
 * useXtermShellAttach — the ONE attach every terminal view uses: the recorded history first, then
 * the chunks it does not cover, then live output; re-run on reconnect/recovery, each run
 * superseding one in flight. A real Shell and PtyConnection; the recorded stream's HTTP answer
 * and the xterm (a recorder of what was written) are stood in for.
 */
import { apiClient, connectionManager, Shell } from '@sdk';
import type { Terminal as XTerm } from '@xterm/xterm';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useXtermShellAttach } from '@src/components/terminal/useXtermShellAttach';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

function fakeTerm() {
  const screen: string[] = [];
  const term = {
    cols: 100,
    rows: 30,
    reset: vi.fn(() => screen.splice(0)),
    write: vi.fn((d: string) => void screen.push(d)),
  };
  return { term: term as unknown as XTerm, screen, reset: term.reset };
}

function connectedShell() {
  const shell = new Shell({ id: crypto.randomUUID(), compute_node_id: crypto.randomUUID() });
  (shell.ptyConnection as unknown as { _attached: boolean })._attached = true;
  vi.spyOn(shell, 'resize').mockResolvedValue(undefined);
  return shell;
}

/** The recording: a checkpoint covering seqs ≤ 2, printed as HISTORY. */
function recorded(get = vi.spyOn(apiClient, 'get')) {
  vi.spyOn(apiClient, 'post').mockResolvedValue(undefined as never);
  get.mockResolvedValue({ v: 1, cols: 80, rows: 24, events: [], checkpoint: { cols: 80, rows: 24, last_seq: 2, serialized: 'HISTORY' } });
  return get;
}

beforeEach(() => vi.restoreAllMocks());

describe('useXtermShellAttach', () => {
  it('writes the history, then only the chunks it does not cover, then live output', async () => {
    recorded();
    const shell = connectedShell();
    for (const [seq, text] of [[1, 'old1'], [2, 'old2'], [3, 'new3']] as const) shell.ptyConnection.appendOutput(b64(text), seq);
    const { term, screen } = fakeTerm();
    const onAttached = vi.fn();
    renderHook(() => useXtermShellAttach(shell, term, { ready: true, onAttached }));

    act(() => void shell.emit('status', 'connected'));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(screen).toEqual(['HISTORY', 'new3']);
    expect(onAttached.mock.calls[0][0]).toMatchObject({ source: 'status', wrote: true, chunks: 3 });

    shell.ptyConnection.appendOutput(b64('live4'), 4);
    expect(screen.at(-1)).toBe('live4');
  });

  it('repaints on a reconnect, and a newer attach supersedes one in flight', async () => {
    const get = recorded();
    const shell = connectedShell();
    const { term, reset } = fakeTerm();
    const onAttached = vi.fn();
    renderHook(() => useXtermShellAttach(shell, term, { ready: true, onAttached }));

    act(() => void shell.emit('status', 'connected'));
    act(() => void connectionManager.emit('on_reconnected'));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(get).toHaveBeenCalledTimes(2);
    expect(onAttached).toHaveBeenCalledTimes(1); // the first, superseded, never finished
    expect(onAttached.mock.calls[0][0].source).toBe('reconnected');
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('a disconnect stops live output reaching the terminal', async () => {
    recorded();
    const shell = connectedShell();
    const { term, screen } = fakeTerm();
    const onAttached = vi.fn();
    const onDetached = vi.fn();
    renderHook(() => useXtermShellAttach(shell, term, { ready: true, onAttached, onDetached }));
    act(() => void shell.emit('status', 'connected'));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());

    act(() => void shell.emit('status', 'disconnected'));
    shell.ptyConnection.appendOutput(b64('after'), 9);
    expect(screen).not.toContain('after');
    expect(onDetached).toHaveBeenCalled();
  });

  it('hands every chunk to onChunk and live output to a custom writer', async () => {
    recorded();
    const shell = connectedShell();
    shell.ptyConnection.appendOutput(b64('backlog'), 3);
    const { term, screen } = fakeTerm();
    const seen: number[] = [];
    const written: string[] = [];
    const onAttached = vi.fn();
    renderHook(() =>
      useXtermShellAttach(shell, term, {
        ready: true,
        onAttached,
        onChunk: (c) => void seen.push(c.seq),
        write: (d) => void written.push(d),
      }),
    );
    act(() => void shell.emit('status', 'connected'));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    shell.ptyConnection.appendOutput(b64('live'), 4);
    expect(seen).toEqual([3, 4]);
    expect(written).toEqual(['live']);
    expect(screen).toEqual(['HISTORY', 'backlog']);
  });

  it('waits for the view to be ready before it attaches', () => {
    const get = recorded();
    const shell = connectedShell();
    const { term } = fakeTerm();
    renderHook(() => useXtermShellAttach(shell, term, { ready: false }));
    act(() => void shell.emit('status', 'connected'));
    expect(get).not.toHaveBeenCalled();
  });
});
