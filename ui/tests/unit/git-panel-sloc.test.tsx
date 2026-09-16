import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gitMocks = vi.hoisted(() => ({
  status: {
    error: null as string | null,
    branch: 'main',
    ahead: 0,
    behind: 0,
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
      async getStatus() {
        return gitMocks.status;
      }
    },
  };
});

vi.mock('@src/hooks/use-git-push', () => ({
  useGitPush: () => ({ push: vi.fn(), busy: false }),
}));

import { GitPanel } from '@src/components/terminal/interactive-terminal/side-windows/GitPanel';

afterEach(cleanup);

describe('GitPanel line totals', () => {
  it('sums insertions and deletions across files and shows the net', async () => {
    render(<GitPanel computeNodeId="@local" workdir="/repo" />);

    await waitFor(() => expect(screen.getByTestId('git-panel-sloc')).toBeInTheDocument());
    expect(screen.getByTestId('git-panel-sloc-added')).toHaveTextContent('+7');
    expect(screen.getByTestId('git-panel-sloc-removed')).toHaveTextContent('-7');
    expect(screen.getByTestId('git-panel-sloc-net')).toHaveTextContent('0');
  });

  it('is absent when the tree is clean — nothing to total', async () => {
    gitMocks.status = { ...gitMocks.status, files: [] };
    render(<GitPanel computeNodeId="@local" workdir="/repo" />);

    await waitFor(() => expect(screen.getByText('No changes')).toBeInTheDocument());
    expect(screen.queryByTestId('git-panel-sloc')).not.toBeInTheDocument();
  });
});
