/**
 * A failed repo list must offer a way out of itself.
 *
 * The list fails almost exclusively because the provider grant is missing or
 * revoked. Before this, RepoPicker stated the failure and stopped: the only
 * other affordance on the /install page ("Create a private repository") needs
 * the same broken grant, so the install funnel terminated there.
 *
 * The picker deliberately does NOT own the connect flow — the host knows which
 * provider it wants and what to do afterwards — so this is a button spec
 * rendered in the error branch, nothing more.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepoPicker } from '@src/components/git/RepoPicker';

const mockUseGitRepos = vi.fn();
vi.mock('@src/hooks/use-git-providers', () => ({
  useGitRepos: (...args: unknown[]) => mockUseGitRepos(...args),
}));

function errored() {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    error: new Error('Bad credentials'),
    refetch: vi.fn(),
    isFetching: false,
  };
}

function loaded(repos: unknown[]) {
  return {
    data: repos,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    isFetching: false,
  };
}

afterEach(() => {
  cleanup();
});

describe('RepoPicker connectionAction', () => {
  it('offers the connect button when the fetch failed', async () => {
    mockUseGitRepos.mockReturnValue(errored());
    const onClick = vi.fn();

    render(
      <RepoPicker
        provider="github"
        onSelect={vi.fn()}
        connectionAction={{ label: 'Connect GitHub', pending: false, onClick }}
      />,
    );

    const button = screen.getByTestId('repo-picker-connect');
    expect(button).toHaveTextContent('Connect GitHub');

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the failure reason alongside it, not instead of it', () => {
    mockUseGitRepos.mockReturnValue(errored());
    render(
      <RepoPicker
        provider="github"
        onSelect={vi.fn()}
        connectionAction={{ label: 'Connect GitHub', pending: false, onClick: vi.fn() }}
      />,
    );
    expect(screen.getByText(/Bad credentials/)).toBeInTheDocument();
    expect(screen.getByTestId('repo-picker-connect')).toBeInTheDocument();
  });

  it('disables itself while a connect is in flight', () => {
    mockUseGitRepos.mockReturnValue(errored());
    render(
      <RepoPicker
        provider="github"
        onSelect={vi.fn()}
        connectionAction={{ label: 'Connect GitHub', pending: true, onClick: vi.fn() }}
      />,
    );
    expect(screen.getByTestId('repo-picker-connect')).toBeDisabled();
  });

  it('stays the dead end it was when the host offers no action', () => {
    mockUseGitRepos.mockReturnValue(errored());
    render(<RepoPicker provider="github" onSelect={vi.fn()} />);
    expect(screen.queryByTestId('repo-picker-connect')).toBeNull();
  });

  it('is an ERROR-branch affordance only — a successful list never shows it', () => {
    mockUseGitRepos.mockReturnValue(
      loaded([
        {
          full_name: 'acme/site',
          owner: 'acme',
          name: 'site',
          role: 'admin',
          private: false,
          fork: false,
          pushed_at: '2026-09-01T00:00:00Z',
        },
      ]),
    );
    render(
      <RepoPicker
        provider="github"
        onSelect={vi.fn()}
        connectionAction={{ label: 'Connect GitHub', pending: false, onClick: vi.fn() }}
      />,
    );
    expect(screen.queryByTestId('repo-picker-connect')).toBeNull();
    expect(screen.getByTestId('repo-picker-row-acme/site')).toBeInTheDocument();
  });
});
