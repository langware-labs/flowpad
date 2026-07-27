import { ContextEntitiesEnum, dataContext, DockPointerData, Shell, ViewType } from '@sdk';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { openNewChat } from '@src/navigation/open-new-chat';
import * as chatMode from '@src/contexts/chat-ui-mode-context';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('openNewChat + NavigationActions', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  /** The chat mode decides BOTH halves of the launch: transport (only `terminal`
   *  runs a PTY) and surface. These pin the createProcess args per mode so the
   *  one chain can't drift back to a hardcoded transport. */
  function stubComputeNode() {
    const startSpy = vi.fn();
    const createProcessSpy = vi.fn().mockResolvedValue({
      id: 'process-123',
      shell_id: null,
      dockPointer: new DockPointerData(ViewType.SHELL, 'agentic_process-process-123'),
      terminalDockPointer: new DockPointerData(ViewType.SHELL, 'agentic_process-process-123'),
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
    return { createProcessSpy, startSpy };
  }

  it('launches a terminal chat on a PTY, without eagerly starting it', async () => {
    const { createProcessSpy, startSpy } = stubComputeNode();
    vi.spyOn(chatMode, 'getChatMode').mockReturnValue('terminal');
    const navigation = new NavigationActions(vi.fn(), null);
    const openShell = vi.spyOn(navigation, 'openShellProcess').mockResolvedValue(null);

    const process = await openNewChat(navigation);

    expect(createProcessSpy).toHaveBeenCalledWith(
      { workdir: '/tmp/project' },
      { watchProcess: false, visible: true, pty_mode: true },
    );
    expect(startSpy).not.toHaveBeenCalled();
    expect(process?.id).toBe('process-123');
    expect(openShell).toHaveBeenCalledWith('process-123', { chatMode: 'terminal' });
  });

  it('launches a chat-mode chat headless', async () => {
    const { createProcessSpy } = stubComputeNode();
    vi.spyOn(chatMode, 'getChatMode').mockReturnValue('chat');
    const navigation = new NavigationActions(vi.fn(), null);
    const openShell = vi.spyOn(navigation, 'openShellProcess').mockResolvedValue(null);

    await openNewChat(navigation);

    expect(createProcessSpy).toHaveBeenCalledWith(
      { workdir: '/tmp/project', outputFormat: 'stream-json' },
      { watchProcess: false, visible: false, pty_mode: false },
    );
    expect(openShell).toHaveBeenCalledWith('process-123', { chatMode: 'chat' });
  });

  it('launches a vibe chat headless and carries the vibe view mode', async () => {
    const { createProcessSpy } = stubComputeNode();
    vi.spyOn(chatMode, 'getChatMode').mockReturnValue('vibe');
    const navigation = new NavigationActions(vi.fn(), null);
    const openShell = vi.spyOn(navigation, 'openShellProcess').mockResolvedValue(null);

    await openNewChat(navigation);

    expect(createProcessSpy).toHaveBeenCalledWith(
      { workdir: '/tmp/project', outputFormat: 'stream-json' },
      { watchProcess: false, visible: false, pty_mode: false },
    );
    expect(openShell).toHaveBeenCalledWith('process-123', { chatMode: 'vibe', viewMode: 'vibe' });
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
