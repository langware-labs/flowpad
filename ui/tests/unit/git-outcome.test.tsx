/**
 * The one git-conflict flow, UI side: every push/pull result goes through
 * `notifyGitOutcome`, a conflict always carries the same Resolve (aimed at the
 * repo that conflicted), and a tree still stuck after the toast is gone shows
 * the footer Resolve pill in place of Push/Pull.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifyMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
const viewMode = vi.hoisted(() => ({ current: 'standard' }));
const runActionMock = vi.hoisted(() => vi.fn());
const status = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@src/notifications/notify', () => ({ notify: notifyMock }));
vi.mock('@src/components/view-mode', async (orig) => ({
  ...(await orig<typeof import('@src/components/view-mode')>()),
  getViewMode: () => viewMode.current,
}));
vi.mock('@src/notifications/commands', () => ({ runAction: runActionMock }));
vi.mock('@src/components/status-bar/GitStatusContext', () => ({ useGitStatus: () => status.current }));
vi.mock('@src/hooks/use-git-push', () => ({ useGitPush: () => ({ push: vi.fn(), busy: false }) }));
vi.mock('@src/hooks/use-git-pull', () => ({ useGitPull: () => ({ pull: vi.fn(), busy: false }) }));

import { closeGitConflict, notifyGitOutcome } from '@src/lib/git-outcome';
import { GitResolveButton } from '@src/components/status-bar/GitResolveButton';
import { GitPushButton } from '@src/components/status-bar/GitPushButton';
import { GitPullButton } from '@src/components/status-bar/GitPullButton';

beforeEach(() => {
  notifyMock.success.mockReset();
  notifyMock.error.mockReset();
  notifyMock.dismiss.mockReset();
  runActionMock.mockReset();
});
afterEach(cleanup);

const conflict = { kind: 'conflict' as const, branch: 'main', message: 'Conflicted: a.md' };

describe('notifyGitOutcome', () => {
  for (const mode of ['vibe', 'standard', 'advanced', 'dev']) {
    for (const op of ['push', 'pull'] as const) {
      it(`${op} conflict in ${mode}: forced toast with Resolve aimed at the repo`, () => {
        viewMode.current = mode;
        notifyGitOutcome(op, conflict, '/repo');
        const toast = notifyMock.error.mock.calls[0][0];
        expect(toast.forceToast).toBe(true);
        expect(toast.actions).toEqual([
          { label: 'Resolve', command: 'git.resolve-conflict', args: { branch: 'main', origin: op, workdir: '/repo' } },
        ]);
      });
    }
  }

  it('a conflict toast has a stable id per repo, which closeGitConflict takes down', () => {
    notifyGitOutcome('pull', conflict, '/repo');
    notifyGitOutcome('push', conflict, '/repo');
    const [first, second] = notifyMock.error.mock.calls.map((c) => c[0].id);
    expect(first).toBe('git.conflict:/repo');
    expect(second).toBe(first); // replaces, never stacks
    closeGitConflict('/repo');
    expect(notifyMock.dismiss).toHaveBeenCalledWith('git.conflict:/repo');
  });

  it('a non-conflict failure is forced too, with no Resolve', () => {
    viewMode.current = 'standard';
    notifyGitOutcome('push', { kind: 'network', branch: 'main', message: 'x' }, '/repo');
    const toast = notifyMock.error.mock.calls[0][0];
    expect(toast.forceToast).toBe(true);
    expect(toast.actions).toBeUndefined();
    expect(toast.id).toBeUndefined(); // a status refresh must not close it
  });

  it('success is a brief success toast', () => {
    notifyGitOutcome('pull', { kind: 'pulled', branch: 'main', message: 'Pulled' }, '/repo');
    expect(notifyMock.success).toHaveBeenCalledOnce();
    expect(notifyMock.error).not.toHaveBeenCalled();
  });
});

describe('footer while the tree is stuck', () => {
  const withStatus = (stuck: boolean) => {
    status.current = {
      computeNodeId: 'node-1',
      workdir: '/w',
      count: 2,
      ahead: 1,
      behind: 1,
      hasRepo: true,
      branch: 'main',
      conflict: stuck ? { paths: ['a.md'], operation: 'rebase' } : null,
      refresh: vi.fn(),
    };
  };

  it('shows Resolve instead of Push/Pull, and Resolve finishes without pushing', () => {
    withStatus(true);
    render(
      <>
        <GitResolveButton />
        <GitPullButton />
        <GitPushButton />
      </>,
    );
    expect(screen.queryByTestId('git-push-button')).toBeNull();
    expect(screen.queryByTestId('git-pull-button')).toBeNull();
    fireEvent.click(screen.getByTestId('git-resolve-button'));
    expect(runActionMock).toHaveBeenCalledWith(
      { label: 'Resolve', command: 'git.resolve-conflict', args: { branch: 'main', origin: 'pull', workdir: '/w' } },
      'git-resolve-pill',
    );
  });

  it('a clean tree shows no Resolve', () => {
    withStatus(false);
    render(<GitResolveButton />);
    expect(screen.queryByTestId('git-resolve-button')).toBeNull();
  });
});
