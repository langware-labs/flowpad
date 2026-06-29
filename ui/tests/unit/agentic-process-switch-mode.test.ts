import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgenticProcess, WorkerMode, dataManager } from '@sdk';

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
});
