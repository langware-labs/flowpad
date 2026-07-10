import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgenticProcess, ProcessStatus, WorkerMode, dataManager, type IAgenticProcess } from '@sdk';

interface SwitchModeInternals {
  _pendingPtyMode?: boolean;
  _pendingVisible?: boolean;
}

/**
 * `AgenticProcess.switchMode(mode)` — the single, standardized transport switch
 * the ribbon chat⇄terminal toggle drives. Frontend → backend:
 *   - WorkerMode.CLI         → one `switch-mode` action {mode:'cli'}; flips
 *                              visible=false, pty_mode=false (kill PTY, headless).
 *   - WorkerMode.Interactive → the canonical `open` path (start()) for the live
 *                              PTY attach; pty_mode=true.
 * Routing stays headless == !visible. Asserts at the AgenticProcess boundary
 * (which action + body, and the resulting durable flags) — the same level the
 * backend pytest (`test_agentic_process_switch_mode.py`) asserts the action.
 */
describe('AgenticProcess.switchMode', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;
  let updateEntitySpy: ReturnType<typeof vi.spyOn>;
  let getByTypeIdSpy: ReturnType<typeof vi.spyOn>;
  let notifyChangedSpy: ReturnType<typeof vi.spyOn>;

  const shellType = ['s', 'h', 'e', 'l', 'l'].join('');
  const fakeShell = {
    type: shellType,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'test-shell',
    attachPty: vi.fn().mockResolvedValue(undefined),
  };
  const fakeOpenResult = {
    shell_id: '00000000-0000-4000-8000-000000000002',
    pty_id: 'pty-00000000-0000-4000-8000-000000000002',
    session_id: 'worker-session-xyz',
    status: 'running',
    shell: fakeShell,
  };

  beforeEach(() => {
    fakeShell.attachPty.mockClear();
    callActionSpy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(fakeOpenResult as any);
    updateEntitySpy = vi.spyOn(dataManager, 'updateEntityFromJson').mockReturnValue(fakeShell as any);
    getByTypeIdSpy = vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(fakeShell as any);
    notifyChangedSpy = vi.spyOn(dataManager, 'notifyEntityChanged').mockImplementation(() => {});
  });
  afterEach(() => {
    callActionSpy.mockRestore();
    updateEntitySpy.mockRestore();
    getByTypeIdSpy.mockRestore();
    notifyChangedSpy.mockRestore();
  });

  it('CLI → calls the switch-mode action {mode:cli} and flips to headless', async () => {
    const p = new AgenticProcess({
      id: '00000000-0000-4000-8000-000000000001',
      status: 'idle',
      visible: true,
      pty_mode: true,
    } as any);

    await p.switchMode(WorkerMode.CLI);

    expect(callActionSpy).toHaveBeenCalledTimes(1);
    const action = callActionSpy.mock.calls[0][0] as any;
    expect(action.name).toBe('switch-mode');
    expect(action.bodyParameters.mode).toBe(WorkerMode.CLI); // 'cli'
    // Frontend calls backend, then mirrors the durable transport intent.
    expect(p.visible).toBe(false);
    expect(p.pty_mode).toBe(false);
  });

  it('Interactive → routes through the open path and flips to PTY', async () => {
    const p = new AgenticProcess({
      id: '00000000-0000-4000-8000-000000000001',
      status: 'idle',
      visible: false,
      pty_mode: false,
    } as any);
    const emitSpy = vi.spyOn(p, 'emit');

    await p.switchMode(WorkerMode.Interactive);

    // PTY direction goes through start() → the `open` action (live attach).
    const names = callActionSpy.mock.calls.map((c) => (c[0] as any).name);
    expect(names).toContain('open');
    expect(p.pty_mode).toBe(true);
    // 'restarted' tells the terminal to clear + re-attach the fresh PTY.
    expect(emitSpy).toHaveBeenCalledWith('restarted', expect.anything());
  });

  it('Interactive rejection restores the prior headless intent and desired-value latches', async () => {
    const error = new Error('Failed to create PTY session: embedded null byte');
    callActionSpy.mockRejectedValueOnce(error);
    const p = new AgenticProcess({
      id: '00000000-0000-4000-8000-000000000001',
      status: ProcessStatus.STOPPED,
      visible: false,
      pty_mode: false,
      session_id: 'worker-session-xyz',
    } satisfies Partial<IAgenticProcess>);
    // A process that previously switched to CLI carries false desired-value
    // latches. A failed return to PTY must restore them instead of pinning true.
    const internals = p as unknown as SwitchModeInternals;
    internals._pendingPtyMode = false;
    internals._pendingVisible = false;
    const emitSpy = vi.spyOn(p, 'emit');

    await expect(p.switchMode(WorkerMode.Interactive)).rejects.toBe(error);

    expect(p.pty_mode).toBe(false);
    expect(p.visible).toBe(false);
    expect(internals._pendingPtyMode).toBe(false);
    expect(internals._pendingVisible).toBe(false);
    expect(fakeShell.attachPty).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalledWith('restarted', expect.anything());
  });

  it('Interactive can retry once after a rejected open without duplicate attach or restart events', async () => {
    const error = new Error('Failed to create PTY session: embedded null byte');
    callActionSpy.mockRejectedValueOnce(error).mockResolvedValueOnce(fakeOpenResult as never);
    const p = new AgenticProcess({
      id: '00000000-0000-4000-8000-000000000001',
      status: ProcessStatus.STOPPED,
      visible: false,
      pty_mode: false,
      session_id: 'worker-session-xyz',
    } satisfies Partial<IAgenticProcess>);
    const emitSpy = vi.spyOn(p, 'emit');

    await expect(p.switchMode(WorkerMode.Interactive)).rejects.toBe(error);
    await expect(p.switchMode(WorkerMode.Interactive)).resolves.toBeUndefined();

    const openActions = callActionSpy.mock.calls.filter((call) => call[0].name === 'open');
    expect(openActions).toHaveLength(2);
    expect(fakeShell.attachPty).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls.filter(([event]) => event === 'restarted')).toHaveLength(1);
    expect(p.pty_mode).toBe(true);
  });
});
