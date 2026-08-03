import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  useGitRepos: () => ({
    data: repos,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    isFetching: false,
  }),
}));

import { RepoPicker } from '@src/components/git/RepoPicker';

describe('RepoPicker install permissions', () => {
  afterEach(cleanup);

  it('exposes stable rows only for roles allowed to update the selected branch', () => {
    render(
      <RepoPicker
        provider="github"
        allowedRoles={['admin', 'write']}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByTestId('repo-picker-row-customer/admin-repo')).toBeTruthy();
    expect(screen.getByTestId('repo-picker-row-customer/write-repo')).toBeTruthy();
    expect(screen.queryByTestId('repo-picker-row-customer/read-repo')).toBeNull();
  });
});
