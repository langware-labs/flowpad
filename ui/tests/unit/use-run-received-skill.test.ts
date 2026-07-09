/**
 * useRunReceivedSkill — the install-then-run sequence for a received skill.
 *
 * Contract (plan F2): resolve the run project (installed scope → conversation
 * project → active project), install-if-needed into it, then open a Vibe
 * session there and prompt the skill BY NAME. Asserts the exact ordering +
 * arguments so a regression (running from the staged path, or by path not name,
 * or skipping install) is caught.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({
  launchVibeSessionForProject: vi.fn().mockResolvedValue('proc-1'),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openShellProcess: vi.fn() } }),
}));
// Project ids must be valid UUIDs — the real TypeId constructor rejects others.
const CONV_PROJ = '11111111-1111-4111-8111-111111111111';
const ACTIVE_PROJ = '22222222-2222-4222-8222-222222222222';
const INSTALLED_PROJ = '33333333-3333-4333-8333-333333333333';

vi.mock('@sdk/react/hooks', () => ({
  useProject: () => ({ project: { id: '22222222-2222-4222-8222-222222222222' } }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
// NOTE: do NOT mock '@lingui/react/macro' (breaks the lingui Vite plugin's
// resolveId for the whole run) or '@sdk' wholesale (starves locale-context /
// i18n-init of real exports). Use the real @sdk and spy on the one method the
// hook calls.

import { dataManager } from '@sdk';
import { launchVibeSessionForProject } from '@src/pages/flow-page/use-start-vibe-session';
import { useRunReceivedSkill } from '@src/components/conversation/asset-review/useRunReceivedSkill';

const mockedLaunch = vi.mocked(launchVibeSessionForProject);

/** A staged/installed MessageAttachment stand-in — only the fields the hook reads. */
function fakeAttachment(over: Partial<{ project_id: string | null; installed: boolean; name: string | null }> = {}) {
  return {
    project_id: over.project_id ?? null,
    installed: over.installed ?? false,
    name: over.name ?? 'find-me-a-product',
    install: vi.fn().mockResolvedValue(undefined),
  };
}

function run(args: Parameters<ReturnType<typeof useRunReceivedSkill>>[0]) {
  const { result } = renderHook(() => useRunReceivedSkill());
  result.current(args);
}

describe('useRunReceivedSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLaunch.mockResolvedValue('proc-1');
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({ fs_storage_mount_path: '/proj/mount' } as never);
  });

  it('not installed + conversation project → installs into it, then runs BY NAME', async () => {
    const attachment = fakeAttachment();
    run({ attachment: attachment as never, conversationProjectId: CONV_PROJ });

    await vi.waitFor(() => expect(mockedLaunch).toHaveBeenCalledTimes(1));
    expect(attachment.install).toHaveBeenCalledWith('project', CONV_PROJ);
    expect(mockedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: CONV_PROJ,
        workdir: '/proj/mount',
        message: 'run the skill find-me-a-product',
      }),
    );
  });

  it('already installed → does NOT re-install; runs in the installed project', async () => {
    const attachment = fakeAttachment({ installed: true, project_id: INSTALLED_PROJ });
    run({ attachment: attachment as never, conversationProjectId: CONV_PROJ });

    await vi.waitFor(() => expect(mockedLaunch).toHaveBeenCalledTimes(1));
    expect(attachment.install).not.toHaveBeenCalled();
    expect(mockedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: INSTALLED_PROJ, message: 'run the skill find-me-a-product' }),
    );
  });

  it('with a user prompt → "use the skill … in order to:" form', async () => {
    const attachment = fakeAttachment();
    run({ attachment: attachment as never, conversationProjectId: CONV_PROJ, userPrompt: 'find running shoes' });

    await vi.waitFor(() => expect(mockedLaunch).toHaveBeenCalledTimes(1));
    expect(mockedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'use the skill find-me-a-product in order to:\nfind running shoes' }),
    );
  });

  it('no conversation project → falls back to the active project', async () => {
    const attachment = fakeAttachment();
    run({ attachment: attachment as never });

    await vi.waitFor(() => expect(mockedLaunch).toHaveBeenCalledTimes(1));
    expect(attachment.install).toHaveBeenCalledWith('project', ACTIVE_PROJ);
    expect(mockedLaunch).toHaveBeenCalledWith(expect.objectContaining({ projectId: ACTIVE_PROJ }));
  });
});
