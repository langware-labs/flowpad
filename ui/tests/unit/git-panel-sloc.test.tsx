import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gitMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  status: {
    error: null as string | null,
    branch: 'main',
    ahead: 0,
    behind: 0,
    remoteUrl: 'git@github.com:org/repo.git' as string | null,
    remoteWebUrl: 'https://github.com/org/repo' as string | null,
    files: [
      { status: '?', path: 'brand_new.txt', staged: false, insertions: 5, deletions: 0 },
      { status: 'M', path: 'tracked.txt', staged: false, insertions: 2, deletions: 7 },
      // A binary file carries no counts — it must contribute nothing, not NaN.
      { status: 'M', path: 'logo.png', staged: false, insertions: null, deletions: null },
    ],
  },
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    GitWorkdir: class {
      async getStatus(options?: { lineCounts?: boolean }) {
        gitMocks.getStatus(options);
        return gitMocks.status;
      }
    },
  };
});

vi.mock('@src/lib/open-external', () => ({ openExternal: vi.fn() }));

vi.mock('@src/hooks/use-git-push', () => ({
  useGitPush: () => ({ push: vi.fn(), busy: false }),
}));

import { fireEvent } from '@testing-library/react';
import { openExternal } from '@src/lib/open-external';
import { GitPanel } from '@src/components/terminal/interactive-terminal/side-windows/GitPanel';

afterEach(cleanup);

describe('GitPanel line totals', () => {
  it('sums insertions and deletions across files and shows the net', async () => {
    render(<GitPanel computeNodeId="@local" workdir="/repo" />);

    await waitFor(() => expect(screen.getByTestId('git-panel-sloc')).toBeInTheDocument());
    expect(screen.getByTestId('git-panel-sloc-added')).toHaveTextContent('+7');
    expect(screen.getByTestId('git-panel-sloc-removed')).toHaveTextContent('-7');
    expect(screen.getByTestId('git-panel-sloc-net')).toHaveTextContent('0');
    // Counts are opt-in on the backend; the panel is the surface that asks.
    expect(gitMocks.getStatus).toHaveBeenCalledWith({ lineCounts: true });
  });

  it('is absent when the tree is clean — nothing to total', async () => {
    gitMocks.status = { ...gitMocks.status, files: [] };
    render(<GitPanel computeNodeId="@local" workdir="/repo" />);

    await waitFor(() => expect(screen.getByText('No changes')).toBeInTheDocument());
    expect(screen.queryByTestId('git-panel-sloc')).not.toBeInTheDocument();
  });
});

describe('GitPanel header remote', () => {
  it('copies the branch, and shows the remote with copy and open-in-browser', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom's navigator.clipboard is a getter, so it must be redefined, not assigned.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<GitPanel computeNodeId="@local" workdir="/repo" />);

    const open = await screen.findByTestId('git-panel-open-remote');
    expect(open).toHaveTextContent('git@github.com:org/repo.git');
    fireEvent.click(open);
    expect(openExternal).toHaveBeenCalledWith('https://github.com/org/repo');

    fireEvent.click(screen.getByTestId('git-panel-copy-branch'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('main'));
    fireEvent.click(screen.getByTestId('git-panel-copy-remote'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('git@github.com:org/repo.git'));
  });

  it('shows a non-web remote as plain text, and no row without a remote', async () => {
    gitMocks.status = { ...gitMocks.status, remoteUrl: '/srv/git/repo.git', remoteWebUrl: null };
    const { unmount } = render(<GitPanel computeNodeId="@local" workdir="/repo" />);
    expect(await screen.findByTestId('git-panel-remote')).toHaveTextContent('/srv/git/repo.git');
    expect(screen.queryByTestId('git-panel-open-remote')).not.toBeInTheDocument();
    unmount();

    gitMocks.status = { ...gitMocks.status, remoteUrl: null, remoteWebUrl: null };
    render(<GitPanel computeNodeId="@local" workdir="/repo" />);
    await screen.findByTestId('git-panel-copy-branch');
    expect(screen.queryByTestId('git-panel-copy-remote')).not.toBeInTheDocument();
  });
});
