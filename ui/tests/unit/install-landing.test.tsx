import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  allowedRoles: [] as string[],
}));

const existingRepo = {
  provider: 'github' as const,
  owner: 'customer',
  name: 'website',
  full_name: 'customer/website',
  private: true,
  default_branch: 'main',
  pushed_at: '',
  role: 'write' as const,
  html_url: 'https://github.com/customer/website',
  description: '',
  fork: false,
  git_origin: {
    provider: 'github',
    owner: 'customer',
    name: 'website',
    branch: 'main',
    rel_path: '.',
  },
};

const createdRepo = {
  ...existingRepo,
  owner: 'demo-user',
  name: 'new-support-site',
  full_name: 'demo-user/new-support-site',
  role: 'admin' as const,
  git_origin: {
    ...existingRepo.git_origin,
    owner: 'demo-user',
    name: 'new-support-site',
  },
};

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isHubOnly: () => true,
    navigator: { getLoginWithCallbackUrl: vi.fn(() => '/login') },
  };
});

vi.mock('@src/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@src/hooks/use-sandboxes', () => ({
  useSandboxes: () => ({ launch: mocks.launch, steps: [], launchUrl: null }),
}));

vi.mock('@src/components/git/RepoPicker', async () => {
  const React = await import('react');
  return {
    RepoPicker: (props: { allowedRoles?: string[]; onSelect: (repo: typeof existingRepo) => void }) => {
      mocks.allowedRoles = props.allowedRoles ?? [];
      return React.createElement(
        'button',
        { type: 'button', onClick: () => props.onSelect(existingRepo), 'data-testid': 'choose-existing-repo' },
        'Choose existing repo',
      );
    },
  };
});

vi.mock('@src/components/git/BranchPicker', async () => {
  const React = await import('react');
  return {
    BranchPicker: (props: { onSelect: (branch: { name: string; protected: boolean }) => void }) =>
      React.createElement(
        'button',
        { type: 'button', onClick: () => props.onSelect({ name: 'develop', protected: false }), 'data-testid': 'choose-branch' },
        'Choose develop',
      ),
  };
});

vi.mock('@src/components/git/CreatePrivateRepoForm', async () => {
  const React = await import('react');
  return {
    CreatePrivateRepoForm: (props: { onCreated: (repo: typeof createdRepo) => void }) =>
      React.createElement(
        'button',
        { type: 'button', onClick: () => props.onCreated(createdRepo), 'data-testid': 'finish-create-repo' },
        'Create repo',
      ),
  };
});

import InstallLanding from '@src/pages/entry/InstallLanding';

const INSTALL_QUERY =
  '?content_repo=https%3A%2F%2Fgithub.com%2Fcloudnsite%2Fcustomer-support.git&content_branch=main&name=CloudNSite+agents';

describe('/install landing', () => {
  beforeEach(() => {
    mocks.launch.mockReset();
    mocks.allowedRoles = [];
    window.history.replaceState({}, '', `/install${INSTALL_QUERY}`);
  });

  afterEach(cleanup);

  it('chooses a writable repo and branch, confirms, and launches the unified setup-git install', async () => {
    const user = userEvent.setup();
    render(<InstallLanding />);

    expect(screen.getByText('Where do you want to install CloudNSite agents?')).toBeTruthy();
    expect(mocks.allowedRoles).toEqual(['admin', 'write']);
    expect(screen.getByText(/default branch is not changed/i)).toBeTruthy();
    await user.click(screen.getByTestId('choose-existing-repo'));
    await user.click(screen.getByTestId('choose-branch'));
    expect(screen.getByTestId('install-confirmation').textContent).toContain('customer/website');
    await user.click(screen.getByTestId('install-launch'));

    expect(mocks.launch).toHaveBeenCalledWith({
      name: 'website',
      sandboxProject: {
        name: 'website',
        gitOrigin: { ...existingRepo.git_origin, branch: 'develop' },
        install: {
          name: 'CloudNSite agents',
          content_repo: 'https://github.com/cloudnsite/customer-support.git',
          content_branch: 'main',
          scope: 'shared',
          review_branch: 'flowpad/install-cloudnsite-agents',
        },
      },
    });
  });

  it('uses an initialized private repo without asking for another branch', async () => {
    const user = userEvent.setup();
    render(<InstallLanding />);

    await user.click(screen.getByTestId('install-create-private'));
    await user.click(screen.getByTestId('finish-create-repo'));
    await user.click(screen.getByTestId('install-launch'));

    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'new-support-site',
        sandboxProject: expect.objectContaining({
          gitOrigin: expect.objectContaining({ owner: 'demo-user', name: 'new-support-site', branch: 'main' }),
        }),
      }),
    );
  });

  it('cancels without creating a desktop or touching a repository', async () => {
    const user = userEvent.setup();
    render(<InstallLanding />);

    await user.click(screen.getByTestId('install-cancel'));

    expect(screen.getByText('Nothing was installed. You can close this tab.')).toBeTruthy();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
