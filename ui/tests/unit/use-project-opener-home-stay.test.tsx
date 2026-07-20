/**
 * useProjectOpener — the surface-derived project-switch decision matrix.
 *
 * "Open a project on home — ANY home, any view mode — stays home on the new
 * project." Pins the four navigation outcomes of setCurrentProjectContext
 * (reached through ensureProjectAndSetContext) plus the gate/map bypass, so
 * the home-stay invariant can't drift again per call site (the original bug:
 * a resurrected inline copy of this flow lost the home guard and vibe-home
 * switches resumed the target's agentic process).
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable surface state, read by the mocked navigation/view-mode hooks.
const surface = vi.hoisted(() => ({ isHome: true, isVibe: true }));
const openDock = vi.hoisted(() => vi.fn());
const openShellProcess = vi.hoisted(() => vi.fn());
const selectProjectContextMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const processIdMock = vi.hoisted(() => vi.fn(() => Promise.resolve<string | null>(null)));
const dockForProjectEntryMock = vi.hoisted(() => vi.fn());

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock, openShellProcess } }),
  useIsHomeSurface: () => surface.isHome,
}));
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsVibe: () => surface.isVibe,
}));
vi.mock('@src/components/project-selector', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selectProjectContext: selectProjectContextMock,
}));
vi.mock('@src/tabs/project-entry', () => ({
  agenticProcessIdForProjectEntry: processIdMock,
  dockForProjectEntry: dockForProjectEntryMock,
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: null }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { dataContext, Project, type TypeId } from '@sdk';
import { projectScope } from '@src/lib/scope-filter';
import { ViewType } from '@src/types/ViewType';
import { useProjectOpener, type UseProjectOpenerOptions } from '@src/components/open-project-component/use-open-project';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROC_ID = '22222222-2222-4222-8222-222222222222';
const PATH = '/proj/switch-target';

const targetProject = {
  id: PROJECT_ID,
  name: PATH,
  fs_storage_mount_path: PATH,
  setupForDesktop: vi.fn(() => Promise.resolve()),
} as unknown as Project;

async function openViaHook(options: UseProjectOpenerOptions = {}) {
  const { result } = renderHook(() => useProjectOpener(options));
  await result.current.ensureProjectAndSetContext(PATH);
}

describe('useProjectOpener — home stays home on the new project', () => {
  let setActiveEntitySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    surface.isHome = true;
    surface.isVibe = true;
    vi.spyOn(Project, 'query').mockResolvedValue([targetProject]);
    // `someone` → localUserTypeId (computed) → getContextEntityTypeId; stub
    // the leaf so the hook sees a logged-in user.
    vi.spyOn(dataContext, 'getContextEntityTypeId').mockReturnValue({ id: 'user' } as unknown as TypeId);
    setActiveEntitySpy = vi.spyOn(dataContext, 'setActiveEntityTypeId').mockResolvedValue(undefined as never);
    vi.spyOn(dataContext, 'setContextEntityTypeId').mockResolvedValue(undefined as never);
  });

  it('home + vibe → fresh vibe home carrying the project scope, NO process resume', async () => {
    processIdMock.mockResolvedValue(PROC_ID); // a process exists — must be ignored on home

    await openViaHook();

    expect(openShellProcess).not.toHaveBeenCalled();
    expect(openDock).toHaveBeenCalledTimes(1);
    const dock = openDock.mock.calls[0][0];
    expect(dock.viewType).toBe(ViewType.HOME);
    expect(dock.options?.vibeNoProcess).toBe('true');
    expect(dock.viewMode).toBe('vibe');
    expect(dock.scopeFilter).toEqual(projectScope(PROJECT_ID));
    // vibe home adopts imperatively and clears the stale process/active entity
    expect(selectProjectContextMock).toHaveBeenCalledWith(targetProject);
    expect(setActiveEntitySpy).toHaveBeenCalledWith(null);
  });

  it('home + standard/advanced → scope-carrying home dock, loader is the only context writer', async () => {
    surface.isVibe = false;

    await openViaHook();

    expect(openDock).toHaveBeenCalledTimes(1);
    const dock = openDock.mock.calls[0][0];
    expect(dock.viewType).toBe(ViewType.HOME);
    expect(dock.scopeFilter).toEqual(projectScope(PROJECT_ID));
    expect(dock.options?.vibeNoProcess).toBeUndefined();
    expect(dock.viewMode).toBeNull(); // openDock inherits the live URL's mode
    // URL-first: no click-path context writes
    expect(selectProjectContextMock).not.toHaveBeenCalled();
    expect(dockForProjectEntryMock).not.toHaveBeenCalled();
  });

  it('non-home + vibe with a process → resumes the target project process', async () => {
    surface.isHome = false;
    processIdMock.mockResolvedValue(PROC_ID);

    await openViaHook();

    expect(openShellProcess).toHaveBeenCalledWith(PROC_ID, { viewMode: 'vibe' });
    expect(openDock).not.toHaveBeenCalled();
  });

  it('non-home + vibe with NO process → vibe home landing carrying the project scope', async () => {
    surface.isHome = false;
    processIdMock.mockResolvedValue(null);

    await openViaHook();

    expect(openShellProcess).not.toHaveBeenCalled();
    const dock = openDock.mock.calls[0][0];
    expect(dock.viewType).toBe(ViewType.HOME);
    expect(dock.options?.vibeNoProcess).toBe('true');
    expect(dock.scopeFilter).toEqual(projectScope(PROJECT_ID));
  });

  it('non-home + standard → last-tab resume via dockForProjectEntry (unchanged)', async () => {
    surface.isHome = false;
    surface.isVibe = false;
    const resumedDock = { viewType: ViewType.SHELL } as never;
    dockForProjectEntryMock.mockResolvedValue(resumedDock);

    await openViaHook();

    expect(dockForProjectEntryMock).toHaveBeenCalledWith(PROJECT_ID, null);
    expect(openDock).toHaveBeenCalledWith(resumedDock);
    expect(selectProjectContextMock).not.toHaveBeenCalled();
  });

  it('onPicked (gate/map) → context + continuation only, no navigation', async () => {
    const onPicked = vi.fn(() => Promise.resolve());

    await openViaHook({ onPicked });

    expect(selectProjectContextMock).toHaveBeenCalledWith(targetProject);
    expect(onPicked).toHaveBeenCalledWith(targetProject);
    expect(openDock).not.toHaveBeenCalled();
    expect(openShellProcess).not.toHaveBeenCalled();
  });
});
