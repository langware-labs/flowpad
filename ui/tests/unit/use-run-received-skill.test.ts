/**
 * useRunReceivedSkill — the low-level install-then-run sequence for a received
 * skill in a KNOWN project. Project RESOLUTION (conversation → active → prompt)
 * lives in useRunSkillWithProjectPrompt and is covered via resolveRunProjectId
 * in skill-test-prompt.test.ts.
 *
 * Asserts the exact ordering + arguments so a regression (running from the
 * staged path, by path not name, or skipping install) is caught.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({
  launchVibeSessionForProject: vi.fn().mockResolvedValue('proc-1'),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openShellProcess: vi.fn() } }),
}));
// Picker deps pulled in by the .tsx module — stub so the low-level hook renders.
vi.mock('@sdk/react/hooks', () => ({ useProject: () => ({ project: null }) }));
vi.mock('@src/components/project-selector', () => ({
  ProjectSelectorModal: () => null,
  projectListToSelectorItems: () => [],
}));
vi.mock('@src/components/project-selector/use-ensure-project', () => ({ useEnsureProject: () => vi.fn() }));
vi.mock('@src/hooks/use-all-projects', () => ({ useAllProjects: () => ({ projects: [], isLoading: false }) }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
// Do NOT mock '@lingui/react/macro' or '@sdk' wholesale (breaks the lingui Vite
// plugin / starves locale-context). Use the real @sdk + spy the one method.

const RUN_PROJ = '11111111-1111-4111-8111-111111111111';

import { dataManager } from '@sdk';
import { launchVibeSessionForProject } from '@src/pages/flow-page/use-start-vibe-session';
import { useRunReceivedSkill } from '@src/components/conversation/asset-review/useRunReceivedSkill';

const mockedLaunch = vi.mocked(launchVibeSessionForProject);

function fakeAttachment(over: Partial<{ installed: boolean; name: string | null }> = {}) {
  return {
    installed: over.installed ?? false,
    name: over.name ?? 'find-me-a-product',
    install: vi.fn().mockResolvedValue(undefined),
  };
}

function run(args: Parameters<ReturnType<typeof useRunReceivedSkill>>[0]) {
  const { result } = renderHook(() => useRunReceivedSkill());
  result.current(args);
}

describe('useRunReceivedSkill (low level — known project)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLaunch.mockResolvedValue('proc-1');
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({ fs_storage_mount_path: '/proj/mount' } as never);
  });

  it('not installed → installs into the given project, then runs BY NAME', async () => {
    const attachment = fakeAttachment();
    run({ attachment: attachment as never, projectId: RUN_PROJ });

    await vi.waitFor(() => expect(mockedLaunch).toHaveBeenCalledTimes(1));
    expect(attachment.install).toHaveBeenCalledWith('project', RUN_PROJ);
    expect(mockedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: RUN_PROJ, workdir: '/proj/mount', message: 'run the skill find-me-a-product' }),
    );
  });

  it('already installed → does NOT re-install; still runs by name', async () => {
    const attachment = fakeAttachment({ installed: true });
    run({ attachment: attachment as never, projectId: RUN_PROJ });

    await vi.waitFor(() => expect(mockedLaunch).toHaveBeenCalledTimes(1));
    expect(attachment.install).not.toHaveBeenCalled();
    expect(mockedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: RUN_PROJ, message: 'run the skill find-me-a-product' }),
    );
  });

  it('with a user prompt → "use the skill … in order to:" form', async () => {
    const attachment = fakeAttachment();
    run({ attachment: attachment as never, projectId: RUN_PROJ, userPrompt: 'find running shoes' });

    await vi.waitFor(() => expect(mockedLaunch).toHaveBeenCalledTimes(1));
    expect(mockedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'use the skill find-me-a-product in order to:\nfind running shoes' }),
    );
  });
});
