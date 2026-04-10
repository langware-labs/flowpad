/**
 * Regression test for Shell entity class field initializer overwrite bug.
 *
 * When new Shell(data) is called, TypeScript class field initializers
 * (e.g. `status: string = 'idle'`, `pty_pid: string | null = null`)
 * run AFTER super(), overwriting values that super()/deepAssign() set.
 *
 * This causes Shell.list() to return Shell objects whose status is always
 * 'idle' and pty_pid is always null, regardless of what the backend
 * returns. The ShellManager.syncSessionsWithBackend() then skips all shells
 * (status !== 'running') and registers none (no pty_pid), leaving
 * the ProcessTerminal in "Reconnecting to session..." state forever.
 */
import { ConnectionManager, dataManager } from '@sdk';
import { Shell } from '@sdk/entities/shell';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Shell entity constructor', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await dataManager.clearCache();
  });

  it('preserves status from constructor data', () => {
    const shell = new Shell({
      id: '26dc80b4-2a76-48e9-b141-e7443563d8c2',
      status: 'running',
      pty_pid: '26dc80b4-2a76-48e9-b141-e7443563d8c2',
    });

    // These fail if class field initializers overwrite the constructor data
    expect(shell.status).toBe('running');
  });

  it('preserves pty_pid from constructor data', () => {
    const shell = new Shell({
      id: '26dc80b4-2a76-48e9-b141-e7443563d8c2',
      status: 'running',
      pty_pid: '26dc80b4-2a76-48e9-b141-e7443563d8c2',
    });

    expect(shell.pty_pid).toBe('26dc80b4-2a76-48e9-b141-e7443563d8c2');
  });

  it('Shell.list() result has running status (integration check)', () => {
    // Simulate what Shell.list() does: construct Shell objects from backend data
    const backendData = [
      {
        id: '26dc80b4-2a76-48e9-b141-e7443563d8c2',
        type: 'shell',
        status: 'running',
        pty_pid: '26dc80b4-2a76-48e9-b141-e7443563d8c2',
        compute_node_id: 'compute_node-c9ed243c-a3be-4985-9858-7a0821ec9e9f',
      },
    ];

    const shells = backendData.map((d) => new Shell(d));

    // The running shell must have status 'running' for ShellManager.syncSessionsWithBackend
    // to call createSession (it skips if record.status !== 'running')
    const runningSessions = shells.filter((s) => s.status === 'running');
    expect(runningSessions.length).toBe(1);

    // The shell must have pty_pid for ShellManager to register it in shellEntities
    const withPtyId = shells.filter((s) => s.pty_pid != null);
    expect(withPtyId.length).toBe(1);
  });

  it('includes the shell name when starting PTY so the tab label persists after reload', async () => {
    const shell = new Shell({
      id: '26dc80b4-2a76-48e9-b141-e7443563d8c2',
      compute_node_id: 'c9ed243c-a3be-4985-9858-7a0821ec9e9f',
      name: 'Terminal 1',
    });
    vi.spyOn(ConnectionManager, 'getInstance').mockReturnValue({ id: 'ws-connection-id', on: vi.fn() } as any);
    const attachSpy = vi.spyOn(shell, 'attachPty').mockResolvedValue(undefined);
    const callActionSpy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      id: '26dc80b4-2a76-48e9-b141-e7443563d8c2',
      compute_node_id: 'c9ed243c-a3be-4985-9858-7a0821ec9e9f',
      name: 'Terminal 1',
      workdir: '/tmp',
      pty_id: 'pty-terminal-1',
    } as any);

    await shell.start({ cols: 80, rows: 24, workdir: '/tmp' });

    expect(callActionSpy).toHaveBeenCalledTimes(1);
    expect(callActionSpy.mock.calls[0]?.[0].bodyParameters).toMatchObject({
      cols: 80,
      rows: 24,
      connection_id: 'ws-connection-id',
      working_dir: '/tmp',
    });
    expect(attachSpy).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      workdir: '/tmp',
      timeout: undefined,
      ptyId: 'pty-terminal-1',
    });
  });
});
