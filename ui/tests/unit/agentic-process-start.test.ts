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
 */
describe('AgenticProcess.start (open action)', () => {
  let callActionSpy: ReturnType<typeof vi.spyOn>;
  let updateEntitySpy: ReturnType<typeof vi.spyOn>;
  let notifyChangedSpy: ReturnType<typeof vi.spyOn>;
  let getByTypeIdSpy: ReturnType<typeof vi.spyOn>;

  const fakeShell = { type: 'shell', id: '00000000-0000-4000-8000-000000000002', name: 'test-shell', startPty: vi.fn().mockResolvedValue(undefined), attachPty: vi.fn().mockResolvedValue(undefined) };
  const fakeActionResult = {
    shell_id: '00000000-0000-4000-8000-000000000002',
    session_id: 'worker-session-xyz',
    shell: fakeShell,
  };

  beforeEach(() => {
    callActionSpy = vi.spyOn(dataManager, 'callAction').mockResolvedValue(fakeActionResult as any);
    updateEntitySpy = vi.spyOn(dataManager, 'updateEntityFromJson').mockReturnValue(fakeShell as any);
    notifyChangedSpy = vi.spyOn(dataManager, 'notifyEntityChanged').mockImplementation(() => {});
    getByTypeIdSpy = vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(fakeShell as any);
  });

  afterEach(() => {
    callActionSpy.mockRestore();
    updateEntitySpy.mockRestore();
    notifyChangedSpy.mockRestore();
    getByTypeIdSpy.mockRestore();
  });

  it('resolves with true and sets shell_id and session_id without throwing', async () => {
    const agenticProcess = new AgenticProcess({ id: '00000000-0000-4000-8000-000000000001', status: 'idle' });

    // This call must not throw "dataManager.getEntityById is not a function".
    // It should resolve to true and set shell_id / session_id on the process.
    await expect(agenticProcess.start()).resolves.toBe(true);
    expect(agenticProcess.shell_id).toBe('00000000-0000-4000-8000-000000000002');
    expect(agenticProcess.session_id).toBe('worker-session-xyz');
  });

  it('dataManager does not have a getEntityById method (verifies the broken API)', () => {
    // Explicitly assert the method that was incorrectly called does not exist.
    // If this test ever fails (because someone adds getEntityById), the other
    // test above will also need revisiting.
    expect(typeof (dataManager as any).getEntityById).toBe('undefined');
  });
});
