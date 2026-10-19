import '@testing-library/jest-dom/vitest';

import { BrowserRouter } from 'react-router';
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gitMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  fileDiff: vi.fn().mockResolvedValue({ diff: 'commit-only diff' }),
  revision: 'abcdef1234567890',
  commitFiles: [{ status: 'A', path: 'committed.txt', staged: false, insertions: 3, deletions: 0 }],
  status: {
    error: null as string | null,
    branch: 'main',
    upstream: 'origin/main' as string | null,
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
      fileDiff = gitMocks.fileDiff;
      unpushedCommits() {
        return Promise.resolve([
          { hash: gitMocks.revision, message: 'Add committed file', author: 'Author', date: '2026-10-11' },
        ]);
      }
      getStatus(options?: { lineCounts?: boolean; revision?: string }) {
        gitMocks.getStatus(options);
        return Promise.resolve(
          options?.revision ? { ...gitMocks.status, files: gitMocks.commitFiles } : gitMocks.status,
        );
      }
    },
  };
});

vi.mock('@src/components/code-editor/DiffContent', () => ({
  DiffContent: ({ diffString }: { diffString: string }) => <pre>{diffString}</pre>,
}));

vi.mock('@src/lib/open-external', () => ({ openExternal: vi.fn() }));

vi.mock('@src/hooks/use-git-push', () => ({
  useGitPush: () => ({ push: vi.fn(), busy: false }),
}));

import { fireEvent } from '@testing-library/react';
import { openExternal } from '@src/lib/open-external';
import { GitPanel } from '@src/components/terminal/interactive-terminal/side-windows/GitPanel';

const render = (ui: React.ReactNode) => rtlRender(<BrowserRouter>{ui}</BrowserRouter>);

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

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

describe('GitPanel header sync chip', () => {
  const base = { ...gitMocks.status, files: [], remoteUrl: null, remoteWebUrl: null };

  it.each([
    ['no remote branch', { upstream: null, ahead: 0, behind: 0 }, 'git-panel-no-upstream'],
    ['up to date', { upstream: 'origin/main', ahead: 0, behind: 0 }, 'git-panel-in-sync'],
    ['ahead', { upstream: 'origin/main', ahead: 2, behind: 0 }, 'git-panel-ahead'],
  ])('%s shows exactly its chip', async (_name, sync, testId) => {
    gitMocks.status = { ...base, ...sync };
    render(<GitPanel computeNodeId="@local" workdir="/repo" />);
    await screen.findByTestId(testId);
    for (const other of ['git-panel-no-upstream', 'git-panel-in-sync', 'git-panel-ahead']) {
      if (other !== testId) expect(screen.queryByTestId(other)).not.toBeInTheDocument();
    }
  });
});

describe('GitPanel commit review', () => {
  it('opens a commit with shared read-only rows and diff, then returns to pending changes', async () => {
    gitMocks.status = {
      ...gitMocks.status,
      ahead: 1,
      upstream: 'origin/main',
      files: [{ status: 'M', path: 'pending.txt', staged: false, insertions: 1, deletions: 0 }],
    };
    render(<GitPanel computeNodeId="@local" workdir="/repo" />);
    fireEvent.click(await screen.findByTestId('git-panel-ahead'));
    fireEvent.click(await screen.findByRole('button', { name: /Add committed file/ }));
    expect(await screen.findByText('committed.txt')).toBeInTheDocument();
    expect(gitMocks.getStatus).toHaveBeenLastCalledWith({ lineCounts: true, revision: gitMocks.revision });
    expect(screen.queryByText('pending.txt')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-panel-push')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-panel-mode')).not.toBeInTheDocument();
    expect(screen.getByTestId('git-panel-sloc-added')).toHaveTextContent('+3');
    fireEvent.click(screen.getByText('committed.txt'));
    expect(await screen.findByText('commit-only diff')).toBeInTheDocument();
    expect(gitMocks.fileDiff).toHaveBeenLastCalledWith('committed.txt', 'A', gitMocks.revision);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('commit-only diff')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Working tree' }));
    expect(await screen.findByText('pending.txt')).toBeInTheDocument();
    expect(screen.getByTestId('git-panel-push')).toBeInTheDocument();
  });
});
