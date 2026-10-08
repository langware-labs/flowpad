/**
 * `GitPushButton` shows how many commits are waiting to go up. Uncommitted-only
 * changes show the button with no number (the pending pill counts those files).
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@src/components/status-bar/GitStatusContext', () => ({
  useGitStatus: () => status.current,
}));
vi.mock('@src/hooks/use-git-push', () => ({
  useGitPush: () => ({ push: vi.fn(), busy: false }),
}));

import { GitPushButton } from '@src/components/status-bar/GitPushButton';

const withStatus = (count: number, ahead: number) => {
  status.current = {
    computeNodeId: 'node-1',
    workdir: '/w',
    count,
    ahead,
    behind: 0,
    hasRepo: true,
    branch: 'main',
    refresh: vi.fn(),
  };
};

afterEach(cleanup);

describe('GitPushButton commit count', () => {
  it('shows the ahead count', () => {
    withStatus(0, 3);
    render(<GitPushButton />);
    expect(screen.getByTestId('git-push-ahead-count')).toHaveTextContent('3');
    expect(screen.getByTestId('git-push-button')).toHaveAttribute('title', 'git push — 3 commits to push');
  });

  it('shows no number when only uncommitted changes are pending', () => {
    withStatus(2, 0);
    render(<GitPushButton />);
    expect(screen.getByTestId('git-push-button')).toBeInTheDocument();
    expect(screen.queryByTestId('git-push-ahead-count')).toBeNull();
  });
});
