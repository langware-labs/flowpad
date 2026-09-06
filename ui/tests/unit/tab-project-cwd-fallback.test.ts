/**
 * Tab.getFromDockPointer must denormalize a project onto the tab even when the
 * TARGET entity carries no `project_id` — the codex/copilot session, received
 * transcript, and shell case. It falls back to `Project.getProjectByPath(cwd)`,
 * the same longest-prefix resolver the loaders use, so the tab joins its
 * project's strip instead of rendering project-less.
 *
 * Also covers `Project.getProjectByPath` itself (longest-prefix selection).
 */
import { dataManager, Project, Tab } from '@sdk';
import { lazyAssets } from '@sdk/lazy';
import { DockPointer } from '@src/navigation/DockPointer';
import { projectScope } from '@src/lib/scope-filter';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SID = '11111111-1111-4111-8111-111111111111';
const PID = '22222222-2222-4222-8222-222222222222';

afterEach(() => vi.restoreAllMocks());

/** Capture the project_id Tab.getFromDockPointer posts to new_tab. */
function captureNewTabProjectId(): { value: () => string | null } {
  let captured: string | null = null;
  vi.spyOn(dataManager, 'callAction').mockImplementation(async (info: any) => {
    if (info?.name === 'new_tab') captured = info.bodyParameters?.project_id ?? null;
    return { tabs: [] } as any;
  });
  vi.spyOn(dataManager, 'getTabName').mockReturnValue('session');
  return { value: () => captured };
}

describe('Project.getProjectByPath', () => {
  it('returns null for empty / unmatched paths', async () => {
    vi.spyOn(lazyAssets, 'load').mockResolvedValue([] as any);
    expect(await Project.getProjectByPath('')).toBeNull();
    expect(await Project.getProjectByPath('/nope')).toBeNull();
  });

  it('picks the longest-prefix mount path', async () => {
    const OUTER = '33333333-3333-4333-8333-333333333333';
    const INNER = '44444444-4444-4444-8444-444444444444';
    const outer = new Project({ id: OUTER, fs_storage_mount_path: '/work' } as any);
    const inner = new Project({ id: INNER, fs_storage_mount_path: '/work/repo' } as any);
    vi.spyOn(lazyAssets, 'load').mockResolvedValue([outer, inner] as any);
    const match = await Project.getProjectByPath('/work/repo/src/main.ts');
    expect(match?.id).toBe(INNER);
  });
});

describe('Tab.getFromDockPointer cwd → project fallback', () => {
  it('resolves project_id from the target cwd when the entity lacks one', async () => {
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({
      typeId: { type: 'claude_session', id: SID },
      project_id: null,
      cwd: '/work/repo',
    } as any);
    const byPath = vi.spyOn(Project, 'getProjectByPath').mockResolvedValue({ id: PID } as any);
    const cap = captureNewTabProjectId();

    await Tab.getFromDockPointer(DockPointer.forLensTranscript('claude', SID));

    expect(byPath).toHaveBeenCalledWith('/work/repo');
    expect(cap.value()).toBe(PID);
  });

  it('prefers the target project_id and skips the cwd fallback', async () => {
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({
      typeId: { type: 'claude_session', id: SID },
      project_id: PID,
      cwd: '/work/repo',
    } as any);
    const byPath = vi.spyOn(Project, 'getProjectByPath').mockResolvedValue({ id: 'other' } as any);
    const cap = captureNewTabProjectId();

    await Tab.getFromDockPointer(DockPointer.forLensTranscript('claude', SID));

    expect(byPath).not.toHaveBeenCalled();
    expect(cap.value()).toBe(PID);
  });

  it('keeps an unmatched target global instead of adopting ambient URL scope', async () => {
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({
      typeId: { type: 'claude_session', id: SID },
      project_id: null,
      cwd: '/tmp/outside-every-project',
    } as any);
    vi.spyOn(Project, 'getProjectByPath').mockResolvedValue(null);
    const cap = captureNewTabProjectId();

    await Tab.getFromDockPointer(
      DockPointer.forLensTranscript('claude', SID).withScopeFilter(projectScope(PID)),
    );

    expect(cap.value()).toBeNull();
  });
});
