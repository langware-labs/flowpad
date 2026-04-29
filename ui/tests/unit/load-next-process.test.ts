/**
 * Unit tests for `loadNextProcess` — the single recovery primitive that picks
 * the next-best visible process/shell tab, runs cleanup on typed failures, and
 * advances until something loads or candidates run out.
 */

import { ShellStatus } from '@sdk';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as loadShellMod from '@src/routes/loaders/load-shell';
import * as loadProcessMod from '@src/routes/loaders/load-process';
import { loadNextProcess } from '@src/routes/loaders/load-next-process';
import { ShellLoadError } from '@src/routes/loaders/load-shell';
import { ProcessLoadError } from '@src/routes/loaders/load-process';

function makeShell(id: string, status: string = ShellStatus.RUNNING) {
  return {
    id,
    status,
    tab_order: 0,
    name: null,
    collaboration_room_id: null,
    dockPointer: { pointer: `shell-${id}` },
    close: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeProcess(id: string, shellId: string, status = 'starting') {
  return {
    id,
    shell_id: shellId,
    status,
    dockPointer: { pointer: `agentic_process-${id}` },
  } as any;
}

describe('loadNextProcess', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let loadProcessSpy: ReturnType<typeof vi.spyOn>;
  let loadShellSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(loadShellMod, 'fetchShellsAndProcesses');
    loadProcessSpy = vi.spyOn(loadProcessMod, 'loadProcess');
    loadShellSpy = vi.spyOn(loadShellMod, 'loadShell');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    loadProcessSpy.mockRestore();
    loadShellSpy.mockRestore();
  });

  // ── empty-list / first-try / passthrough ──────────────────────────────────

  it('returns loaded:null and cleaned:[] when no candidates exist', async () => {
    fetchSpy.mockResolvedValue([[], []]);

    const result = await loadNextProcess();

    expect(result.loaded).toBeNull();
    expect(result.cleaned).toEqual([]);
    expect(loadProcessSpy).not.toHaveBeenCalled();
    expect(loadShellSpy).not.toHaveBeenCalled();
  });

  it('returns the loaded process on first try when nothing is broken', async () => {
    const shell = makeShell('shell-a');
    const proc = makeProcess('proc-a', 'shell-a');
    fetchSpy.mockResolvedValue([[shell], [proc]]);
    loadProcessSpy.mockResolvedValue({ process: proc, shell });

    const result = await loadNextProcess();

    expect(result.cleaned).toEqual([]);
    expect(result.loaded?.kind).toBe('process');
    if (result.loaded?.kind === 'process') {
      expect(result.loaded.process.id).toBe('proc-a');
    }
    expect(loadProcessSpy).toHaveBeenCalledTimes(1);
    expect(loadProcessSpy).toHaveBeenCalledWith('proc-a');
  });

  // ── per-kind cleanup dispatch ─────────────────────────────────────────────

  it('records process_not_found cleanup and advances', async () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const procA = makeProcess('proc-a', 'shell-a');
    const procB = makeProcess('proc-b', 'shell-b');
    fetchSpy.mockResolvedValue([[shellA, shellB], [procA, procB]]);
    loadProcessSpy
      .mockRejectedValueOnce(new ProcessLoadError('not_found', 'proc-a'))
      .mockResolvedValueOnce({ process: procB, shell: shellB });

    const result = await loadNextProcess();

    expect(result.cleaned).toHaveLength(1);
    expect(result.cleaned[0].kind).toBe('process_not_found');
    expect(result.cleaned[0].processId).toBe('proc-a');
    expect(result.loaded?.kind).toBe('process');
  });

  it('records process_start_failed cleanup with description', async () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const procA = makeProcess('proc-a', 'shell-a');
    const procB = makeProcess('proc-b', 'shell-b');
    fetchSpy.mockResolvedValue([[shellA, shellB], [procA, procB]]);
    loadProcessSpy
      .mockRejectedValueOnce(new ProcessLoadError('start_failed', 'proc-a', 'shell-a', new Error('PTY 5 not found')))
      .mockResolvedValueOnce({ process: procB, shell: shellB });

    const result = await loadNextProcess();

    expect(result.cleaned).toHaveLength(1);
    expect(result.cleaned[0].kind).toBe('process_start_failed');
    expect(result.cleaned[0].title).toContain('Terminal reattach failed');
  });

  it('records process_no_shell cleanup', async () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const procA = makeProcess('proc-a', 'shell-a');
    const procB = makeProcess('proc-b', 'shell-b');
    fetchSpy.mockResolvedValue([[shellA, shellB], [procA, procB]]);
    loadProcessSpy
      .mockRejectedValueOnce(new ProcessLoadError('no_shell', 'proc-a', null))
      .mockResolvedValueOnce({ process: procB, shell: shellB });

    const result = await loadNextProcess();

    expect(result.cleaned[0].kind).toBe('process_no_shell');
    expect(result.cleaned[0].title).toBe('Session unavailable');
  });

  it('records process_project_missing cleanup', async () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const procA = makeProcess('proc-a', 'shell-a');
    const procB = makeProcess('proc-b', 'shell-b');
    fetchSpy.mockResolvedValue([[shellA, shellB], [procA, procB]]);
    loadProcessSpy
      .mockRejectedValueOnce(new ProcessLoadError('project_missing', 'proc-a', 'shell-a'))
      .mockResolvedValueOnce({ process: procB, shell: shellB });

    const result = await loadNextProcess();

    expect(result.cleaned[0].kind).toBe('process_project_missing');
    expect(result.cleaned[0].title).toBe('Project not found');
  });

  // ── advance-then-success / multiple cleanups ─────────────────────────────

  it('handles multiple failures before finding a working candidate', async () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const shellC = makeShell('shell-c');
    const procA = makeProcess('proc-a', 'shell-a');
    const procB = makeProcess('proc-b', 'shell-b');
    const procC = makeProcess('proc-c', 'shell-c');
    fetchSpy.mockResolvedValue([[shellA, shellB, shellC], [procA, procB, procC]]);
    loadProcessSpy
      .mockRejectedValueOnce(new ProcessLoadError('not_found', 'proc-a'))
      .mockRejectedValueOnce(new ProcessLoadError('no_shell', 'proc-b'))
      .mockResolvedValueOnce({ process: procC, shell: shellC });

    const result = await loadNextProcess();

    expect(result.cleaned).toHaveLength(2);
    expect(result.cleaned.map((c) => c.kind)).toEqual([
      'process_not_found',
      'process_no_shell',
    ]);
    expect(result.loaded?.kind).toBe('process');
    if (result.loaded?.kind === 'process') {
      expect(result.loaded.process.id).toBe('proc-c');
    }
  });

  it('returns loaded:null with all cleanups when every candidate fails', async () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const procA = makeProcess('proc-a', 'shell-a');
    const procB = makeProcess('proc-b', 'shell-b');
    fetchSpy.mockResolvedValue([[shellA, shellB], [procA, procB]]);
    loadProcessSpy
      .mockRejectedValueOnce(new ProcessLoadError('not_found', 'proc-a'))
      .mockRejectedValueOnce(new ProcessLoadError('not_found', 'proc-b'));

    const result = await loadNextProcess();

    expect(result.loaded).toBeNull();
    expect(result.cleaned).toHaveLength(2);
  });

  // ── shell-only tabs ───────────────────────────────────────────────────────

  it('loadShell-path: best-effort close on shell start_failed', async () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    fetchSpy.mockResolvedValue([[shellA, shellB], []]); // no processes

    // Mock Shell.getByIdFromCache to return our spy-able shell
    const shellModule = await import('@sdk');
    const cacheSpy = vi.spyOn(shellModule.Shell, 'getByIdFromCache');
    cacheSpy.mockReturnValue(shellA as any);

    loadShellSpy
      .mockRejectedValueOnce(new ShellLoadError('start_failed', 'shell-a', null, new Error('worker dead')))
      .mockResolvedValueOnce(shellB);

    const result = await loadNextProcess();

    expect(result.cleaned).toHaveLength(1);
    expect(result.cleaned[0].kind).toBe('shell_start_failed');
    expect(shellA.close).toHaveBeenCalledTimes(1);
    expect(result.loaded?.kind).toBe('shell');

    cacheSpy.mockRestore();
  });

  // ── re-throw on non-typed errors ──────────────────────────────────────────

  it('re-throws plain Error (not ProcessLoadError) without consuming candidate', async () => {
    const shellA = makeShell('shell-a');
    const procA = makeProcess('proc-a', 'shell-a');
    fetchSpy.mockResolvedValue([[shellA], [procA]]);
    loadProcessSpy.mockRejectedValueOnce(new Error('Network down'));

    await expect(loadNextProcess()).rejects.toThrow('Network down');
    expect(loadProcessSpy).toHaveBeenCalledTimes(1);
  });

  // ── excludeIds ────────────────────────────────────────────────────────────

  it('excludeIds prevents the listed id from being picked', async () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    const procA = makeProcess('proc-a', 'shell-a');
    const procB = makeProcess('proc-b', 'shell-b');
    fetchSpy.mockResolvedValue([[shellA, shellB], [procA, procB]]);
    loadProcessSpy.mockResolvedValueOnce({ process: procB, shell: shellB });

    const result = await loadNextProcess({ excludeIds: new Set(['proc-a']) });

    expect(loadProcessSpy).toHaveBeenCalledTimes(1);
    expect(loadProcessSpy).toHaveBeenCalledWith('proc-b');
    expect(result.loaded?.kind).toBe('process');
  });

  it('excludeIds filters by shell id too', async () => {
    const shellA = makeShell('shell-a');
    const shellB = makeShell('shell-b');
    fetchSpy.mockResolvedValue([[shellA, shellB], []]);
    loadShellSpy.mockResolvedValueOnce(shellB);

    const result = await loadNextProcess({ excludeIds: new Set(['shell-a']) });

    expect(loadShellSpy).toHaveBeenCalledTimes(1);
    expect(loadShellSpy).toHaveBeenCalledWith('shell-b');
    expect(result.loaded?.kind).toBe('shell');
  });
});
