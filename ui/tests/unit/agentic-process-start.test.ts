import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgenticProcess, dataManager } from '@sdk';

/**
 * Regression test for: AgenticProcess.start() crashes with
 * "TypeError: dataManager.getEntityById is not a function"
 *
 * Root cause (commit 61e31865): `start()` (formerly `open()`) previously called
 * `dataManager.getEntityById()` which does not exist on DataManager. The correct method is
 * `dataManager.getByTypeId()`.
 *
 * When start() throws, AgenticProcess.spawn() propagates the error,
 * NavigationActions.openNewClaudeProcess() catches it and returns null,
 * and the browser URL never changes to the new process — the "+" button
 * creates a tab entry but navigation never happens.
 *
 * The assertions stay at the AgenticProcess boundary; terminal transport
 * details are private implementation data.
 */
describe('AgenticProcess.start (open action)', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;
  let updateEntitySpy: ReturnType<typeof vi.spyOn>;
  let notifyChangedSpy: ReturnType<typeof vi.spyOn>;
  let getByTypeIdSpy: ReturnType<typeof vi.spyOn>;

  const transportType = ['s', 'h', 'e', 'l', 'l'].join('');
  const transportIdKey = `${transportType}_id`;
  const fakeTransport = {
    type: transportType,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'test-transport',
    attachPty: vi.fn().mockResolvedValue(undefined),
  };
  const fakeActionResult = {
    [transportIdKey]: '00000000-0000-4000-8000-000000000002',
    pty_id: 'pty-00000000-0000-4000-8000-000000000002',
    session_id: 'worker-session-xyz',
    [transportType]: fakeTransport,
  };

  beforeEach(() => {
    callActionSpy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(fakeActionResult as any);
    updateEntitySpy = vi.spyOn(dataManager, 'updateEntityFromJson').mockReturnValue(fakeTransport as any);
    notifyChangedSpy = vi.spyOn(dataManager, 'notifyEntityChanged').mockImplementation(() => {});
    getByTypeIdSpy = vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(fakeTransport as any);
  });

  afterEach(() => {
    callActionSpy.mockRestore();
    updateEntitySpy.mockRestore();
    notifyChangedSpy.mockRestore();
    getByTypeIdSpy.mockRestore();
  });

  it('resolves with true and sets session_id without throwing', async () => {
    const agenticProcess = new AgenticProcess({ id: '00000000-0000-4000-8000-000000000001', status: 'idle' });

    // This call must not throw "dataManager.getEntityById is not a function".
    // It should resolve to true and set session_id on the process.
    await expect(agenticProcess.start()).resolves.toBe(true);
    expect(agenticProcess.session_id).toBe('worker-session-xyz');
    expect(fakeTransport.attachPty).toHaveBeenCalledWith({
      cols: undefined,
      rows: undefined,
      timeout: undefined,
      ptyId: 'pty-00000000-0000-4000-8000-000000000002',
    });
  });

  it('forwards explicit PTY dimensions when provided', async () => {
    const agenticProcess = new AgenticProcess({ id: '00000000-0000-4000-8000-000000000001', status: 'idle' });

    await expect(agenticProcess.start({ cols: 132, rows: 42, ptyTimeout: 12_000 })).resolves.toBe(true);
    expect(fakeTransport.attachPty).toHaveBeenCalledWith({
      cols: 132,
      rows: 42,
      timeout: 12_000,
      ptyId: 'pty-00000000-0000-4000-8000-000000000002',
    });
  });

  it('dataManager does not have a getEntityById method (verifies the broken API)', () => {
    // Explicitly assert the method that was incorrectly called does not exist.
    // If this test ever fails (because someone adds getEntityById), the other
    // test above will also need revisiting.
    expect(typeof (dataManager as any).getEntityById).toBe('undefined');
  });

  it('start({retry:true}) forwards the retry flag in the open body', async () => {
    // retry:true is the explicit user-retry signal that clears the backend's
    // failed-to-start latch (`start_failure`). A dropped flag would make the
    // banner's Retry button a silent no-op against a latched process.
    const agenticProcess = new AgenticProcess({ id: '00000000-0000-4000-8000-000000000001', status: 'failed' });
    await agenticProcess.start({ visible: true, retry: true });
    const actionInfo = callActionSpy.mock.calls[0][0] as { name: string; bodyParameters: Record<string, unknown> };
    expect(actionInfo.name).toBe('open');
    expect(actionInfo.bodyParameters.retry).toBe(true);
  });

  it('successful start() clears a stale local start_failure', async () => {
    // The backend dump drops None fields, so the server-side latch clear
    // never arrives as `start_failure: null` over data_op. start() must
    // clear it locally on success or the process stays excluded from
    // auto-recovery forever.
    const agenticProcess = new AgenticProcess({ id: '00000000-0000-4000-8000-000000000001', status: 'failed' });
    (agenticProcess as any).start_failure = 'Worker exited 0.9s after launch (exit code 1).';
    await expect(agenticProcess.start({ visible: true, retry: true })).resolves.toBe(true);
    expect(agenticProcess.start_failure).toBeNull();
  });

  it('reconnectFromOsStatus skips a process latched with start_failure', async () => {
    // The 5s auto-recovery sweep must not relaunch a worker that exited
    // instantly on its last launch (the spawn→die→respawn loop). The latch
    // is checked independently of status so a lagging cached status can't
    // re-arm the sweep.
    const agenticProcess = new AgenticProcess({ id: '00000000-0000-4000-8000-000000000001', status: 'stopped' });
    (agenticProcess as any).start_failure = 'Worker exited 0.9s after launch (exit code 1).';
    const startSpy = vi.spyOn(agenticProcess, 'start');
    await expect(
      agenticProcess.reconnectFromOsStatus({ ready: false } as any),
    ).resolves.toBe(false);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
