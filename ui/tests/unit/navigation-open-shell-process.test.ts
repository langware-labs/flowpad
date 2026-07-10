import { AgenticProcess, DockPointerData, ViewType } from '@sdk';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('NavigationActions.openShellProcess', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  it('opens a cached Codex process from Standard Home when no view-mode options are provided', async () => {
    window.history.pushState({}, '', '/');
    const terminalDockPointer = new DockPointerData(ViewType.SHELL, 'agentic_process-codex-process-123');
    const process = {
      id: 'codex-process-123',
      worker_type: 'codex',
      terminalDockPointer,
    };
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(process as AgenticProcess);

    const navigation = new NavigationActions(vi.fn(), null);
    const openDockSpy = vi.spyOn(navigation, 'openDock').mockImplementation(() => undefined);

    await expect(navigation.openShellProcess(process.id)).resolves.toBe(process);
    expect(openDockSpy).toHaveBeenCalledWith(terminalDockPointer, undefined);
  });
});
