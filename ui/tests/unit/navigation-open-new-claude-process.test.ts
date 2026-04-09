import { ContextEntitiesEnum, dataContext, DockPointerData, Shell, ViewType } from '@sdk';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('NavigationActions.openNewClaudeProcess', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  it('creates an idle process record without eagerly starting it', async () => {
    const startSpy = vi.fn();
    const createProcessSpy = vi.fn().mockResolvedValue({
      id: 'process-123',
      shell_id: null,
      dockPointer: new DockPointerData(ViewType.SHELL, 'agentic_process-process-123'),
      start: startSpy,
    });

    vi.spyOn(dataContext, 'getContextEntity').mockImplementation((entityKey) => {
      if (entityKey === ContextEntitiesEnum.CurrentComputeNodeTypeId) {
        return { createProcess: createProcessSpy } as any;
      }
      if (entityKey === ContextEntitiesEnum.CurrentProjectTypeId) {
        return { fs_storage_mount_path: '/tmp/project' } as any;
      }
      return null;
    });

    const navigation = new NavigationActions(vi.fn(), null);
    const result = await navigation.openNewClaudeProcess();

    expect(createProcessSpy).toHaveBeenCalledWith(
      { workdir: '/tmp/project' },
      { watchProcess: false, visible: true },
    );
    expect(startSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      processId: 'process-123',
      shellId: null,
      dockPointer: new DockPointerData(ViewType.SHELL, 'agentic_process-process-123'),
    });
  });

  it('creates a plain shell without eagerly starting it', async () => {
    const startSpy = vi.fn();
    const saveSpy = vi.fn().mockResolvedValue(undefined);
    const fakeShell = {
      id: 'shell-123',
      workdir: '/tmp/project',
      save: saveSpy,
      start: startSpy,
    };

    vi.spyOn(dataContext, 'getContextEntity').mockImplementation((entityKey) => {
      if (entityKey === ContextEntitiesEnum.CurrentComputeNodeTypeId) {
        return { id: 'compute-node-1', typeId: { toString: () => 'compute_node-compute-node-1' } } as any;
      }
      if (entityKey === ContextEntitiesEnum.CurrentProjectTypeId) {
        return { fs_storage_mount_path: '/tmp/project' } as any;
      }
      return null;
    });
    vi.spyOn(Shell, 'list').mockResolvedValue([] as any);
    vi.spyOn(Shell, 'create').mockReturnValue(fakeShell as any);

    const navigation = new NavigationActions(vi.fn(), null);
    const openShellSpy = vi.spyOn(navigation, 'openShell').mockResolvedValue(fakeShell as any);

    const result = await navigation.openNewShell();

    expect(saveSpy).toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(openShellSpy).toHaveBeenCalledWith('shell-123', undefined);
    expect(result).toEqual({ shellId: 'shell-123' });
  });

  it('deduplicates identical dock navigation while the first navigation is still in flight', () => {
    window.history.pushState({}, '', '/dock/shell');

    const navigate = vi.fn();
    const navigation = new NavigationActions(navigate, null);
    const pointer = new DockPointerData(ViewType.SHELL, 'agentic_process-process-123');

    navigation.openDock(pointer);
    navigation.openDock(pointer);

    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
