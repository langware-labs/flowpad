/**
 * `GitPushButton` shows how many commits are waiting to go up. With none waiting
 * and files pending it turns into "Push all changes" (the pending pill counts those files).
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

  it('keeps the plain push while commits wait, even with files pending', () => {
    withStatus(2, 3);
    render(<GitPushButton />);
    expect(screen.getByTestId('git-push-button')).toBeInTheDocument();
    expect(screen.queryByTestId('git-push-all-button')).toBeNull();
  });

  it('becomes Push all changes when only uncommitted changes are pending', () => {
    withStatus(2, 0);
    render(<GitPushButton />);
    expect(screen.queryByTestId('git-push-button')).toBeNull();
    expect(screen.getByTestId('git-push-all-button')).toHaveTextContent('Push all changes');
  });

  it('is hidden when there is nothing to push', () => {
    withStatus(0, 0);
    render(<GitPushButton />);
    expect(screen.queryByTestId('git-push-button')).toBeNull();
    expect(screen.queryByTestId('git-push-all-button')).toBeNull();
  });
});
