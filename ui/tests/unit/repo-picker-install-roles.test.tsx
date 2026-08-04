import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: {
    data: [] as typeof repos,
    isLoading: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
    isFetching: false,
  },
}));

const repos = ['admin', 'write', 'read'].map((role) => ({
  provider: 'github' as const,
  owner: 'customer',
  name: `${role}-repo`,
  full_name: `customer/${role}-repo`,
  private: true,
  default_branch: 'main',
  pushed_at: '',
  role,
  html_url: `https://github.com/customer/${role}-repo`,
  description: '',
  fork: false,
  git_origin: {
    provider: 'github',
    owner: 'customer',
    name: `${role}-repo`,
    branch: 'main',
    rel_path: '.',
  },
}));

vi.mock('@src/hooks/use-git-providers', () => ({
  useGitRepos: () => mocks.query,
}));

import { RepoPicker } from '@src/components/git/RepoPicker';

describe('RepoPicker install permissions', () => {
  beforeEach(() => {
    mocks.query.data = repos;
    mocks.query.isLoading = false;
    mocks.query.isError = false;
    mocks.query.error = null;
    mocks.query.isFetching = false;
    mocks.query.refetch.mockReset();
  });

  afterEach(cleanup);

  it('exposes stable rows only for roles allowed to update the selected branch', () => {
    render(<RepoPicker provider="github" allowedRoles={['admin', 'write']} onSelect={() => {}} />);

    expect(screen.getByTestId('repo-picker-row-customer/admin-repo')).toBeTruthy();
    expect(screen.getByTestId('repo-picker-row-customer/write-repo')).toBeTruthy();
    expect(screen.queryByTestId('repo-picker-row-customer/read-repo')).toBeNull();
  });

  it('preserves the Hub failure detail and offers the supplied connection action', async () => {
    const onConnect = vi.fn();
    mocks.query.data = [];
    mocks.query.isError = true;
    mocks.query.error = {
      response: { data: { detail: 'GitHub not connected' } },
    };
    const user = userEvent.setup();

    render(
      <RepoPicker
        provider="github"
        onSelect={() => {}}
        connectionAction={{ label: 'Connect GitHub', pending: false, onClick: onConnect }}
      />,
    );

    expect(screen.getByText('Failed to load repos: GitHub not connected')).toBeTruthy();
    await user.click(screen.getByTestId('repo-picker-connect'));
    expect(onConnect).toHaveBeenCalledOnce();
  });
});
