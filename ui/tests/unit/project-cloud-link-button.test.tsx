/**
 * `ProjectCloudLinkButton` — linking a desktop project to the cloud.
 *
 * Linking needs a cloud login and nothing else: the project's published assets
 * travel through its hub-hosted repository, so there is no git preflight, no
 * setup-git wizard, no commit-and-push and no GitHub OAuth on this path.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@sdk';

import { ProjectCloudLinkButton } from '@src/components/project-home/ProjectCloudLinkButton';

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
    // A folder with no git at all — linking must not care.
    fs_storage_mount_path: '/workspace/demo-project',
    share: vi.fn(),
  },
  cloudLogin: vi.fn(),
  launchWizard: vi.fn(),
  oauthConnect: vi.fn(),
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
    launchWizard: mocks.launchWizard,
    oauthService: { connect: mocks.oauthConnect },
  };
});

vi.mock('@src/hooks/use-cloud-login-gate', () => ({
  useCloudLoginGate: () => mocks.cloudLogin,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.project.remote = false;
  mocks.hubMode = false;
  mocks.cloudLogin.mockResolvedValue({ ok: true });
  mocks.hubPageUrl.mockReturnValue('https://app.flowpad.test/projects/004f3ab7-d33b-48c0-ae0e-6e61e181a343');
  mocks.project.share.mockImplementation(() => {
    mocks.project.remote = true;
    return Promise.resolve(mocks.project);
  });
});

afterEach(cleanup);

describe('ProjectCloudLinkButton', () => {
  const project = mocks.project as unknown as Project;

  it('cloud-logs in and links through the canonical Project share action — no git, no GitHub', async () => {
    render(<ProjectCloudLinkButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));

    await waitFor(() => expect(mocks.project.share).toHaveBeenCalledTimes(1));
    expect(mocks.cloudLogin).toHaveBeenCalledTimes(1);
    expect(mocks.cloudLogin.mock.invocationCallOrder[0]).toBeLessThan(mocks.project.share.mock.invocationCallOrder[0]);
    // None of the retired git remediations run.
    expect(mocks.launchWizard).not.toHaveBeenCalled();
    expect(mocks.oauthConnect).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Linked to cloud' })).toBeInTheDocument();
    expect(mocks.success).toHaveBeenCalled();
  });

  it('is actionable at once — there is no git check to wait for', () => {
    render(<ProjectCloudLinkButton project={project} />);

    expect(screen.getByRole('button', { name: 'Link to cloud' })).toBeEnabled();
  });

  it('does not share when cloud login does not complete', async () => {
    mocks.cloudLogin.mockResolvedValue({ ok: false, error: 'Cloud login required' });
    render(<ProjectCloudLinkButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.project.share).not.toHaveBeenCalled();
    expect(screen.getByTestId('project-publish')).toHaveAttribute('data-state', 'local');
  });

  it('reports a backend refusal in its own words and stays local', async () => {
    mocks.project.share.mockRejectedValue(new Error('Cloud login required before linking a Project to the cloud'));
    render(<ProjectCloudLinkButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Cloud login required before linking a Project to the cloud' }),
      ),
    );
    expect(screen.getByTestId('project-publish')).toHaveAttribute('data-state', 'local');
  });

  it('refuses a share the server did not confirm', async () => {
    mocks.project.share.mockResolvedValue({ ...mocks.project, remote: false });
    render(<ProjectCloudLinkButton project={project} />);

    await userEvent.click(screen.getByRole('button', { name: 'Link to cloud' }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('renders a Published cloud link and opens it externally', async () => {
    mocks.project.remote = true;
    render(<ProjectCloudLinkButton project={project} />);

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
    render(<ProjectCloudLinkButton project={project} />);

    expect(screen.queryByTestId('project-publish')).not.toBeInTheDocument();
  });
});
