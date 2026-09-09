/**
 * A path-keyed project ensure must never accept a bare NAME.
 *
 * The incident: the Open Project dialog read `project.cwd || project.name`, so
 * a list row whose `cwd` was null passed the string "flowpad-oss" into
 * `ensureProjectAndSetContext`. `Project`'s validator roots a slash-free name
 * at `<workspace>/<name>`, so a checkout that already had a project at
 * ~/Documents/dev/flowpad-oss got a SECOND one at ~/Flowpad workspace/flowpad-oss,
 * and every PTY spawn re-created that folder (`os.makedirs(cwd)`).
 *
 * Entered through `useProjectOpener` — the hook the dialog actually calls —
 * rather than the predicate alone, so the guard is pinned on the real path.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openDock = vi.hoisted(() => vi.fn());

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock } }),
  useIsHomeSurface: () => true,
}));
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsVibe: () => false,
}));
vi.mock('@src/tabs/project-entry', () => ({
  agenticProcessIdForProjectEntry: vi.fn(() => Promise.resolve(null)),
  dockForProjectEntry: vi.fn(),
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: null }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { dataContext, lazyAssets, Project, type TypeId } from '@sdk';
import { useProjectOpener } from '@src/components/open-project-component/use-open-project';

const REAL_PATH = '/Users/alice/Documents/dev/flowpad-oss';
// What the New Project dialogs actually build: `desktop_info.paths.workspace`
// is VFS-relative (no leading slash), so a legitimate create has no leading
// slash either. Pins that the guard tests for a separator, not absoluteness.
const VFS_PATH = 'Users/alice/Flowpad workspace/new-thing';

const projectAt = (mount: string | null, name: string) =>
  ({ id: 'p1', name, fs_storage_mount_path: mount, setupForDesktop: vi.fn(() => Promise.resolve()) }) as unknown as Project;

const ensure = (path: string) => {
  const { result } = renderHook(() => useProjectOpener());
  return result.current.ensureProjectAndSetContext(path);
};

describe('ensureProjectAndSetContext — a name is not a location', () => {
  let saveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(lazyAssets, 'refresh').mockResolvedValue([]);
    vi.spyOn(dataContext, 'getContextEntityTypeId').mockReturnValue({ id: 'user' } as unknown as TypeId);
    vi.spyOn(dataContext, 'setContextEntityTypeId').mockResolvedValue(undefined as never);
    vi.spyOn(dataContext, 'refreshProject').mockResolvedValue(undefined as never);
    vi.spyOn(dataContext, 'setWorkdir').mockImplementation(() => {});
    saveSpy = vi
      .spyOn(Project.prototype, 'save')
      .mockImplementation(function (this: Project) {
        return Promise.resolve(this);
      } as never);
    vi.spyOn(Project.prototype, 'setupForDesktop').mockResolvedValue(undefined as never);
  });

  it('refuses a bare name instead of minting a project under the workspace', async () => {
    await expect(ensure('flowpad-oss')).rejects.toThrow(/valid project path/i);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('accepts a VFS-relative path — the form the New Project dialogs build', async () => {
    await ensure(VFS_PATH);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('dedups on the mount path, so a cwd-less namesake never claims it', async () => {
    vi.spyOn(lazyAssets, 'refresh').mockResolvedValue([
      projectAt(null, 'flowpad-oss'),
      projectAt(REAL_PATH, 'flowpad-oss'),
    ]);
    const { project } = await ensure(REAL_PATH);
    expect(project.fs_storage_mount_path).toBe(REAL_PATH);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
