import { ContextEntitiesEnum, dataContext, DockPointerData, Shell, ViewType } from '@sdk';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { openNewChat } from '@src/navigation/open-new-chat';
import * as viewMode from '@src/contexts/view-mode-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The persona embed is the seam the chat surface routes through. Spy on it: the
// real helper resolves its ref through the backend, so asserting the low-level
// loadEmbeddedSubagent would need a live server.
const embedMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@src/navigation/embed-standard-agent', () => ({ embedStandardAgent: embedMock }));

describe('openNewChat + NavigationActions', () => {
  beforeEach(() => {
    embedMock.mockClear();
    embedMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  /** The view mode decides ALL THREE halves of the launch: transport (only the
   *  terminal surface runs a PTY), surface, and persona (only the chat surface
   *  embeds the `standard` agent). These pin the createProcess args per mode so
   *  the one chain can't drift back to a hardcoded transport. */
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

  it('launches a Terminal-mode chat on a PTY, without eagerly starting it', async () => {
    const { createProcessSpy, startSpy } = stubComputeNode();
    vi.spyOn(viewMode, 'getViewMode').mockReturnValue(viewMode.ViewMode.Advanced);
    const navigation = new NavigationActions(vi.fn(), null);
    const openShell = vi.spyOn(navigation, 'openShellProcess').mockResolvedValue(null);

    const process = await openNewChat(navigation);

    expect(createProcessSpy).toHaveBeenCalledWith(
      { workdir: '/tmp/project' },
      { watchProcess: false, visible: true, pty_mode: true },
    );
    expect(startSpy).not.toHaveBeenCalled();
    expect(process?.id).toBe('process-123');
    expect(openShell).toHaveBeenCalledWith('process-123', { viewMode: 'advanced' });
    // Terminal is a raw PTY passthrough — the user drives the CLI directly.
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('launches a Chat-mode chat headless', async () => {
    const { createProcessSpy } = stubComputeNode();
    vi.spyOn(viewMode, 'getViewMode').mockReturnValue(viewMode.ViewMode.Standard);
    const navigation = new NavigationActions(vi.fn(), null);
    const openShell = vi.spyOn(navigation, 'openShellProcess').mockResolvedValue(null);

    const process = await openNewChat(navigation);

    expect(createProcessSpy).toHaveBeenCalledWith(
      { workdir: '/tmp/project', outputFormat: 'stream-json' },
      { watchProcess: false, visible: false, pty_mode: false },
    );
    expect(openShell).toHaveBeenCalledWith('process-123', { viewMode: 'standard' });
    // FLOWPAD-1993: a chat-surface session boots WITH the `standard` persona.
    // Without it the worker gets no system instructions at all and falls back to
    // describing deliverables in prose instead of `flow show`-ing them.
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledWith(process);
  });

  it('launches a vibe chat headless and carries the vibe view mode', async () => {
    const { createProcessSpy } = stubComputeNode();
    vi.spyOn(viewMode, 'getViewMode').mockReturnValue(viewMode.ViewMode.Vibe);
    const navigation = new NavigationActions(vi.fn(), null);
    const openShell = vi.spyOn(navigation, 'openShellProcess').mockResolvedValue(null);

    await openNewChat(navigation);

    expect(createProcessSpy).toHaveBeenCalledWith(
      { workdir: '/tmp/project', outputFormat: 'stream-json' },
      { watchProcess: false, visible: false, pty_mode: false },
    );
    expect(openShell).toHaveBeenCalledWith('process-123', { viewMode: 'vibe' });
    // Vibe embeds its own persona through createVibeProcessForProject; this
    // chain must not layer the chat one on top.
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('does not embed the chat persona in Dev mode', async () => {
    stubComputeNode();
    vi.spyOn(viewMode, 'getViewMode').mockReturnValue(viewMode.ViewMode.Dev);
    const navigation = new NavigationActions(vi.fn(), null);
    vi.spyOn(navigation, 'openShellProcess').mockResolvedValue(null);

    await openNewChat(navigation);

    expect(embedMock).not.toHaveBeenCalled();
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

  it('releases a pending dock after its loader redirects to a canonical URL', () => {
    window.history.pushState({}, '', '/dock/home');
    const navigate = vi.fn();
    const navigation = new NavigationActions(navigate, null);
    const pointer = new DockPointerData(ViewType.SHELL, 'agentic_process-p1');

    navigation.openDock(pointer);
    expect(navigate).toHaveBeenCalledTimes(1);

    // The loader redirects; the browser lands on the same dock PLUS scope params.
    window.history.pushState({}, '', '/dock/shell/agentic_process-p1?scope-mode=project&scope-activeProjectId=proj-1');

    // The redirect is a committed departure from the stamped source, so the
    // same bare dock can be requested again immediately.
    navigation.openDock(pointer);
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});
