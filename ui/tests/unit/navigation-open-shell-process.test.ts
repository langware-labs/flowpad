import { AgenticProcess, DockPointerData, ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression suite for C03: Quick Create (Standard view) starts the process but
// the browser stays on Home because openShellProcess crashed with
// "Cannot read properties of undefined (reading 'viewMode')" whenever it was
// called without navigation options.
describe('NavigationActions.openShellProcess', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  function setup() {
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
    return { process, terminalDockPointer, navigation, openDockSpy };
  }

  it('opens a cached Codex process from Standard Home when no view-mode options are provided', async () => {
    const { process, terminalDockPointer, navigation, openDockSpy } = setup();

    await expect(navigation.openShellProcess(process.id)).resolves.toBe(process);
    expect(openDockSpy).toHaveBeenCalledTimes(1);
    expect(openDockSpy.mock.calls[0][0]).toBe(terminalDockPointer);
  });

  it('opens the terminal dock when options are an explicit empty object', async () => {
    const { process, terminalDockPointer, navigation, openDockSpy } = setup();

    await expect(navigation.openShellProcess(process.id, {})).resolves.toBe(process);
    expect(openDockSpy).toHaveBeenCalledTimes(1);
    expect(openDockSpy.mock.calls[0][0]).toBe(terminalDockPointer);
  });

  it('opens the terminal dock when every option value is nullish (stringified record is empty)', async () => {
    const { process, terminalDockPointer, navigation, openDockSpy } = setup();

    await expect(navigation.openShellProcess(process.id, { viewMode: undefined as unknown as string })).resolves.toBe(
      process,
    );
    expect(openDockSpy).toHaveBeenCalledTimes(1);
    expect(openDockSpy.mock.calls[0][0]).toBe(terminalDockPointer);
  });

  it('routes viewMode=vibe to the Display surface and forwards the option to openDock', async () => {
    const { process, navigation, openDockSpy } = setup();

    await expect(navigation.openShellProcess(process.id, { viewMode: 'vibe' })).resolves.toBe(process);
    expect(openDockSpy).toHaveBeenCalledTimes(1);
    const [dock, extraOptions] = openDockSpy.mock.calls[0];
    expect(dock).toBeInstanceOf(DockPointer);
    expect((dock as DockPointer).viewType).toBe(ViewType.DISPLAY);
    expect((dock as DockPointer).pointer).toBe(`agentic_process-${process.id}`);
    expect(extraOptions).toEqual({ viewMode: 'vibe' });
  });
});
