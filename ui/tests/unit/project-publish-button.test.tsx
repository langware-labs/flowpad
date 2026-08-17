import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthEventType, OAuthStatus, type OAuthFlowCompletePayload, type Project } from '@sdk';

import { ProjectPublishButton } from '@src/components/project-home/ProjectPublishButton';

const mocks = vi.hoisted(() => ({
  project: {
    id: '004f3ab7-d33b-48c0-ae0e-6e61e181a343',
    typeId: {
      type: 'project',
      id: '004f3ab7-d33b-48c0-ae0e-6e61e181a343',
      toString: () => 'project:004f3ab7-d33b-48c0-ae0e-6e61e181a343',
    },
    name: 'Demo project',
    displayName: 'Demo project',
    remote: false,
    fs_storage_mount_path: '/workspace/demo-project',
    share: vi.fn(),
  },
  preflight: {
    loading: false,
    available: true,
    reason: null as string | null,
    code: null as string | null,
    answered: true,
    origin: 'git@github.com:flowpad/demo-project.git' as string | null,
    refetch: vi.fn(),
  },
  cloudLogin: vi.fn(),
  push: vi.fn(),
  pushBusy: false,
  launchWizard: vi.fn(),
  oauthConnect: vi.fn(),
  oauthStatus: vi.fn(),
  oauthEventHandlers: [] as Array<(message: OAuthFlowCompletePayload) => void>,
  oauthEventOn: vi.fn(),
  oauthEventOff: vi.fn(),
  openExternal: vi.fn(),
  hubPageUrl: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  hubMode: false,
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    cloudManager: { cloudAppUrl: 'https://app.flowpad.test' },
    dataContext: {
      userTypeId: {
        type: 'user',
        id: 'a230187d-e13f-46eb-b606-e39a21830e9c',
      },
    },
    dataManager: {
      callAction: mocks.oauthStatus,
      on: mocks.oauthEventOn,
      off: mocks.oauthEventOff,
    },
    launchWizard: mocks.launchWizard,
    oauthService: { connect: mocks.oauthConnect },
    OAUTH_PROVIDERS: { ...actual.OAUTH_PROVIDERS, GITHUB: 'github' },
  };
});

vi.mock('@src/hooks/use-cloud-login-gate', () => ({
  useCloudLoginGate: () => mocks.cloudLogin,
}));

vi.mock('@src/hooks/use-git-push', () => ({
  useGitPush: () => ({ push: mocks.push, busy: mocks.pushBusy }),
}));

vi.mock('@src/hooks/use-git-share-preflight', () => ({
  useGitSharePreflight: () => mocks.preflight,
}));

vi.mock('@src/lib/hub-page-url', () => ({
  hubPageUrl: mocks.hubPageUrl,
}));

vi.mock('@src/lib/open-external', () => ({
  openExternal: mocks.openExternal,
}));

vi.mock('@src/navigation/hub-runtime', () => ({
  isHubOnly: () => mocks.hubMode,
}));

vi.mock('@src/notifications', () => ({
  notify: { success: mocks.success, error: mocks.error, info: mocks.info },
}));

vi.mock('@src/components/share-to-conversation/GitShareGateDialog', () => ({
  GitShareGateDialog: ({
    open,
    gate,
  }: {
    open: boolean;
    gate: { state: string; runSetup: () => void; runCommit: () => void };
  }) =>
    open ? (
      <div data-testid="git-share-gate" data-state={gate.state}>
        {gate.state === 'setup' && <button onClick={gate.runSetup}>Set up Git</button>}
        {gate.state === 'commit' && <button onClick={gate.runCommit}>Commit and push</button>}
      </div>
    ) : null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.project.remote = false;
  mocks.preflight.loading = false;
  mocks.preflight.available = true;
  mocks.preflight.reason = null;
  mocks.preflight.code = null;
  mocks.preflight.answered = true;
  mocks.preflight.origin = 'git@github.com:flowpad/demo-project.git';
  mocks.pushBusy = false;
  mocks.hubMode = false;
  mocks.oauthEventHandlers.length = 0;
  mocks.oauthEventOn.mockImplementation((_event, handler) => {
    mocks.oauthEventHandlers.push(handler);
  });
  mocks.cloudLogin.mockResolvedValue({ ok: true });
  mocks.push.mockResolvedValue(undefined);
  mocks.launchWizard.mockResolvedValue({ status: 'done' });
  mocks.oauthConnect.mockResolvedValue(undefined);
  mocks.oauthStatus.mockResolvedValue({ has_token: true });
  mocks.hubPageUrl.mockReturnValue('https://app.flowpad.test/projects/004f3ab7-d33b-48c0-ae0e-6e61e181a343');
  mocks.project.share.mockImplementation(() => {
    mocks.project.remote = true;
    return Promise.resolve(mocks.project);
  });
});

afterEach(cleanup);

describe('ProjectPublishButton', () => {
  const project = mocks.project as unknown as Project;

  it('cloud-logs in and publishes through the canonical Project share action', async () => {
    render(<ProjectPublishButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));

    await waitFor(() => expect(mocks.project.share).toHaveBeenCalledTimes(1));
    expect(mocks.oauthStatus).toHaveBeenCalledTimes(1);
    expect(mocks.cloudLogin).toHaveBeenCalledTimes(1);
    expect(mocks.cloudLogin.mock.invocationCallOrder[0]).toBeLessThan(mocks.project.share.mock.invocationCallOrder[0]);
    expect(screen.getByRole('link', { name: 'Linked to cloud' })).toBeInTheDocument();
    expect(mocks.success).toHaveBeenCalled();
  });

  it('does not share when cloud login does not complete', async () => {
    mocks.cloudLogin.mockResolvedValue({ ok: false, error: 'Cloud login required' });
    render(<ProjectPublishButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.project.share).not.toHaveBeenCalled();
    expect(screen.getByTestId('project-publish')).toHaveAttribute('data-state', 'local');
  });

  it('runs exact-folder Git setup for a missing repository or remote', async () => {
    mocks.preflight.available = false;
    mocks.preflight.code = 'missing-remote';
    mocks.preflight.reason = 'A GitHub origin is required.';
    render(<ProjectPublishButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));
    expect(screen.getByTestId('git-share-gate')).toHaveAttribute('data-state', 'setup');
    await userEvent.click(screen.getByRole('button', { name: 'Set up Git' }));

    await waitFor(() => expect(mocks.launchWizard).toHaveBeenCalledTimes(1));
    expect(mocks.launchWizard).toHaveBeenCalledWith(
      'git-context-folder',
      expect.objectContaining({
        targetTypeId: mocks.project.typeId.toString(),
        payload: expect.objectContaining({
          projectId: mocks.project.id,
          path: mocks.project.fs_storage_mount_path,
        }),
      }),
    );
    expect(mocks.preflight.refetch).toHaveBeenCalled();
  });

  it('hands the screen to the setup wizard instead of sitting on top of it', async () => {
    // The wizard finishes its work and then waits for the user to press Done, so
    // `launchWizard` stays pending meanwhile — modelled here by a promise that
    // does not resolve. The gate must be OUT OF THE WAY for that whole time: it
    // used to stay up in its `checking` face (the one face with no action), so
    // the user watched an unchanging spinner while the wizard that needed them
    // was behind it — and because only that user can close the wizard, nothing
    // could ever resolve it.
    let finishWizard: (result: { status: string }) => void = () => {};
    mocks.launchWizard.mockReturnValue(
      new Promise<{ status: string }>((resolve) => {
        finishWizard = resolve;
      }),
    );
    mocks.preflight.available = false;
    mocks.preflight.code = 'missing-remote';
    render(<ProjectPublishButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));
    await userEvent.click(screen.getByRole('button', { name: 'Set up Git' }));

    await waitFor(() => expect(mocks.launchWizard).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('git-share-gate')).not.toBeInTheDocument();

    // And the handoff is not a dead end: finishing the wizard still re-checks.
    finishWizard({ status: 'done' });
    await waitFor(() => expect(mocks.preflight.refetch).toHaveBeenCalled());
  });

  it('says how the setup wizard ended, whichever way it ends', async () => {
    // The wizard runs on its own surface, so this button is off-screen when it
    // lands. Every exit has to speak for itself or the user is back to guessing.
    mocks.preflight.available = false;
    mocks.preflight.code = 'missing-remote';

    // Cancelled: the publish they asked for is simply not happening.
    mocks.launchWizard.mockResolvedValue({ status: 'cancel' });
    const first = render(<ProjectPublishButton project={project} />);
    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));
    await userEvent.click(screen.getByRole('button', { name: 'Set up Git' }));
    await waitFor(() =>
      expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ title: 'Git setup cancelled' })),
    );
    first.unmount();

    // Finished: say so, and say what happens next.
    mocks.launchWizard.mockResolvedValue({ status: 'done' });
    render(<ProjectPublishButton project={project} />);
    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));
    await userEvent.click(screen.getByRole('button', { name: 'Set up Git' }));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(expect.objectContaining({ title: 'Git is set up' })),
    );
  });

  it('does not leave the "linking…" promise hanging when the re-check still says no', async () => {
    // Setup reports success, the re-check disagrees. Before, the flag just sat
    // there and nothing further happened — the same silence as the stuck gate,
    // only now we had already told the user we were linking.
    mocks.preflight.available = false;
    mocks.preflight.code = 'missing-remote';
    mocks.preflight.reason = 'A GitHub origin is required.';
    mocks.launchWizard.mockResolvedValue({ status: 'done' });
    render(<ProjectPublishButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));
    await userEvent.click(screen.getByRole('button', { name: 'Set up Git' }));

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Still can't link this project",
          message: 'A GitHub origin is required.',
        }),
      ),
    );
    // And it did NOT quietly publish anyway.
    expect(mocks.project.share).not.toHaveBeenCalled();
  });

  it('uses the shared whole-repository push path for dirty or unpushed Git state', async () => {
    mocks.preflight.available = false;
    mocks.preflight.code = 'dirty';
    mocks.preflight.reason = 'Commit and push the repository.';
    render(<ProjectPublishButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));
    expect(screen.getByTestId('git-share-gate')).toHaveAttribute('data-state', 'commit');
    await userEvent.click(screen.getByRole('button', { name: 'Commit and push' }));

    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it('starts GitHub OAuth and rechecks its status before sharing after authorization', async () => {
    mocks.oauthStatus.mockResolvedValueOnce({ has_token: false });
    render(<ProjectPublishButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));

    expect(mocks.oauthConnect).toHaveBeenCalledWith('github');
    expect(mocks.oauthEventOn).toHaveBeenCalledWith(OAuthEventType.OAUTH_FLOW_COMPLETE, expect.any(Function));
    act(() => {
      mocks.oauthEventHandlers.at(-1)?.({ provider: 'github', status: OAuthStatus.SUCCESS, attachSuccess: null });
    });
    await waitFor(() => expect(mocks.project.share).toHaveBeenCalledTimes(1));
    expect(mocks.oauthStatus).toHaveBeenCalledTimes(2);
  });

  it('renders a Published cloud link and opens it externally', async () => {
    mocks.project.remote = true;
    render(<ProjectPublishButton project={project} />);

    const link = screen.getByRole('link', { name: 'Linked to cloud' });
    expect(mocks.hubPageUrl).toHaveBeenCalledWith('https://app.flowpad.test', mocks.project.typeId);
    expect(link).toHaveAttribute('href', 'https://app.flowpad.test/projects/004f3ab7-d33b-48c0-ae0e-6e61e181a343');
    await userEvent.click(link);
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://app.flowpad.test/projects/004f3ab7-d33b-48c0-ae0e-6e61e181a343',
    );
  });

  it('is hidden on the Hub Project page', () => {
    mocks.hubMode = true;
    render(<ProjectPublishButton project={project} />);

    expect(screen.queryByTestId('project-publish')).not.toBeInTheDocument();
  });
});
